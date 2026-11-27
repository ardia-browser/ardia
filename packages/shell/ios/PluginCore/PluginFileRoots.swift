import Darwin
import Foundation

struct PluginFileIdentity: Equatable {
  let device: Int64
  let inode: Int64

  init(device: Int64, inode: Int64) {
    self.device = device
    self.inode = inode
  }

  init(_ info: stat) {
    self.init(device: Int64(info.st_dev), inode: Int64(info.st_ino))
  }

  init?(fd: Int32) {
    var info = stat()
    guard fstat(fd, &info) == 0 else { return nil }
    self.init(info)
  }

  init?(spec: Any?) {
    guard let given = spec as? [String: Any], let device = PluginFileStore.integer(given["device"]), let inode = PluginFileStore.integer(given["inode"]),
      device >= 0, inode >= 0
    else { return nil }
    self.init(device: Int64(device), inode: Int64(inode))
  }

  static func of(_ path: String) -> PluginFileIdentity? {
    var info = stat()
    guard stat(path, &info) == 0 else { return nil }
    return PluginFileIdentity(info)
  }

  var reply: [String: Any] { ["device": device, "inode": inode] }
}

final class PluginFileAccess {
  private let lock = NSLock()
  private var generation = 0
  private var revokedAt: [String: Int] = [:]

  private static func key(_ plugin: String, _ root: String?) -> String { root.map { "\(plugin)\u{0}\($0)" } ?? plugin }

  func ticket() -> Int { lock.withLock { generation } }

  func revoke(plugin: String, root: String?) {
    lock.withLock {
      generation += 1
      revokedAt[Self.key(plugin, root)] = generation
    }
  }

  func allows(_ ticket: Int?, plugin: String, root: String?) -> Bool {
    guard let ticket, ticket >= 0 else { return false }
    return lock.withLock {
      guard revokedAt[plugin, default: 0] <= ticket else { return false }
      guard let root else { return true }
      return revokedAt[Self.key(plugin, root), default: 0] <= ticket
    }
  }
}

extension PluginFileStore {
  static let dataVolumePrefix = "/System/Volumes/Data"
  static let systemFolders: Set<String> = [
    "/", "/System", "/System/Volumes", "/Library", "/Applications", "/Users", "/Volumes", "/bin", "/sbin", "/usr", "/etc", "/var", "/tmp", "/dev",
    "/opt", "/cores", "/private", "/private/etc", "/private/var", "/private/tmp", "/Network",
  ]

  static func isInICloud(_ path: String, home: String = NSHomeDirectory()) -> Bool {
    let base = (realPath(home) ?? home) + "/Library/Mobile Documents"
    let canonical = canonicalPath(path)
    return canonical == base || canonical.hasPrefix(base + "/")
  }

  static func realPath(_ path: String) -> String? {
    guard let real = realpath(path, nil) else { return nil }
    defer { free(real) }
    return String(cString: real)
  }

  static func canonicalPath(_ path: String) -> String {
    if path == dataVolumePrefix { return "/" }
    if path.hasPrefix(dataVolumePrefix + "/") { return String(path.dropFirst(dataVolumePrefix.count)) }
    return path
  }

  static func isPlainAbsolute(_ path: String) -> Bool {
    guard path.hasPrefix("/"), path != "/", !path.hasSuffix("/"), !path.utf8.contains(where: { $0 < 0x20 }) else { return false }
    return !path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().contains { $0.isEmpty || $0 == "." || $0 == ".." }
  }

  static func ancestors(_ path: String) -> [String] {
    var chain: [String] = []
    var current = path
    while true {
      chain.append(current)
      guard current != "/" else { return chain }
      let parent = (current as NSString).deletingLastPathComponent
      current = parent.isEmpty ? "/" : parent
    }
  }

  private struct Place {
    let path: String
    let identity: PluginFileIdentity?
    let chain: [PluginFileIdentity]

    init(_ given: String) {
      let real = PluginFileStore.realPath(given) ?? given
      path = PluginFileStore.canonicalPath(real)
      identity = PluginFileIdentity.of(real)
      chain = PluginFileStore.ancestors(real).compactMap(PluginFileIdentity.of)
    }

    func isWithin(_ other: Place) -> Bool {
      if let identity = other.identity, chain.contains(identity) { return true }
      return path == other.path || path.hasPrefix(other.path == "/" ? "/" : other.path + "/")
    }

    func isSame(_ other: Place) -> Bool {
      if let identity, let theirs = other.identity { return identity == theirs }
      return path == other.path
    }
  }

  static func isProtected(_ path: String, guarding protected: [String], home: String = NSHomeDirectory()) -> Bool {
    let root = Place(path)
    if systemFolders.contains(root.path) || root.path == dataVolumePrefix { return true }
    let homePlace = Place(home)
    if root.isSame(homePlace) || homePlace.isWithin(root) { return true }
    for guarded in protected where !guarded.isEmpty {
      let place = Place(guarded)
      if root.isWithin(place) || place.isWithin(root) { return true }
    }
    let library = Place((home as NSString).appendingPathComponent("Library"))
    guard root.isWithin(library) else { return false }
    let allowed = ["Library/Mobile Documents", "Library/CloudStorage"].map { Place((home as NSString).appendingPathComponent($0)) }
    return !allowed.contains { root.isWithin($0) }
  }

  static func isFolderName(_ name: String) -> Bool {
    guard (1...100).contains(name.count), name.utf8.count <= 240, !name.hasPrefix(".") else { return false }
    return !name.unicodeScalars.contains { $0 == "/" || $0 == ":" || $0.value < 0x20 || $0.value == 0x7f }
  }

  static func openChecked(_ path: String, identity: PluginFileIdentity, what: String) -> Result<(Directory, String), PluginFileFailure> {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
      var link = stat()
      if errno == ELOOP || (lstat(path, &link) == 0 && (link.st_mode & S_IFMT) == S_IFLNK) { return .failure(PluginFileFailure(.refused, "the \(what) folder is a link")) }
      return .failure(PluginFileFailure(.unavailable, "the \(what) folder is missing"))
    }
    let directory = Directory(fd)
    var info = stat()
    guard fstat(fd, &info) == 0, let real = directory.path else { return .failure(PluginFileFailure(.unavailable, "the \(what) folder couldn't be opened")) }
    guard identity == PluginFileIdentity(info) else { return .failure(PluginFileFailure(.unavailable, "the \(what) folder isn't the one that was checked")) }
    return .success((directory, real))
  }

  static func madeParent(_ parent: String, under grandparentIdentity: PluginFileIdentity, guarding protected: [String], home: String) -> Result<(Directory, String), PluginFileFailure> {
    let name = (parent as NSString).lastPathComponent
    guard isFolderName(name) else { return .failure(PluginFileFailure(.badPath, "the parent's name isn't a plain folder name")) }
    let grandparent: (Directory, String)
    switch openChecked((parent as NSString).deletingLastPathComponent, identity: grandparentIdentity, what: "enclosing") {
    case .failure(let failure): return .failure(failure)
    case .success(let opened): grandparent = opened
    }
    let target = (grandparent.1 as NSString).appendingPathComponent(name)
    guard !isProtected(target, guarding: protected, home: home) else { return .failure(PluginFileFailure(.refused, "that folder would sit in Ardia's own data or the system's")) }
    guard mkdirat(grandparent.0.fd, name, 0o755) == 0 else {
      if errno == EEXIST { return .failure(PluginFileFailure(.unavailable, "the folder changed: “\(name)” appeared while you were deciding")) }
      return .failure(PluginFileFailure(.unavailable, "“\(name)” couldn't be made (\(errnoText(errno)))"))
    }
    var made = stat()
    guard fstatat(grandparent.0.fd, name, &made, AT_SYMLINK_NOFOLLOW) == 0, (made.st_mode & S_IFMT) == S_IFDIR else {
      return .failure(PluginFileFailure(.unavailable, "the folder changed right after it was made"))
    }
    let fd = openat(grandparent.0.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return .failure(PluginFileFailure(.unavailable, "the folder changed right after it was made")) }
    let directory = Directory(fd)
    var opened = stat()
    guard fstat(fd, &opened) == 0, PluginFileIdentity(opened) == PluginFileIdentity(made), let real = directory.path else {
      return .failure(PluginFileFailure(.unavailable, "the folder changed right after it was made"))
    }
    return .success((directory, real))
  }

  static func createFolder(
    in parent: String, identity: PluginFileIdentity?, named name: String, grandparentIdentity: PluginFileIdentity? = nil, guarding protected: [String],
    home: String = NSHomeDirectory()
  ) -> [String: Any] {
    guard isFolderName(name) else { return PluginFileFailure(.badPath, "a folder name is 1 to 100 characters, with no / or : and no leading dot").reply }
    guard isPlainAbsolute(parent) else { return PluginFileFailure(.badPath, "the parent isn't a plain absolute path").reply }
    let opened: Result<(Directory, String), PluginFileFailure>
    switch (identity, grandparentIdentity) {
    case (.some(let identity), nil): opened = openChecked(parent, identity: identity, what: "parent")
    case (nil, .some(let grandparent)): opened = madeParent(parent, under: grandparent, guarding: protected, home: home)
    default: return PluginFileFailure(.refused, "a folder is made only in a parent, or under a grandparent, that was checked first").reply
    }
    let directory: Directory
    let real: String
    switch opened {
    case .failure(let failure): return failure.reply
    case .success(let found): (directory, real) = found
    }
    let fd = directory.fd
    var number = 1
    while number <= 1000 {
      let candidate = number == 1 ? name : "\(name) \(number)"
      guard !isProtected((real as NSString).appendingPathComponent(candidate), guarding: protected, home: home) else {
        return PluginFileFailure(.refused, "that folder would sit in Ardia's own data or the system's").reply
      }
      if mkdirat(fd, candidate, 0o755) == 0 {
        let made = openat(fd, candidate, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard made >= 0 else { return PluginFileFailure(.unavailable, "the new folder couldn't be opened").reply }
        let child = Directory(made)
        var created = stat()
        guard fstat(made, &created) == 0, let childReal = child.path else { return PluginFileFailure(.unavailable, "the new folder couldn't be checked").reply }
        var answer: [String: Any] = [
          "ok": true, "path": (parent as NSString).appendingPathComponent(candidate), "realPath": childReal,
          "location": isInICloud(childReal, home: home) ? "icloud" : "other",
        ]
        answer.merge(PluginFileIdentity(created).reply) { $1 }
        return answer
      }
      guard errno == EEXIST else { return PluginFileFailure(.unavailable, "the folder couldn't be made (\(errnoText(errno)))").reply }
      number += 1
    }
    return PluginFileFailure(.exists, "every name from “\(name)” to “\(name) 1000” is taken").reply
  }
}
