import Darwin
import Foundation

enum LegacyAdoption: String, Equatable {
  case adopted
  case already
  case failed
  case busy
  case none
}

extension PluginPrograms {
  static let legacyVersionPattern = try! NSRegularExpression(pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z]+\\.[0-9]+)?(\\.partial)?$")

  static func isLegacyVersion(_ name: String) -> Bool {
    ProgramRegistry.isComponent(name) && legacyVersionPattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
  }

  static func legacyLauncherPath(_ entry: LegacyInstall) -> String {
    ((entry.folder as NSString).appendingPathComponent(entry.current) as NSString).appendingPathComponent(entry.launcher)
  }

  private static func ownedFolderAt(_ parent: Int32, _ name: String) -> Int32? {
    let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == geteuid() else {
      close(fd)
      return nil
    }
    return fd
  }

  static func openLegacyRoot(_ entry: LegacyInstall) -> Int32? {
    guard entry.base.hasPrefix("/") else { return nil }
    if entry.relative.isEmpty {
      let parent = open((entry.base as NSString).deletingLastPathComponent, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
      guard parent >= 0 else { return nil }
      defer { close(parent) }
      return ownedFolderAt(parent, (entry.base as NSString).lastPathComponent)
    }
    var fd = open(entry.base, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    for part in entry.relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init) {
      guard ProgramRegistry.isComponent(part), let next = ownedFolderAt(fd, part) else {
        close(fd)
        return nil
      }
      close(fd)
      fd = next
    }
    return fd
  }

  private static func linkTargetAt(_ dir: Int32, _ name: String) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
    let count = readlinkat(dir, name, &buffer, Int(PATH_MAX))
    guard count > 0 else { return nil }
    return String(decoding: buffer[0..<count].map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  private static func launcherIsFileAt(_ root: Int32, version: String, launcher: String) -> Bool {
    guard var fd = ownedFolderAt(root, version) else { return false }
    defer { close(fd) }
    let parts = launcher.split(separator: "/").map(String.init)
    for part in parts.dropLast() {
      guard let next = ownedFolderAt(fd, part) else { return false }
      close(fd)
      fd = next
    }
    var info = stat()
    return fstatat(fd, parts.last ?? "", &info, AT_SYMLINK_NOFOLLOW) == 0 && (info.st_mode & S_IFMT) == S_IFREG
  }

  static func legacyInstalled(_ entry: LegacyInstall) -> Bool {
    guard let root = openLegacyRoot(entry) else { return false }
    defer { close(root) }
    guard let target = linkTargetAt(root, entry.current), isLegacyVersion(target) else { return false }
    return launcherIsFileAt(root, version: target, launcher: entry.launcher)
  }

  private static func swapLinkAt(_ dir: Int32, _ name: String, to target: String) -> Bool {
    var info = stat()
    if fstatat(dir, name, &info, AT_SYMLINK_NOFOLLOW) == 0 && (info.st_mode & S_IFMT) != S_IFLNK { return false }
    let temporary = ".\(name).\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    guard symlinkat(target, dir, temporary) == 0 else { return false }
    guard renameat(dir, temporary, dir, name) == 0 else {
      unlinkat(dir, temporary, 0)
      return false
    }
    return true
  }

  private static func entriesAt(_ dir: Int32) -> [String] {
    let copy = dup(dir)
    guard copy >= 0, let stream = fdopendir(copy) else { return [] }
    defer { closedir(stream) }
    var names: [String] = []
    while let entry = readdir(stream) {
      let name = withUnsafePointer(to: entry.pointee.d_name) { String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self)) }
      if name != "." && name != ".." { names.append(name) }
    }
    return names
  }

  private static func leasedAt(_ root: Int32, _ version: String) -> Bool {
    guard let folder = ownedFolderAt(root, version) else { return false }
    defer { close(folder) }
    guard let leases = ownedFolderAt(folder, leasesName) else { return false }
    defer { close(leases) }
    var live = false
    for name in entriesAt(leases) {
      guard let pid = pid_t(name), pid > 0 else { continue }
      var info = stat()
      guard fstatat(leases, name, &info, AT_SYMLINK_NOFOLLOW) == 0, (info.st_mode & S_IFMT) == S_IFREG else { continue }
      if let started = PluginProcessTree.entry(pid)?.started, started / 1_000_000 <= UInt64(max(0, info.st_mtimespec.tv_sec)) {
        live = true
      } else {
        unlinkat(leases, name, 0)
      }
    }
    return live
  }

  private static func removeTreeAt(_ parent: Int32, _ name: String) {
    if let fd = ownedFolderAt(parent, name) {
      for entry in entriesAt(fd) {
        var info = stat()
        guard fstatat(fd, entry, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
        if (info.st_mode & S_IFMT) == S_IFDIR { removeTreeAt(fd, entry) } else { unlinkat(fd, entry, 0) }
      }
      close(fd)
    }
    unlinkat(parent, name, AT_REMOVEDIR)
  }

  final class LegacyLock {
    let root: Int32
    let lock: Int32
    let outcome: LegacyAdoption
    var held: Bool { lock >= 0 && outcome != .busy && outcome != .failed && outcome != .none }

    init(root: Int32, lock: Int32, outcome: LegacyAdoption) {
      self.root = root
      self.lock = lock
      self.outcome = outcome
    }

    func release() {
      if lock >= 0 { close(lock) }
      if root >= 0 { close(root) }
    }
  }

  static func lockLegacy(_ entry: LegacyInstall, plugin: String, places: ProgramPlaces) -> LegacyLock {
    guard let root = openLegacyRoot(entry) else { return LegacyLock(root: -1, lock: -1, outcome: .none) }
    let lock = openat(root, ".lock", O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o644)
    guard lock >= 0 else { return LegacyLock(root: root, lock: -1, outcome: .failed) }
    var info = stat()
    guard fstat(lock, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == geteuid() else { return LegacyLock(root: root, lock: lock, outcome: .failed) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { return LegacyLock(root: root, lock: lock, outcome: errno == EWOULDBLOCK ? .busy : .failed) }
    let managed = (places.pluginStore(plugin) as NSString).appendingPathComponent(currentName)
    guard let target = linkTargetAt(root, entry.current) else { return LegacyLock(root: root, lock: lock, outcome: .none) }
    if target == managed { return LegacyLock(root: root, lock: lock, outcome: .already) }
    guard isLegacyVersion(target), launcherIsFileAt(root, version: target, launcher: entry.launcher) else { return LegacyLock(root: root, lock: lock, outcome: .none) }
    return LegacyLock(root: root, lock: lock, outcome: .adopted)
  }

  static func adoptLegacyLocked(_ held: LegacyLock, plugin: String, places: ProgramPlaces, entry: LegacyInstall) -> LegacyAdoption {
    let root = held.root
    let managed = (places.pluginStore(plugin) as NSString).appendingPathComponent(currentName)
    guard let target = linkTargetAt(root, entry.current) else { return .failed }
    var outcome = LegacyAdoption.already
    if target != managed {
      guard isLegacyVersion(target), launcherIsFileAt(root, version: target, launcher: entry.launcher) else { return .failed }
      guard swapLinkAt(root, entry.current, to: managed), linkTargetAt(root, entry.current) == managed else { return .failed }
      outcome = .adopted
    }
    for name in entriesAt(root) where isLegacyVersion(name) {
      guard let folder = ownedFolderAt(root, name) else { continue }
      close(folder)
      guard !leasedAt(root, name) else { continue }
      let trash = ".trash-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
      guard renameat(root, name, root, trash) == 0 else { continue }
      removeTreeAt(root, trash)
    }
    return outcome
  }
}
