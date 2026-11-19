import Foundation

extension SharedFolderDirectory {
  struct Cancelled: Error {}

  static let outside = "A folder change pointed outside the shared folder."
  static let housekeeping: [String] = [manifestName, ".\(manifestName)\(placeholderSuffix)", ".DS_Store"]

  func checkCancelled() throws {
    if isCancelled() { throw Cancelled() }
  }

  func parts(_ path: String) -> [String]? {
    let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !parts.isEmpty, !path.hasPrefix("/"), !parts.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
    return parts
  }

  func parent(of parts: [String], in root: Folder) throws -> Folder? {
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

  func applyChange(_ op: [String: Any], in root: Folder) throws -> String? {
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
      let fromInfo = folder.map { Self.info(in: $0.fd, name) }
      let from = fromInfo.map { Self.kind($0) } ?? .missing
      guard from == .missing || from == .directory || (from == .file && Self.isLink(name)), Self.isLink(toParts.last!) || from != .file else {
        throw Self.failure("Only links and folders are renamed.")
      }
      Self.pausePoint?("op:\(path)")
      guard let folder, from != .missing else { return nil }
      guard let destination else { return toPath }
      return try move(in: folder, name, Self.identity(fromInfo!.0), to: destination, toParts.last!) ? nil : toPath
    case "delete":
      guard Self.isLink(name), let expect = op["expect"] as? String else { throw Self.failure("Only links are deleted.") }
      Self.pausePoint?("op:\(path)")
      guard let folder else { return nil }
      return try delete(in: folder, name, expect: expect) ? nil : path
    case "mkdir":
      Self.pausePoint?("op:\(path)")
      guard let folder, folder.pathStillNamesIt, Self.kind(in: folder, name) == .missing else { return path }
      try checkCancelled()
      guard mkdirat(folder.fd, name, 0o755) == 0 else {
        if errno == EEXIST { return path }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      return Self.kind(in: folder, name) == .directory ? nil : path
    case "rmdir":
      Self.pausePoint?("op:\(path)")
      guard let folder else { return nil }
      guard folder.pathStillNamesIt else { return path }
      try removeEmptyDirectory(in: folder, name)
      return nil
    default:
      throw Self.failure("Unknown folder change “\(kind)”.")
    }
  }

  func staged(_ data: Data, near directory: URL, named name: String) throws -> (URL, URL) {
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

  func write(_ data: Data, in folder: Folder, _ name: String, create: Bool, expect: String?) throws -> Bool {
    let (staging, temporary) = try staged(data, near: folder.url, named: name)
    defer { try? fileManager.removeItem(at: staging) }
    var landed = false
    try coordinate(writing: folder.url.appendingPathComponent(name), options: .forReplacing) { _ in
      guard folder.pathStillNamesIt else { return }
      let before = Self.info(in: folder.fd, name)
      switch Self.kind(before) {
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
        let checked = Self.info(in: folder.fd, name)
        guard checked.1 == 0, Self.kind(checked) == .file, Self.identity(checked.0) == Self.identity(before.0) else { return }
        Self.pausePoint?("swap:\(name)")
        guard renameatx_np(AT_FDCWD, temporary.path, folder.fd, name, UInt32(RENAME_SWAP)) == 0 else {
          if errno == ENOENT { return }
          throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        var swappedOut = stat()
        if lstat(temporary.path, &swappedOut) == 0, Self.identity(swappedOut) == Self.identity(before.0) {
          landed = true
        } else {
          _ = renameatx_np(AT_FDCWD, temporary.path, folder.fd, name, UInt32(RENAME_SWAP))
        }
      default:
        return
      }
    }
    return landed
  }

  func move(in source: Folder, _ name: String, _ expected: [String: Int], to destination: Folder, _ target: String) throws -> Bool {
    guard Self.kind(in: destination, target) == .missing else { return false }
    var moved = false
    try SyncCoordination.move(coordination, source.url.appendingPathComponent(name), to: destination.url.appendingPathComponent(target)) { _, _ in
      try self.checkCancelled()
      guard Self.kind(in: destination, target) == .missing, source.pathStillNamesIt, destination.pathStillNamesIt else { return }
      Self.pausePoint?("move:\(name)")
      let now = Self.info(in: source.fd, name)
      guard now.1 == 0, Self.identity(now.0) == expected else { return }
      if renameatx_np(source.fd, name, destination.fd, target, UInt32(RENAME_EXCL)) == 0 {
        let landed = Self.info(in: destination.fd, target)
        moved = landed.1 == 0 && Self.identity(landed.0) == expected
        if !moved { _ = renameatx_np(destination.fd, target, source.fd, name, UInt32(RENAME_EXCL)) }
      } else if errno != EEXIST {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    }
    return moved
  }

  func delete(in folder: Folder, _ name: String, expect: String) throws -> Bool {
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
    var settled = true
    try coordinate(writing: url, options: .forDeleting) { _ in
      settled = folder.pathStillNamesIt
      let before = Self.info(in: folder.fd, name)
      guard settled, before.1 == 0, Self.kind(before) == .file, self.linkURL(in: folder, name) == expect else { return }
      Self.pausePoint?("unlink:\(name)")
      let aside = ".ardia-removing-\(UUID().uuidString)"
      guard renameatx_np(folder.fd, name, folder.fd, aside, UInt32(RENAME_EXCL)) == 0 else {
        if errno == ENOENT { return }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      let moved = Self.info(in: folder.fd, aside)
      guard moved.1 == 0, Self.identity(moved.0) == Self.identity(before.0), self.linkURL(in: folder, aside) == expect else {
        _ = renameatx_np(folder.fd, aside, folder.fd, name, UInt32(RENAME_EXCL))
        return
      }
      if unlinkat(folder.fd, aside, 0) != 0, errno != ENOENT { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
    return settled
  }

  func removeEmptyDirectory(in parent: Folder, _ name: String) throws {
    guard Self.kind(in: parent, name) == .directory, let directory = Self.openDirectory(in: parent, name), let expected = directory.identity else { return }
    guard let names = Self.names(in: directory, budget: nil, stopAfter: Self.housekeeping.count + 1) else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    guard names.allSatisfy(Self.housekeeping.contains) else { return }
    try checkCancelled()
    Self.pausePoint?("rmdir:\(name)")
    let aside = ".ardia-removing-\(UUID().uuidString)"
    guard renameatx_np(parent.fd, name, parent.fd, aside, UInt32(RENAME_EXCL)) == 0 else {
      if errno == ENOENT { return }
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    let moved = Self.info(in: parent.fd, aside)
    guard moved.1 == 0, Self.kind(moved) == .directory, Self.identity(moved.0) == expected else {
      _ = renameatx_np(parent.fd, aside, parent.fd, name, UInt32(RENAME_EXCL))
      return
    }
    let kept = Self.housekeeping.compactMap { item in
      Self.kind(in: directory, item) == .file ? Self.boundedRead(in: directory.fd, item, limit: Self.maxManifestBytes).map { (item, $0) } : nil
    }
    for (item, _) in kept { unlinkat(directory.fd, item, 0) }
    guard unlinkat(parent.fd, aside, AT_REMOVEDIR) != 0 else { return }
    let code = errno
    for (item, data) in kept { restoreExclusively(data, in: directory, named: item) }
    _ = renameatx_np(parent.fd, aside, parent.fd, name, UInt32(RENAME_EXCL))
    if code != ENOTEMPTY, code != ENOENT, code != EEXIST { throw NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }
  }

  func restoreExclusively(_ data: Data, in directory: Folder, named name: String) {
    guard let (staging, temporary) = try? staged(data, near: directory.url, named: name) else { return }
    defer { try? fileManager.removeItem(at: staging) }
    _ = renameatx_np(AT_FDCWD, temporary.path, directory.fd, name, UInt32(RENAME_EXCL))
  }
}
