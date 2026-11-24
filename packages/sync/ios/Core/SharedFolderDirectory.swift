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
  static let systemFolders: Set<String> = [
    "/", "/System", "/Library", "/Applications", "/Users", "/Volumes", "/bin", "/sbin", "/usr", "/etc", "/var", "/tmp", "/dev", "/opt", "/cores",
    "/private", "/private/etc", "/private/var", "/private/tmp", "/Network",
  ]

  public static let coordination = SyncCoordination(timeout: 20)
  nonisolated(unsafe) static var pausePoint: ((String) -> Void)?

  public struct Refused: LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
  }

  public let root: URL
  private let identity: [String: Int]?
  private let coordination: SyncCoordination?
  private let fileManager = FileManager.default

  public init(root: URL, identity: [String: Int]? = nil, coordination: SyncCoordination? = SharedFolderDirectory.coordination) {
    self.root = root.standardizedFileURL
    self.identity = identity
    self.coordination = coordination
  }

  final class ScanBudget {
    var entries = 0
    var bytes = 0
    var exceeded: Bool { entries > SharedFolderDirectory.maxEntries || bytes > SharedFolderDirectory.maxScanBytes }
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
    return systemFolders.contains(real) || (parts.count == 2 && parts[0] == "Users") || real == realPath(NSHomeDirectory())
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
    var number = 1
    while true {
      let candidate = number == 1 ? stem : "\(stem) \(number)"
      if mkdirat(parent.fd, candidate, 0o755) == 0 {
        guard let made = openDirectory(in: parent, candidate), let found = made.identity else { throw failure("The new folder “\(candidate)” couldn’t be opened.") }
        return ["path": made.url.path, "device": found["device"]!, "inode": found["inode"]!]
      }
      guard errno == EEXIST else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
      number += 1
    }
  }

  @discardableResult
  public static func discard(_ path: String, identity expected: [String: Int]) -> Bool {
    let fd = open((path as NSString).deletingLastPathComponent, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    let name = (path as NSString).lastPathComponent
    var info = stat()
    guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFDIR, identity(info) == expected else { return false }
    return unlinkat(fd, name, AT_REMOVEDIR) == 0
  }

  enum Opened {
    case folder(Folder)
    case missing
    case replaced
    case failed(Int32)
  }

  private func openRoot() -> Opened {
    let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | (identity == nil ? 0 : O_NOFOLLOW))
    guard fd >= 0 else {
      let code = errno
      var info = stat()
      if identity != nil, code == ELOOP || code == ENOTDIR, lstat(root.path, &info) == 0, info.st_mode & S_IFMT == S_IFLNK { return .replaced }
      return code == ENOENT || code == ENOTDIR ? .missing : .failed(code)
    }
    let folder = Folder(fd: fd, url: root)
    if let identity, folder.identity != identity { return .replaced }
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
      let conflict: String?
      do {
        conflict = try apply(op, in: folder)
      } catch is SyncCoordination.TimedOut {
        throw Self.failure("The folder “\(root.lastPathComponent)” didn’t answer in time.")
      }
      if let conflict {
        conflicts.append(conflict)
        break
      }
    }
    return ["conflicts": conflicts]
  }

  static func folderName(_ name: String) -> String {
    let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
      .trimmingCharacters(in: .whitespacesAndNewlines)
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
          if kind == .file, waitingFor(url) == nil, let text = readText(in: directory, name, limit: Self.maxManifestBytes) {
            budget.bytes += text.utf8.count
            if budget.exceeded { return Self.exceededLevel }
            manifest = text
          } else {
            manifestPending = true
          }
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
        } else if let text = readText(in: directory, name, limit: Self.maxLinkBytes) {
          budget.bytes += text.utf8.count
          if budget.exceeded { return Self.exceededLevel }
          entries.append(["kind": "link", "file": name, "text": text])
        } else {
          held(name, "unreadable")
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

  static func boundedRead(in directory: Int32, _ name: String, limit: Int) -> Data? {
    let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      let data = try? handle.read(upToCount: limit + 1), data.count <= limit
    else { return nil }
    return data
  }

  private func readText(in directory: Folder, _ name: String, limit: Int) -> String? {
    let url = directory.url.appendingPathComponent(name)
    guard let data = try? coordinate(reading: url, { _ in Self.boundedRead(in: directory.fd, name, limit: limit) }) ?? nil else { return nil }
    if data.starts(with: Array("bplist".utf8)) {
      guard let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
        let xml = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
      else { return nil }
      return String(data: xml, encoding: .utf8)
    }
    return String(data: data, encoding: .utf8)
  }

  private func linkURL(in directory: Folder, _ name: String) -> String? {
    guard let data = Self.boundedRead(in: directory.fd, name, limit: Self.maxLinkBytes),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    else { return nil }
    return (plist["URL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static let outside = "A folder change pointed outside the shared folder."

  private func parts(_ path: String) -> [String]? {
    let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !parts.isEmpty, !path.hasPrefix("/"), !parts.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
    return parts
  }

  private func parent(of parts: [String], in root: Folder) throws -> Folder? {
    var current = root
    for part in parts.dropLast() {
      guard let next = Self.openDirectory(in: current, part) else {
        let code = errno
        if code == ENOENT { return nil }
        if code == ELOOP || code == ENOTDIR { throw Self.failure(Self.outside) }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
      }
      current = next
    }
    guard Self.kind(in: current, parts.last!) != .symlink else { throw Self.failure(Self.outside) }
    return current
  }

  private func apply(_ op: [String: Any], in root: Folder) throws -> String? {
    guard let kind = op["op"] as? String, let path = op["path"] as? String, let parts = parts(path) else { throw Self.failure(Self.outside) }
    let name = parts.last!
    let folder = try parent(of: parts, in: root)
    switch kind {
    case "write":
      guard let text = op["text"] as? String, Self.isLink(name) || name == Self.manifestName else {
        throw Self.failure("Only links and the folder’s order are written.")
      }
      Self.pausePoint?("op:\(path)")
      guard let folder else { return path }
      return try write(Data(text.utf8), in: folder, name, create: op["create"] as? Bool ?? true, expect: op["expect"] as? String) ? nil : path
    case "move":
      guard let toPath = op["to"] as? String, let toParts = self.parts(toPath) else { throw Self.failure("A rename pointed outside the shared folder.") }
      let destination = try parent(of: toParts, in: root)
      let from = folder.map { Self.kind(in: $0, name) } ?? .missing
      guard from == .missing || from == .directory || (from == .file && Self.isLink(name)), Self.isLink(toParts.last!) || from != .file else {
        throw Self.failure("Only links and folders are renamed.")
      }
      Self.pausePoint?("op:\(path)")
      guard let folder, from != .missing else { return nil }
      guard let destination else { return toPath }
      return try move(in: folder, name, to: destination, toParts.last!) ? nil : toPath
    case "delete":
      guard Self.isLink(name), let expect = op["expect"] as? String else { throw Self.failure("Only links are deleted.") }
      Self.pausePoint?("op:\(path)")
      guard let folder else { return nil }
      return try delete(in: folder, name, expect: expect) ? nil : path
    case "mkdir":
      Self.pausePoint?("op:\(path)")
      guard let folder else { return path }
      switch Self.kind(in: folder, name) {
      case .directory: return nil
      case .missing:
        guard mkdirat(folder.fd, name, 0o755) == 0 || errno == EEXIST else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        return Self.kind(in: folder, name) == .directory ? nil : path
      default: return path
      }
    case "rmdir":
      Self.pausePoint?("op:\(path)")
      if let folder { try removeEmptyDirectory(in: folder, name) }
      return nil
    default:
      throw Self.failure("Unknown folder change “\(kind)”.")
    }
  }

  private func staged(_ data: Data, near directory: URL, named name: String) throws -> (URL, URL) {
    let staging = try fileManager.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: directory, create: true)
    let temporary = staging.appendingPathComponent(name)
    do {
      try data.write(to: temporary)
    } catch {
      try? fileManager.removeItem(at: staging)
      throw error
    }
    return (staging, temporary)
  }

  private func write(_ data: Data, in folder: Folder, _ name: String, create: Bool, expect: String?) throws -> Bool {
    let (staging, temporary) = try staged(data, near: folder.url, named: name)
    defer { try? fileManager.removeItem(at: staging) }
    var landed = false
    try coordinate(writing: folder.url.appendingPathComponent(name), options: .forReplacing) { _ in
      switch Self.kind(in: folder, name) {
      case .missing:
        guard create || expect == nil else { return }
        if renameatx_np(AT_FDCWD, temporary.path, folder.fd, name, UInt32(RENAME_EXCL)) == 0 {
          landed = true
        } else if errno != EEXIST {
          throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
      case .file:
        if create { return }
        if let expect, self.linkURL(in: folder, name) != expect { return }
        guard renameatx_np(AT_FDCWD, temporary.path, folder.fd, name, 0) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        landed = true
      default:
        return
      }
    }
    return landed
  }

  private func move(in source: Folder, _ name: String, to destination: Folder, _ target: String) throws -> Bool {
    guard Self.kind(in: destination, target) == .missing else { return false }
    var moved = false
    try SyncCoordination.move(coordination, source.url.appendingPathComponent(name), to: destination.url.appendingPathComponent(target)) { _, _ in
      guard Self.kind(in: destination, target) == .missing else { return }
      if renameatx_np(source.fd, name, destination.fd, target, UInt32(RENAME_EXCL)) == 0 {
        moved = true
      } else if errno != EEXIST {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    }
    return moved
  }

  private func delete(in folder: Folder, _ name: String, expect: String) throws -> Bool {
    let url = folder.url.appendingPathComponent(name)
    let kind = Self.kind(in: folder, name)
    if kind == .missing, Self.kind(in: folder, ".\(name)\(Self.placeholderSuffix)") == .file {
      try? fileManager.startDownloadingUbiquitousItem(at: url)
      return false
    }
    switch kind {
    case .file: break
    case .blocked: return false
    default: return true
    }
    try coordinate(writing: url, options: .forDeleting) { _ in
      guard self.linkURL(in: folder, name) == expect else { return }
      if unlinkat(folder.fd, name, 0) != 0, errno != ENOENT { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
    return true
  }

  private static let housekeeping: Set<String> = [manifestName, ".\(manifestName)\(placeholderSuffix)", ".DS_Store"]

  private func removeEmptyDirectory(in parent: Folder, _ name: String) throws {
    guard Self.kind(in: parent, name) == .directory else { return }
    guard let directory = Self.openDirectory(in: parent, name) else {
      let code = errno
      if code == ENOENT || code == ENOTDIR || code == ELOOP { return }
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
    guard let names = Self.names(in: directory, budget: nil, stopAfter: Self.housekeeping.count + 1) else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    guard names.allSatisfy(Self.housekeeping.contains) else { return }
    let order = Self.kind(in: directory, Self.manifestName) == .file ? Self.boundedRead(in: directory.fd, Self.manifestName, limit: Self.maxManifestBytes) : nil
    for item in Self.housekeeping where Self.kind(in: directory, item) == .file { unlinkat(directory.fd, item, 0) }
    guard unlinkat(parent.fd, name, AT_REMOVEDIR) != 0 else { return }
    let code = errno
    if let order { restoreExclusively(order, in: directory) }
    if code != ENOTEMPTY, code != ENOENT, code != EEXIST { throw NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }
  }

  private func restoreExclusively(_ data: Data, in directory: Folder) {
    guard let (staging, temporary) = try? staged(data, near: directory.url, named: Self.manifestName) else { return }
    defer { try? fileManager.removeItem(at: staging) }
    _ = renameatx_np(AT_FDCWD, temporary.path, directory.fd, Self.manifestName, UInt32(RENAME_EXCL))
  }

  private func coordinate(writing url: URL, options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> Void) throws {
    try SyncCoordination.write(coordination, url, options: options, body)
  }

  private func coordinate<T>(reading url: URL, _ body: (URL) throws -> T) throws -> T {
    try SyncCoordination.read(coordination, url, options: [.withoutChanges], body)
  }

  static func failure(_ message: String) -> NSError {
    NSError(domain: "ArdiaSharedFolders", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
