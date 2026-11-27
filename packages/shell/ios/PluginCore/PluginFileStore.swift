import Darwin
import Foundation

enum PluginFileCode: String {
  case notFound = "not_found"
  case exists
  case tooLarge = "too_large"
  case badPath = "bad_path"
  case refused
  case unavailable
  case quota
}

struct PluginFileFailure: Error, Equatable {
  let code: PluginFileCode
  let message: String

  init(_ code: PluginFileCode, _ message: String) {
    self.code = code
    self.message = message
  }

  var reply: [String: Any] { ["ok": false, "code": code.rawValue, "message": message] }
}

struct PluginFileEntry: Equatable {
  let path: String
  let kind: String
  let size: Int64
  let mtimeMs: Int64
  let placeholder: Bool

  var reply: [String: Any] { ["path": path, "kind": kind, "size": size, "mtimeMs": mtimeMs, "placeholder": placeholder] }
}

final class PluginFileQuota {
  static let usageScanLimit = 1_000_000
  let cap: Int64
  private let lock = NSLock()
  private var usage: [String: Int64] = [:]

  init(cap: Int64 = PluginFileStore.dataQuota) {
    self.cap = cap
  }

  func used(_ key: String, measure: () -> Int64) -> Int64 {
    if let known = lock.withLock({ usage[key] }) { return known }
    let measured = measure()
    return lock.withLock {
      if let known = usage[key] { return known }
      usage[key] = measured
      return measured
    }
  }

  func adjust(_ key: String, by delta: Int64) {
    lock.withLock {
      guard let known = usage[key] else { return }
      usage[key] = max(0, known + delta)
    }
  }

  func forget(_ key: String) {
    lock.withLock { usage[key] = nil }
  }
}

struct PluginFileStore {
  static let maxData = 4 << 20
  static let dataQuota: Int64 = 2 << 30
  static let maxEntries = 10_000
  static let maxDepth = 32
  static let maxPathBytes = 1024
  static let maxSegmentBytes = 255
  static let maxPlaceholderBytes = 64 << 10
  static let coordinationTimeout: TimeInterval = 20
  static let placeholderSuffix = ".icloud"
  static let temporaryMarker = ".ardia-"
  static let noFollowAny: Int32 = 0x2000_0000
  static let datalessFlag: UInt32 = 0x4000_0000

  let root: String
  let isData: Bool
  let coordinated: Bool
  let quota: PluginFileQuota?
  let identity: PluginFileIdentity?
  var gate: PluginCommitGate?

  nonisolated(unsafe) static var commitPoint: ((String) -> Void)?
  nonisolated(unsafe) static var mutationPoint: ((String) -> Void)?

  init(root: String, isData: Bool, coordinated: Bool = false, quota: PluginFileQuota? = nil, identity: PluginFileIdentity? = nil) {
    self.root = root
    self.isData = isData
    self.coordinated = coordinated
    self.quota = quota
    self.identity = identity
  }

  static func isPlaceholderName(_ name: String) -> Bool {
    name.hasPrefix(".") && name.hasSuffix(placeholderSuffix) && name.utf8.count > placeholderSuffix.utf8.count + 1
  }

  var directoryMode: mode_t { isData ? 0o700 : 0o755 }
  var fileMode: mode_t { isData ? 0o600 : 0o644 }

  static func isTemporary(_ name: String) -> Bool {
    guard name.hasPrefix("."), let marker = name.range(of: temporaryMarker, options: .backwards) else { return false }
    return UUID(uuidString: String(name[marker.upperBound...])) != nil
  }

  static func temporaryName(for name: String) -> String {
    let id = UUID().uuidString
    var stem = ""
    for character in name {
      guard stem.utf8.count + String(character).utf8.count + 1 + temporaryMarker.utf8.count + id.utf8.count <= maxSegmentBytes else { break }
      stem.append(character)
    }
    return ".\(stem)\(temporaryMarker)\(id)"
  }

  static func segments(_ path: String, allowRoot: Bool) -> Result<[String], PluginFileFailure> {
    let bytes = Array(path.utf8)
    if bytes.isEmpty { return allowRoot ? .success([]) : .failure(PluginFileFailure(.badPath, "the path is empty")) }
    guard bytes.count <= maxPathBytes else { return .failure(PluginFileFailure(.badPath, "the path is over \(maxPathBytes) bytes")) }
    guard bytes.first != UInt8(ascii: "/") else { return .failure(PluginFileFailure(.badPath, "the path has to be relative")) }
    var parts: [String] = []
    let pieces = bytes.split(separator: UInt8(ascii: "/"), omittingEmptySubsequences: false)
    guard pieces.count <= maxDepth else { return .failure(PluginFileFailure(.badPath, "the path is over \(maxDepth) folders deep")) }
    for piece in pieces {
      guard !piece.isEmpty else { return .failure(PluginFileFailure(.badPath, "the path has an empty part")) }
      guard piece.count <= maxSegmentBytes else { return .failure(PluginFileFailure(.badPath, "a part of the path is over \(maxSegmentBytes) bytes")) }
      guard !piece.contains(where: { $0 < 0x20 || $0 == 0x7f }) else { return .failure(PluginFileFailure(.badPath, "the path has a control character")) }
      let part = String(decoding: piece, as: UTF8.self)
      guard part != ".", part != ".." else { return .failure(PluginFileFailure(.badPath, "the path can't hold . or ..")) }
      guard !isTemporary(part) else { return .failure(PluginFileFailure(.badPath, "that name is kept for Ardia's own temporary files")) }
      guard !isPlaceholderName(part) else { return .failure(PluginFileFailure(.badPath, "that name is an iCloud placeholder; use the file's own name")) }
      parts.append(part)
    }
    return .success(parts)
  }

  static func mtimeMs(_ info: stat) -> Int64 {
    Int64(info.st_mtimespec.tv_sec) * 1000 + Int64(info.st_mtimespec.tv_nsec) / 1_000_000
  }

  static func errnoText(_ code: Int32) -> String { String(cString: strerror(code)) }

  final class Directory {
    let fd: Int32
    let parent: Directory?
    let name: String?
    init(_ fd: Int32, parent: Directory? = nil, name: String? = nil) {
      self.fd = fd
      self.parent = parent
      self.name = name
    }
    deinit { Darwin.close(fd) }
    var path: String? { PluginFiles.openedPath(fd) }
    var identity: PluginFileIdentity? {
      var info = stat()
      return fstat(fd, &info) == 0 ? PluginFileIdentity(info) : nil
    }
  }

  struct OpenedRoot {
    let directory: Directory
    let real: String
  }

  func openRoot() -> Result<OpenedRoot, PluginFileFailure> {
    if isData, mkdir(root, 0o700) != 0, errno != EEXIST {
      return .failure(PluginFileFailure(.unavailable, "the plugin's files folder couldn't be made (\(Self.errnoText(errno)))"))
    }
    let fd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | (isData ? O_NOFOLLOW : Self.noFollowAny))
    guard fd >= 0 else {
      let code = errno
      var info = stat()
      if lstat(root, &info) == 0, (info.st_mode & S_IFMT) == S_IFLNK { return .failure(PluginFileFailure(.refused, "the folder is a link")) }
      if code == ELOOP { return .failure(PluginFileFailure(.refused, "the folder's path goes through a link")) }
      if code == ENOENT { return .failure(PluginFileFailure(.unavailable, "the folder is missing")) }
      if code == ENOTDIR { return .failure(PluginFileFailure(.unavailable, "the folder isn't a folder any more")) }
      return .failure(PluginFileFailure(.unavailable, "the folder couldn't be opened (\(Self.errnoText(code)))"))
    }
    let directory = Directory(fd)
    var info = stat()
    guard fstat(fd, &info) == 0, let real = directory.path else { return .failure(PluginFileFailure(.unavailable, "the folder couldn't be opened")) }
    if isData, info.st_uid != geteuid() { return .failure(PluginFileFailure(.refused, "the plugin's files folder isn't Ardia's")) }
    if let identity, identity != PluginFileIdentity(info) { return .failure(PluginFileFailure(.unavailable, "the folder isn't the one you chose any more")) }
    return .success(OpenedRoot(directory: directory, real: real))
  }

  func confined(_ directory: Directory, in root: OpenedRoot) -> Bool {
    guard let path = directory.path else { return false }
    return path == root.real || path.hasPrefix(root.real.hasSuffix("/") ? root.real : root.real + "/")
  }

  func intact(_ directory: Directory, in root: OpenedRoot) -> Bool {
    guard confined(directory, in: root), root.directory.path == root.real else { return false }
    var node = directory
    while let parent = node.parent, let name = node.name {
      var entry = stat()
      guard fstatat(parent.fd, name, &entry, AT_SYMLINK_NOFOLLOW) == 0, (entry.st_mode & S_IFMT) == S_IFDIR,
        let held = node.identity, held == PluginFileIdentity(entry)
      else { return false }
      node = parent
    }
    guard let top = node.identity, let rootIdentity = root.directory.identity, top == rootIdentity else { return false }
    if let identity, identity != rootIdentity { return false }
    return true
  }

  static let movedOut = PluginFileFailure(.refused, "the folder moved out of the root")

  func committed(_ directory: Directory, in root: OpenedRoot, _ label: String) -> PluginFileFailure? {
    Self.commitPoint?(label)
    return intact(directory, in: root) ? nil : Self.movedOut
  }

  func mutating(_ label: String) { Self.mutationPoint?(label) }

  static let accessEnded = PluginFileFailure(.refused, "the plugin's access ended")

  func gated<T>(_ body: () -> Result<T, PluginFileFailure>) -> Result<T, PluginFileFailure> {
    guard let gate else { return body() }
    return gate.commit(body) ?? .failure(Self.accessEnded)
  }

  func entryIdentity(_ directory: Directory, _ name: String) -> PluginFileIdentity? {
    var info = stat()
    return fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 ? PluginFileIdentity(info) : nil
  }

  func confinedFile(_ fd: Int32, in root: OpenedRoot) -> Bool {
    guard let path = PluginFiles.openedPath(fd) else { return false }
    return path.hasPrefix(root.real.hasSuffix("/") ? root.real : root.real + "/")
  }

  static let hardLinkRefusal = PluginFileFailure(.refused, "the file has other hard links")

  func walk(_ root: OpenedRoot, _ parts: ArraySlice<String>, create: Bool) -> Result<Directory, PluginFileFailure> {
    let first = dup(root.directory.fd)
    guard first >= 0 else { return .failure(PluginFileFailure(.unavailable, "the folder couldn't be opened")) }
    var current = Directory(first)
    for part in parts {
      var next = openat(current.fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      var made = false
      if next < 0, errno == ENOENT, create {
        if let failure = committed(current, in: root, "mkdir:\(part)") { return .failure(failure) }
        let making: Result<Bool, PluginFileFailure> = gated {
          mutating("mkdir:\(part)")
          if mkdirat(current.fd, part, directoryMode) == 0 { return .success(true) }
          if errno == EEXIST { return .success(false) }
          return .failure(PluginFileFailure(.unavailable, "the folder “\(part)” couldn't be made (\(Self.errnoText(errno)))"))
        }
        switch making {
        case .failure(let failure): return .failure(failure)
        case .success(let fresh): made = fresh
        }
        next = openat(current.fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      }
      guard next >= 0 else {
        let code = errno
        var info = stat()
        let found = fstatat(current.fd, part, &info, AT_SYMLINK_NOFOLLOW) == 0
        if found, (info.st_mode & S_IFMT) == S_IFLNK { return .failure(PluginFileFailure(.refused, "the path goes through a link")) }
        if code == ENOENT { return .failure(PluginFileFailure(.notFound, "there's no folder “\(part)”")) }
        if code == ENOTDIR || (found && (info.st_mode & S_IFMT) != S_IFDIR) { return .failure(PluginFileFailure(.badPath, "“\(part)” isn't a folder")) }
        return .failure(PluginFileFailure(.unavailable, "the folder “\(part)” couldn't be opened (\(Self.errnoText(code)))"))
      }
      let child = Directory(next, parent: current, name: part)
      if made, !intact(child, in: root) {
        if let held = child.identity, entryIdentity(current, part) == held { unlinkat(current.fd, part, AT_REMOVEDIR) }
        return .failure(Self.movedOut)
      }
      current = child
    }
    guard intact(current, in: root) else { return .failure(PluginFileFailure(.refused, "the path left the folder")) }
    return .success(current)
  }

  func coordinate<T>(_ relative: String, deleting: Bool, _ body: () -> Result<T, PluginFileFailure>) -> Result<T, PluginFileFailure> {
    guard coordinated else { return body() }
    let url = URL(fileURLWithPath: root, isDirectory: true).appendingPathComponent(relative)
    return Self.coordinate(writing: url, options: deleting ? .forDeleting : .forReplacing, timeout: Self.coordinationTimeout, body)
  }

  private final class CoordinationAttempt {
    let lock = NSLock()
    var started = false
    var expired = false
  }

  static func coordinate<T>(
    writing url: URL, options: NSFileCoordinator.WritingOptions, timeout: TimeInterval, _ body: () -> Result<T, PluginFileFailure>
  ) -> Result<T, PluginFileFailure> {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    let attempt = CoordinationAttempt()
    let timer = DispatchWorkItem {
      let expire = attempt.lock.withLock { () -> Bool in
        guard !attempt.started else { return false }
        attempt.expired = true
        return true
      }
      if expire { coordinator.cancel() }
    }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: timer)
    var result: Result<T, PluginFileFailure> = .failure(PluginFileFailure(.unavailable, "iCloud Drive didn't answer in time"))
    var problem: NSError?
    coordinator.coordinate(writingItemAt: url, options: options, error: &problem) { coordinated in
      let begin = attempt.lock.withLock { () -> Bool in
        guard !attempt.expired else { return false }
        attempt.started = true
        return true
      }
      guard begin else { return }
      guard Self.sameItem(coordinated, url) else {
        result = .failure(PluginFileFailure(.unavailable, "iCloud Drive moved it while Ardia waited, so nothing was changed; try again"))
        return
      }
      result = body()
    }
    timer.cancel()
    let started = attempt.lock.withLock { attempt.started }
    if !started, let problem, !attempt.lock.withLock({ attempt.expired }) {
      return .failure(PluginFileFailure(.unavailable, "iCloud Drive refused the change (\(problem.localizedDescription))"))
    }
    return result
  }

  static func sameItem(_ coordinated: URL, _ expected: URL) -> Bool {
    let given = coordinated.standardizedFileURL.path
    let wanted = expected.standardizedFileURL.path
    if given == wanted { return true }
    let parent = { (path: String) in realPath((path as NSString).deletingLastPathComponent) }
    guard let givenParent = parent(given), let wantedParent = parent(wanted) else { return false }
    return givenParent == wantedParent && (given as NSString).lastPathComponent == (wanted as NSString).lastPathComponent
  }

  func requestDownload(_ relative: String) {
    try? FileManager.default.startDownloadingUbiquitousItem(at: URL(fileURLWithPath: root).appendingPathComponent(relative))
  }

  static func placeholderName(_ name: String) -> String { ".\(name)\(placeholderSuffix)" }

  static func hasPlaceholder(in directory: Directory, _ name: String) -> stat? {
    let placeholder = placeholderName(name)
    guard placeholder.utf8.count <= maxSegmentBytes else { return nil }
    var info = stat()
    guard fstatat(directory.fd, placeholder, &info, AT_SYMLINK_NOFOLLOW) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
    return info
  }

  static func placeholderSize(in directory: Directory, _ placeholder: String) -> Int64 {
    let fd = openat(directory.fd, placeholder, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return 0 }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= off_t(maxPlaceholderBytes),
      let data = PluginFiles.readAll(fd, limit: maxPlaceholderBytes),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    else { return 0 }
    return (plist["NSURLFileSizeKey"] as? NSNumber)?.int64Value ?? 0
  }

  func isDataless(_ info: stat, _ relative: String) -> Bool {
    if info.st_flags & Self.datalessFlag != 0 { return true }
    guard coordinated else { return false }
    let values = try? URL(fileURLWithPath: root).appendingPathComponent(relative).resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
    guard values?.isUbiquitousItem == true, let status = values?.ubiquitousItemDownloadingStatus else { return false }
    return status != .current
  }

  func usage(_ opened: OpenedRoot) -> Int64 {
    guard isData, let quota else { return 0 }
    return quota.used(root) { Self.measure(opened.directory.fd) }
  }

  static func measure(_ fd: Int32) -> Int64 {
    var total: Int64 = 0
    var seen = 0
    func visit(_ directory: Int32, depth: Int) {
      guard depth <= maxDepth + 1, let names = names(in: directory) else { return }
      for name in names {
        seen += 1
        if seen > PluginFileQuota.usageScanLimit { return }
        var info = stat()
        guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
        switch info.st_mode & S_IFMT {
        case S_IFREG: total += Int64(info.st_size)
        case S_IFDIR:
          let child = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
          guard child >= 0 else { continue }
          visit(child, depth: depth + 1)
          Darwin.close(child)
        default: continue
        }
      }
    }
    visit(fd, depth: 0)
    return total
  }

  static func names(in fd: Int32) -> [String]? {
    let copy = dup(fd)
    guard copy >= 0 else { return nil }
    guard let stream = fdopendir(copy) else {
      Darwin.close(copy)
      return nil
    }
    defer { closedir(stream) }
    var names: [String] = []
    while true {
      errno = 0
      guard let entry = readdir(stream) else { return errno == 0 ? names : nil }
      let name = withUnsafePointer(to: &entry.pointee.d_name) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
      if name == "." || name == ".." { continue }
      names.append(name)
    }
  }

  func read(_ path: String, offset: Int?, length: Int?, expecting: PluginFileIdentity? = nil) -> Result<[String: Any], PluginFileFailure> {
    let parts: [String]
    switch Self.segments(path, allowRoot: false) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): parts = found
    }
    if let offset, offset < 0 { return .failure(PluginFileFailure(.badPath, "the offset can't be negative")) }
    if let length, length < 0 { return .failure(PluginFileFailure(.badPath, "the length can't be negative")) }
    let opened: OpenedRoot
    switch openRoot() {
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    let directory: Directory
    switch walk(opened, parts.dropLast(), create: false) {
    case .failure(let failure) where failure.code == .notFound: return .success(["found": false])
    case .failure(let failure): return .failure(failure)
    case .success(let found): directory = found
    }
    let name = parts.last!
    let fd = openat(directory.fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else {
      let code = errno
      if code == ELOOP { return .failure(PluginFileFailure(.refused, "the file is a link")) }
      if code == ENOENT {
        guard Self.hasPlaceholder(in: directory, name) != nil else { return .success(["found": false]) }
        requestDownload(path)
        return .failure(PluginFileFailure(.unavailable, "the file isn't downloaded yet"))
      }
      return .failure(PluginFileFailure(.unavailable, "the file couldn't be opened (\(Self.errnoText(code)))"))
    }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { return .failure(PluginFileFailure(.unavailable, "the file couldn't be read")) }
    if (info.st_mode & S_IFMT) == S_IFDIR { return .failure(PluginFileFailure(.badPath, "that's a folder, not a file")) }
    guard (info.st_mode & S_IFMT) == S_IFREG else { return .failure(PluginFileFailure(.refused, "that isn't a plain file")) }
    guard info.st_nlink <= 1 else { return .failure(Self.hardLinkRefusal) }
    if let expecting, expecting != PluginFileIdentity(info) { return .failure(PluginFileFailure(.refused, "the file you picked was replaced by another one")) }
    if isDataless(info, path) {
      requestDownload(path)
      return .failure(PluginFileFailure(.unavailable, "the file isn't downloaded yet"))
    }
    if let failure = committed(directory, in: opened, "read") { return .failure(failure) }
    guard confinedFile(fd, in: opened) else { return .failure(PluginFileFailure(.refused, "the file moved out of the root")) }
    let size = Int64(info.st_size)
    if offset == nil, length == nil, size > Int64(Self.maxData) {
      return .failure(PluginFileFailure(.tooLarge, "the file is over 4 MiB; read it in parts with offset and length"))
    }
    let start = Int64(offset ?? 0)
    let wanted = Int64(min(length ?? Self.maxData, Self.maxData))
    let count = Int(max(0, min(wanted, size - start)))
    var data = Data(count: count)
    var got = 0
    while got < count {
      let step = data.withUnsafeMutableBytes { pread(fd, $0.baseAddress! + got, count - got, off_t(start) + off_t(got)) }
      if step < 0 && errno == EINTR { continue }
      if step < 0 { return .failure(PluginFileFailure(.unavailable, "the file couldn't be read (\(Self.errnoText(errno)))")) }
      if step == 0 { break }
      got += step
    }
    data.count = got
    return .success(["found": true, "data": data.base64EncodedString(), "size": size, "mtimeMs": Self.mtimeMs(info)].merging(PluginFileIdentity(info).reply) { $1 })
  }

  func perform(_ spec: [String: Any]) -> [String: Any] {
    let path = spec["path"] as? String ?? ""
    let outcome: Result<[String: Any], PluginFileFailure>
    switch spec["op"] as? String {
    case "read":
      outcome = read(path, offset: Self.integer(spec["offset"]), length: Self.integer(spec["length"]), expecting: PluginFileIdentity(spec: spec["fileIdentity"]))
    case "write", "append":
      guard let text = spec["data"] as? String, let data = Data(base64Encoded: text) else {
        return PluginFileFailure(.refused, "the data has to be base64").reply
      }
      outcome = spec["op"] as? String == "write" ? write(path, data: data, exclusive: spec["exclusive"] as? Bool ?? false) : append(path, data: data)
    case "list":
      outcome = list(path, recursive: spec["recursive"] as? Bool ?? false)
    case "remove":
      outcome = remove(path)
    case "stat":
      outcome = inspect(path)
    case "stage":
      guard let stage = spec["stage"] as? String, let text = spec["data"] as? String, let data = Data(base64Encoded: text) else { return PluginFileFailure(.refused, "a staged part needs a stage and base64 data").reply }
      outcome = stageAppend(path, stage: stage, data: data, first: spec["first"] as? Bool ?? false, expecting: PluginFileIdentity(spec: spec["stageIdentity"]))
    case "publish", "discard":
      guard let stage = spec["stage"] as? String else { return PluginFileFailure(.refused, "that needs a stage").reply }
      let expecting = PluginFileIdentity(spec: spec["stageIdentity"])
      outcome = spec["op"] as? String == "publish" ? publishStage(path, stage: stage, expecting: expecting) : discardStage(path, stage: stage, expecting: expecting)
    default:
      return PluginFileFailure(.refused, "that isn't a files call Ardia knows").reply
    }
    switch outcome {
    case .success(var values):
      values["ok"] = true
      return values
    case .failure(let failure):
      return failure.reply
    }
  }

  static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded() == double, abs(double) <= 9_007_199_254_740_991 else { return -1 }
    return number.intValue
  }
}
