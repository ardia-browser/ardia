import Foundation

public struct SharedFolderDirectory {
  public static let manifestName = ".ardia-folder.json"
  public static let linkExtension = "webloc"
  static let maxDepth = 8
  static let maxLinkBytes = 64 * 1024
  static let maxManifestBytes = 1024 * 1024
  static let placeholderSuffix = ".icloud"
  static let maxEntries = 20_000
  static let maxScanBytes = 32 * 1024 * 1024
  static let maxNameAttempts = 1000
  nonisolated(unsafe) static var scanSeconds: TimeInterval = 30
  static let systemFolders: Set<String> = [
    "/", "/System", "/Library", "/Applications", "/Users", "/Volumes", "/bin", "/sbin", "/usr", "/etc", "/var", "/tmp", "/dev", "/opt", "/cores",
    "/private", "/private/etc", "/private/var", "/private/tmp", "/Network", "/System/Volumes/Data",
  ]

  public static let coordination = SyncCoordination(timeout: 20)
  nonisolated(unsafe) static var pausePoint: ((String) -> Void)?

  public struct Refused: LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
  }

  public let root: URL
  private let identity: [String: Int]
  let coordination: SyncCoordination?
  let fileManager = FileManager.default
  let isCancelled: () -> Bool

  public init(root: URL, identity: [String: Int], coordination: SyncCoordination? = SharedFolderDirectory.coordination, cancelled: @escaping () -> Bool = { false }) {
    self.root = root.standardizedFileURL
    self.identity = identity
    self.coordination = coordination
    self.isCancelled = cancelled
  }

  final class ScanBudget {
    var entries = 0
    var bytes = 0
    var coordinationTimedOut = false
    let deadline: Date
    init(seconds: TimeInterval = SharedFolderDirectory.scanSeconds) { deadline = Date().addingTimeInterval(seconds) }
    var overTime: Bool { Date() > deadline }
    var tooBig: Bool { entries > SharedFolderDirectory.maxEntries || bytes > SharedFolderDirectory.maxScanBytes }
    var exceeded: Bool { tooBig || coordinationTimedOut || overTime }
  }

  final class Folder {
    let fd: Int32
    let url: URL
    init(fd: Int32, url: URL) {
      self.fd = fd
      self.url = url
    }
    deinit { close(fd) }
    var identity: [String: Int]? {
      var info = stat()
      return fstat(fd, &info) == 0 ? SharedFolderDirectory.identity(info) : nil
    }
    var pathStillNamesIt: Bool {
      guard let held = identity else { return false }
      return SharedFolderDirectory.identity(of: url.path) == held
    }
  }

  static func identity(_ info: stat) -> [String: Int] {
    ["device": Int(info.st_dev), "inode": Int(info.st_ino)]
  }

  public static func identity(of path: String) -> [String: Int]? {
    var info = stat()
    guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { return nil }
    return identity(info)
  }

  static func refusedFolder(_ real: String) -> Bool {
    let parts = real.split(separator: "/")
    if systemFolders.contains(real) || (parts.count == 2 && parts[0] == "Users") || real == realPath(NSHomeDirectory()) { return true }
    guard let found = identity(of: real) else { return false }
    let refused = (Array(systemFolders) + [NSHomeDirectory()]).compactMap { identity(of: $0) }
    if refused.contains(found) { return true }
    let users = identity(of: "/Users")
    return users != nil && identity(of: (real as NSString).deletingLastPathComponent) == users
  }

  public static func resolve(_ path: String) throws -> [String: Any] {
    let name = (path as NSString).lastPathComponent
    guard let real = realPath(path) else {
      let code = errno
      throw failure(code == ENOENT ? "There’s no folder at \(path)." : "Can’t open “\(name)”: \(String(cString: strerror(code)))")
    }
    guard !refusedFolder(real) else { throw Refused(message: "\(real) is a system or home folder; pick a folder inside it.") }
    guard let found = identity(of: real) else { throw failure("“\(name)” isn’t a folder Ardia can sync.") }
    guard access(real, R_OK | X_OK) == 0 else { throw failure("Can’t read “\(name)”: \(String(cString: strerror(errno)))") }
    return ["path": real, "device": found["device"]!, "inode": found["inode"]!]
  }

  public static func create(inParent parentPath: String, parentIdentity: [String: Int]?, named name: String) throws -> [String: Any] {
    if parentIdentity == nil { try FileManager.default.createDirectory(atPath: parentPath, withIntermediateDirectories: true) }
    let fd = open(parentPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC | (parentIdentity == nil ? 0 : O_NOFOLLOW))
    guard fd >= 0 else { throw failure("Can’t open “\((parentPath as NSString).lastPathComponent)”: \(String(cString: strerror(errno)))") }
    let base = realPath(parentPath) ?? parentPath
    let parent = Folder(fd: fd, url: URL(fileURLWithPath: base, isDirectory: true))
    if let parentIdentity, parent.identity != parentIdentity {
      throw failure("“\((parentPath as NSString).lastPathComponent)” isn’t the folder that was checked any more; nothing was made.")
    }
    let stem = folderName(name)
    for number in 1...maxNameAttempts {
      let candidate = number == 1 ? stem : "\(stem) \(number)"
      guard mkdirat(parent.fd, candidate, 0o755) == 0 else {
        guard errno == EEXIST else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        continue
      }
      let made = info(in: parent.fd, candidate)
      pausePoint?("create:\(candidate)")
      guard made.1 == 0, made.0.st_mode & S_IFMT == S_IFDIR, let opened = openDirectory(in: parent, candidate), let found = opened.identity, found == identity(made.0) else {
        throw failure("The new folder “\(candidate)” was replaced before Ardia could use it; nothing was shared.")
      }
      return ["path": opened.url.path, "device": found["device"]!, "inode": found["inode"]!]
    }
    throw failure("“\(stem)” and \(maxNameAttempts - 1) numbered copies already exist; pick another name.")
  }

  @discardableResult
  public static func discard(_ path: String, identity expected: [String: Int]) -> Bool {
    let fd = open((path as NSString).deletingLastPathComponent, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    return removeExactly(in: fd, (path as NSString).lastPathComponent, identity: expected) == 0
  }

  static let replacedCode: Int32 = -1

  static func removeExactly(in parent: Int32, _ name: String, identity expected: [String: Int]?) -> Int32 {
    let aside = ".ardia-removing-\(UUID().uuidString)"
    guard renameatx_np(parent, name, parent, aside, UInt32(RENAME_EXCL)) == 0 else { return errno }
    let found = info(in: parent, aside)
    guard found.1 == 0, found.0.st_mode & S_IFMT == S_IFDIR, identity(found.0) == expected else {
      _ = renameatx_np(parent, aside, parent, name, UInt32(RENAME_EXCL))
      return replacedCode
    }
    if unlinkat(parent, aside, AT_REMOVEDIR) == 0 { return 0 }
    let code = errno
    _ = renameatx_np(parent, aside, parent, name, UInt32(RENAME_EXCL))
    return code
  }

  enum Opened {
    case folder(Folder)
    case missing
    case replaced
    case failed(Int32)
  }

  private func openRoot() -> Opened {
    let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard fd >= 0 else {
      let code = errno
      var info = stat()
      if code == ELOOP || code == ENOTDIR, lstat(root.path, &info) == 0, info.st_mode & S_IFMT == S_IFLNK { return .replaced }
      return code == ENOENT || code == ENOTDIR ? .missing : .failed(code)
    }
    let folder = Folder(fd: fd, url: root)
    if folder.identity != identity { return .replaced }
    Self.pausePoint?("root")
    return .folder(folder)
  }

  private var replacedMessage: String { "“\(root.lastPathComponent)” isn’t the folder Ardia added any more." }

  public func read() -> [String: Any] {
    let folder: Folder
    switch openRoot() {
    case .missing: return ["exists": false]
    case .replaced: return ["exists": false, "error": replacedMessage]
    case .failed(let code): return ["exists": false, "error": "Can’t open “\(root.lastPathComponent)”: \(String(cString: strerror(code)))"]
    case .folder(let opened): folder = opened
    }
    let budget = ScanBudget()
    let top = level(folder, depth: 0, budget: budget)
    if budget.coordinationTimedOut { return ["exists": false, "error": "A file in “\(root.lastPathComponent)” didn’t answer in time; Ardia will try again."] }
    if budget.overTime { return ["exists": false, "error": "“\(root.lastPathComponent)” took longer than \(Int(Self.scanSeconds)) seconds to read; Ardia will try again."] }
    if budget.exceeded {
      return ["exists": false, "error": "“\(root.lastPathComponent)” holds more than \(Self.maxEntries) items or \(Self.maxScanBytes / 1024 / 1024) MB of links; Ardia syncs smaller folders."]
    }
    return ["exists": true, "root": top]
  }

  public func apply(json: String) throws -> [String: Any] {
    guard let data = json.data(using: .utf8), let ops = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      throw Self.failure("The folder changes couldn’t be read.")
    }
    let folder: Folder
    switch openRoot() {
    case .missing: throw Self.failure("The folder “\(root.lastPathComponent)” is missing.")
    case .replaced: throw Self.failure(replacedMessage)
    case .failed(let code): throw Self.failure("Can’t open “\(root.lastPathComponent)”: \(String(cString: strerror(code)))")
    case .folder(let opened): folder = opened
    }
    var conflicts: [String] = []
    for op in ops {
      if isCancelled() { return ["conflicts": conflicts, "cancelled": true] }
      let conflict: String?
      do {
        conflict = try applyChange(op, in: folder)
      } catch is SyncCoordination.TimedOut {
        throw Self.failure("The folder “\(root.lastPathComponent)” didn’t answer in time.")
      } catch is Cancelled {
        return ["conflicts": conflicts, "cancelled": true]
      }
      if let conflict {
        conflicts.append(conflict)
        break
      }
    }
    return ["conflicts": conflicts]
  }

  static func folderName(_ name: String) -> String {
    let cleaned = String(String.UnicodeScalarView(name.unicodeScalars.map { scalar in
      scalar == "/" || scalar == ":" || CharacterSet.controlCharacters.contains(scalar) ? "-" : scalar
    })).trimmingCharacters(in: .whitespacesAndNewlines)
    let visible = String(cleaned.drop(while: { $0 == "." }))
    var capped = ""
    for character in visible {
      guard capped.utf8.count + String(character).utf8.count <= 200 else { break }
      capped.append(character)
    }
    return capped.isEmpty ? "Shared Folder" : capped
  }

  enum Kind { case file, directory, symlink, other, missing, blocked }

  static func kind(in folder: Folder, _ name: String) -> Kind { kind(info(in: folder.fd, name)) }

  static func kind(_ found: (stat, Int32)) -> Kind {
    guard found.1 == 0 else { return found.1 == ENOENT ? .missing : .blocked }
    switch found.0.st_mode & S_IFMT {
    case S_IFREG: return .file
    case S_IFDIR: return .directory
    case S_IFLNK: return .symlink
    default: return .other
    }
  }

  static func info(in fd: Int32, _ name: String) -> (stat, Int32) {
    var info = stat()
    return fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 ? (info, 0) : (info, errno)
  }

  static func openDirectory(in parent: Folder, _ name: String) -> Folder? {
    let fd = openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    return fd >= 0 ? Folder(fd: fd, url: parent.url.appendingPathComponent(name, isDirectory: true)) : nil
  }

  static func realPath(_ path: String) -> String? {
    guard let real = realpath(path, nil) else { return nil }
    defer { free(real) }
    return String(cString: real)
  }

  static func isLink(_ name: String) -> Bool {
    (name as NSString).pathExtension.lowercased() == linkExtension
  }

  static func names(in folder: Folder, budget: ScanBudget?, stopAfter: Int = .max) -> [String]? {
    let copy = dup(folder.fd)
    guard copy >= 0, let stream = fdopendir(copy) else {
      if copy >= 0 { close(copy) }
      return nil
    }
    defer { closedir(stream) }
    var names: [String] = []
    while names.count < stopAfter {
      errno = 0
      guard let entry = readdir(stream) else { return errno == 0 ? names : nil }
      let name = withUnsafePointer(to: &entry.pointee.d_name) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
      if name == "." || name == ".." { continue }
      names.append(name)
      if let budget {
        budget.entries += 1
        if budget.exceeded { return names }
      }
    }
    return names
  }

  private static let exceededLevel: [String: Any] = ["entries": [], "manifest": NSNull(), "manifestPending": true]

  private func level(_ directory: Folder, depth: Int, budget: ScanBudget) -> [String: Any] {
    Self.pausePoint?("scan:\(directory.url.lastPathComponent)")
    guard directory.pathStillNamesIt else {
      return ["entries": [], "manifest": NSNull(), "manifestPending": true, "error": "“\(directory.url.lastPathComponent)” moved while Ardia read it."]
    }
    guard let names = Self.names(in: directory, budget: budget) else {
      return ["entries": [], "manifest": NSNull(), "manifestPending": true, "error": "Can’t read “\(directory.url.lastPathComponent)”: \(String(cString: strerror(errno)))"]
    }
    if budget.exceeded { return Self.exceededLevel }
    let present = Set(names)
    var entries: [[String: Any]] = []
    var manifest: Any = NSNull()
    var manifestPending = false
    let held = { (name: String, reason: String) in entries.append(["kind": "pending", "file": name, "reason": reason]) }
    for name in names.sorted() {
      let url = directory.url.appendingPathComponent(name)
      let found = Self.info(in: directory.fd, name)
      let kind = Self.kind(found)
      if name.hasPrefix(".") {
        if name == Self.manifestName {
          let text = kind == .file && waitingFor(url) == nil ? readText(in: directory, name, limit: Self.maxManifestBytes, budget: budget) : nil
          if budget.exceeded { return Self.exceededLevel }
          if let text { manifest = text } else { manifestPending = true }
          continue
        }
        guard name.hasSuffix(Self.placeholderSuffix), kind == .file else { continue }
        let real = String(name.dropFirst().dropLast(Self.placeholderSuffix.count))
        try? fileManager.startDownloadingUbiquitousItem(at: directory.url.appendingPathComponent(real))
        if real == Self.manifestName {
          manifestPending = true
        } else if Self.isLink(real), !present.contains(real) {
          held(real, "download")
        }
        continue
      }
      switch kind {
      case .directory:
        let package = (try? url.resourceValues(forKeys: [.isPackageKey]))?.isPackage == true
        if package || depth >= Self.maxDepth {
          held(name, "unreadable")
          continue
        }
        guard let child = Self.openDirectory(in: directory, name) else {
          let code = errno
          if code == ENOENT { continue }
          if code == ELOOP || code == ENOTDIR {
            held(name, "unreadable")
            continue
          }
          return ["entries": [], "manifest": NSNull(), "manifestPending": true, "error": "Can’t read “\(name)”: \(String(cString: strerror(code)))"]
        }
        let inner = level(child, depth: depth + 1, budget: budget)
        if budget.exceeded { return Self.exceededLevel }
        if let error = inner["error"] { return ["entries": [], "manifest": NSNull(), "manifestPending": true, "error": error] }
        entries.append(["kind": "dir", "file": name, "level": inner])
      case .file where Self.isLink(name):
        if Int(found.0.st_size) > Self.maxLinkBytes {
          held(name, "unreadable")
        } else if let reason = waitingFor(url) {
          held(name, reason)
        } else {
          let text = readText(in: directory, name, limit: Self.maxLinkBytes, budget: budget)
          if budget.exceeded { return Self.exceededLevel }
          if let text { entries.append(["kind": "link", "file": name, "text": text]) } else { held(name, "unreadable") }
        }
      case .missing:
        continue
      case .blocked:
        return ["entries": [], "manifest": NSNull(), "manifestPending": true, "error": "Can’t read “\(name)” in “\(directory.url.lastPathComponent)”."]
      default:
        held(name, "unreadable")
      }
    }
    return ["entries": entries, "manifest": manifest, "manifestPending": manifestPending]
  }

  private func waitingFor(_ url: URL) -> String? {
    let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
    guard values?.isUbiquitousItem == true, let status = values?.ubiquitousItemDownloadingStatus, status != .current else { return nil }
    try? fileManager.startDownloadingUbiquitousItem(at: url)
    return "download"
  }

  static func boundedRead(_ path: String, limit: Int) -> Data? {
    boundedRead(in: AT_FDCWD, path, limit: limit)
  }

  static func boundedRead(in directory: Int32, _ name: String, limit: Int, budget: ScanBudget? = nil) -> Data? {
    let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, let data = try? handle.read(upToCount: limit + 1) else { return nil }
    budget?.bytes += data.count
    return data.count <= limit ? data : nil
  }

  private func readText(in directory: Folder, _ name: String, limit: Int, budget: ScanBudget) -> String? {
    let url = directory.url.appendingPathComponent(name)
    let read = { (_: URL) in directory.pathStillNamesIt ? Self.boundedRead(in: directory.fd, name, limit: limit, budget: budget) : nil }
    let data: Data
    do {
      guard let found = try coordinate(reading: url, read) else { return nil }
      data = found
    } catch is SyncCoordination.TimedOut {
      budget.coordinationTimedOut = true
      return nil
    } catch {
      return nil
    }
    if data.starts(with: Array("bplist".utf8)) {
      guard let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
        let xml = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
      else { return nil }
      budget.bytes += xml.count
      guard xml.count <= limit else { return nil }
      return String(data: xml, encoding: .utf8)
    }
    return String(data: data, encoding: .utf8)
  }

  func linkURL(in directory: Folder, _ name: String) -> String? {
    guard let data = Self.boundedRead(in: directory.fd, name, limit: Self.maxLinkBytes),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    else { return nil }
    return (plist["URL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func coordinate(writing url: URL, options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> Void) throws {
    try SyncCoordination.write(coordination, url, options: options) { url in
      try checkCancelled()
      try body(url)
    }
  }

  func coordinate<T>(reading url: URL, _ body: (URL) throws -> T) throws -> T {
    try SyncCoordination.read(coordination, url, options: [.withoutChanges], body)
  }

  static func failure(_ message: String) -> NSError {
    NSError(domain: "ArdiaSharedFolders", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
