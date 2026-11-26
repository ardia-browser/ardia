import Darwin
import Foundation

final class BinFolder {
  static let maxHops = 32

  let fd: Int32
  let path: String

  private init(fd: Int32, path: String) {
    self.fd = fd
    self.path = path
  }

  deinit { close(fd) }

  static func open(_ given: String, creating: Bool) -> Result<BinFolder, LinkRefusal> {
    switch resolve(Array(given.utf8), creating: creating) {
    case .failure(let cause):
      let reason = cause == .binShared ? "\(given) is inside a folder other users can change" : "\(given) isn't a folder you own"
      return .failure(LinkRefusal(reason: reason, cause: cause))
    case .success(let (fd, path)):
      return .success(BinFolder(fd: fd, path: path))
    }
  }

  private static let slash: UInt8 = 0x2F
  private static let dot: [UInt8] = [0x2E]
  private static let dotDot: [UInt8] = [0x2E, 0x2E]

  static func components(_ bytes: [UInt8]) -> [[UInt8]]? {
    let parts = bytes.split(separator: slash, omittingEmptySubsequences: true).map(Array.init)
    return parts.contains { $0.contains(slash) || $0.contains(0) } ? nil : parts
  }

  private static func withName<T>(_ name: [UInt8], _ body: (UnsafePointer<CChar>) -> T) -> T {
    (name.map { CChar(bitPattern: $0) } + [0]).withUnsafeBufferPointer { body($0.baseAddress!) }
  }

  private static func trustedOwner(_ info: stat) -> Bool {
    info.st_uid == geteuid() || info.st_uid == 0
  }

  private static func trustedAncestor(_ fd: Int32) -> Bool {
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, trustedOwner(info) else { return false }
    if info.st_mode & 0o022 != 0 && info.st_mode & S_ISVTX == 0 { return false }
    return !PluginPrograms.aclGrantsChanges(fd: fd)
  }

  private static func privateDestination(_ fd: Int32) -> LinkRefusal.Cause? {
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == geteuid() else { return .binFolder }
    if info.st_mode & 0o022 != 0 || PluginPrograms.aclGrantsChanges(fd: fd) { return .binShared }
    return nil
  }

  private static func resolve(_ given: [UInt8], creating: Bool) -> Result<(Int32, String), LinkRefusal.Cause> {
    guard given.first == slash, let start = components(given) else { return .failure(.binFolder) }
    let root = Darwin.open("/", O_SEARCH | O_DIRECTORY | O_CLOEXEC)
    guard root >= 0 else { return .failure(.binFolder) }
    var trail: [(fd: Int32, name: [UInt8])] = [(root, [])]
    func fail(_ cause: LinkRefusal.Cause) -> Result<(Int32, String), LinkRefusal.Cause> {
      for entry in trail { close(entry.fd) }
      return .failure(cause)
    }
    guard trustedAncestor(root) else { return fail(.binShared) }
    var pending = start.reversed().map { (name: $0, given: true) }
    var hops = 0
    while let (part, given) = pending.popLast() {
      if part == dot { continue }
      if part == dotDot {
        if trail.count > 1 { close(trail.removeLast().fd) }
        continue
      }
      let here = trail[trail.count - 1].fd
      var info = stat()
      var found = withName(part) { fstatat(here, $0, &info, AT_SYMLINK_NOFOLLOW) } == 0
      if !found && errno == ENOENT && creating && given {
        let made = withName(part) { mkdirat(here, $0, 0o755) } == 0 || errno == EEXIST
        found = made && withName(part) { fstatat(here, $0, &info, AT_SYMLINK_NOFOLLOW) } == 0
      }
      guard found else { return fail(.binFolder) }
      switch info.st_mode & S_IFMT {
      case S_IFLNK:
        hops += 1
        guard hops <= maxHops else { return fail(.binFolder) }
        guard trustedOwner(info), let target = readLinkBytes(here, part), !target.isEmpty, let parts = components(target) else { return fail(.binShared) }
        if target.first == slash {
          while trail.count > 1 { close(trail.removeLast().fd) }
        }
        pending.append(contentsOf: parts.reversed().map { (name: $0, given: false) })
      case S_IFDIR:
        let next = withName(part) { openat(here, $0, O_SEARCH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        var opened = stat()
        guard next >= 0 else { return fail(.binFolder) }
        trail.append((next, part))
        guard fstat(next, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else { return fail(.binFolder) }
        guard trustedAncestor(next) || pending.isEmpty else { return fail(.binShared) }
      default:
        return fail(.binFolder)
      }
    }
    guard trail.count > 1 else { return fail(.binFolder) }
    if let refused = privateDestination(trail[trail.count - 1].fd) { return fail(refused) }
    let kept = trail.removeLast()
    for entry in trail { close(entry.fd) }
    let path = "/" + (trail.dropFirst().map(\.name) + [kept.name]).map { String(decoding: $0, as: UTF8.self) }.joined(separator: "/")
    return .success((kept.fd, path))
  }

  private static func readLinkBytes(_ dir: Int32, _ name: [UInt8]) -> [UInt8]? {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
    let count = withName(name) { readlinkat(dir, $0, &buffer, Int(PATH_MAX)) }
    guard count > 0 else { return nil }
    return buffer[0..<count].map { UInt8(bitPattern: $0) }
  }

  func entryPath(_ name: String) -> String { (path as NSString).appendingPathComponent(name) }

  func exists(_ name: String) -> Bool? {
    var info = stat()
    if fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 { return true }
    return errno == ENOENT ? false : nil
  }

  func isLink(_ name: String) -> Bool {
    var info = stat()
    return fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 && (info.st_mode & S_IFMT) == S_IFLNK
  }

  func targetBytes(_ name: String) -> [UInt8]? {
    isLink(name) ? Self.readLinkBytes(fd, Array(name.utf8)) : nil
  }

  func leadsNowhere(_ name: String) -> Bool {
    var info = stat()
    guard isLink(name), fstatat(fd, name, &info, 0) != 0 else { return false }
    return errno == ENOENT || errno == ENOTDIR
  }

  func isSameFile(_ name: String, as other: String) -> Bool {
    var here = stat()
    var there = stat()
    guard fstatat(fd, name, &here, 0) == 0, stat(other, &there) == 0 else { return false }
    return here.st_dev == there.st_dev && here.st_ino == there.st_ino
  }

  func names() -> [String]? {
    let copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard copy >= 0 else { return nil }
    guard let stream = fdopendir(copy) else {
      close(copy)
      return nil
    }
    defer { closedir(stream) }
    var found: [String] = []
    while let entry = readdir(stream) {
      let name = withUnsafePointer(to: entry.pointee.d_name) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
      if name != "." && name != ".." { found.append(name) }
    }
    return found
  }

  func create(_ name: String, to target: String) -> Bool {
    symlinkat(target, fd, name) == 0
  }

  func swap(_ name: String, to target: String) -> Bool {
    swap(name, toBytes: Array(target.utf8))
  }

  func swap(_ name: String, toBytes target: [UInt8]) -> Bool {
    guard !target.contains(0) else { return false }
    let temporary = ".\(name).ardia-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    guard Self.withName(target, { symlinkat($0, fd, temporary) }) == 0 else { return false }
    guard renameat(fd, temporary, fd, name) == 0 else {
      unlinkat(fd, temporary, 0)
      return false
    }
    return true
  }

  @discardableResult
  func remove(_ name: String) -> Bool {
    unlinkat(fd, name, 0) == 0 || errno == ENOENT
  }
}

extension PluginPrograms {
  static func unlinkOthers(plugin: String, keeping: Set<String>, places: ProgramPlaces) {
    guard case .success(let bin) = openBin(places) else { return }
    unlinkOthers(plugin: plugin, keeping: keeping, places: places, in: bin)
  }

  static func unlinkOthers(plugin: String, keeping: Set<String>, places: ProgramPlaces, in bin: BinFolder) {
    for (name, target) in linksIntoStore(places, in: bin) where !keeping.contains(name) && isLauncherPath(Array(target.utf8), in: places.store, plugin: plugin) {
      bin.remove(name)
    }
  }

  static func linksIntoStore(_ places: ProgramPlaces) -> [(String, String)] {
    guard case .success(let bin) = openBin(places) else { return [] }
    return linksIntoStore(places, in: bin)
  }

  static func linksIntoStore(_ places: ProgramPlaces, in bin: BinFolder) -> [(String, String)] {
    (bin.names() ?? []).compactMap { name in
      guard isName(name), let target = bin.targetBytes(name), isLauncherPath(target, in: places.store) else { return nil }
      return (name, String(decoding: target, as: UTF8.self))
    }
  }
}
