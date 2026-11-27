import Darwin
import Foundation

extension PluginFileStore {
  static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    var written = 0
    while written < data.count {
      let step = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + written, data.count - written) }
      if step < 0 && errno == EINTR { continue }
      if step <= 0 { return false }
      written += step
    }
    return true
  }

  func result(_ directory: Directory, _ name: String) -> Result<[String: Any], PluginFileFailure> {
    var info = stat()
    guard fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return .failure(PluginFileFailure(.unavailable, "the file vanished right after it was written")) }
    return .success(["size": Int64(info.st_size), "mtimeMs": Self.mtimeMs(info)])
  }

  func write(_ path: String, data: Data, exclusive: Bool) -> Result<[String: Any], PluginFileFailure> {
    guard data.count <= Self.maxData else { return .failure(PluginFileFailure(.tooLarge, "a write carries at most 4 MiB")) }
    let parts: [String]
    switch Self.segments(path, allowRoot: false) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): parts = found
    }
    let opened: OpenedRoot
    switch openRoot() {
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    return coordinate(path, deleting: false) {
      let directory: Directory
      switch walk(opened, parts.dropLast(), create: true) {
      case .failure(let failure): return .failure(failure)
      case .success(let found): directory = found
      }
      let name = parts.last!
      var existing = stat()
      var oldSize: Int64 = 0
      if fstatat(directory.fd, name, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
        switch existing.st_mode & S_IFMT {
        case S_IFREG where existing.st_nlink > 1: return .failure(Self.hardLinkRefusal)
        case S_IFREG: oldSize = Int64(existing.st_size)
        case S_IFLNK: return .failure(PluginFileFailure(.refused, "the file is a link"))
        case S_IFDIR: return .failure(PluginFileFailure(.refused, "that's a folder, not a file"))
        default: return .failure(PluginFileFailure(.refused, "that isn't a plain file"))
        }
        if exclusive { return .failure(PluginFileFailure(.exists, "the file already exists")) }
      } else if exclusive, Self.hasPlaceholder(in: directory, name) != nil {
        return .failure(PluginFileFailure(.exists, "the file already exists"))
      }
      if isData, let quota, usage(opened) - oldSize + Int64(data.count) > quota.cap {
        return .failure(PluginFileFailure(.tooLarge, "the plugin's files would pass \(quota.cap >> 20) MiB"))
      }
      if let failure = committed(directory, in: opened, "temporary") { return .failure(failure) }
      let temporary = Self.temporaryName(for: name)
      let fd = openat(directory.fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, fileMode)
      guard fd >= 0 else { return .failure(PluginFileFailure(.unavailable, "the file couldn't be written (\(Self.errnoText(errno)))")) }
      let made = PluginFileIdentity(fd: fd)
      let complete = Self.writeAll(fd, data) && fsync(fd) == 0
      Darwin.close(fd)
      let dropTemporary = { self.unlinkOwn(directory, temporary, made) }
      guard complete, made != nil else {
        dropTemporary()
        return .failure(PluginFileFailure(.unavailable, "the file couldn't be written"))
      }
      if let failure = committed(directory, in: opened, "write") {
        dropTemporary()
        return .failure(failure)
      }
      let placed: Result<Void, PluginFileFailure> = gated {
        mutating("write")
        guard intact(directory, in: opened) else { return .failure(Self.movedOut) }
        let moved = exclusive ? renameatx_np(directory.fd, temporary, directory.fd, name, UInt32(RENAME_EXCL)) : renameat(directory.fd, temporary, directory.fd, name)
        guard moved == 0 else {
          let code = errno
          if code == EEXIST { return .failure(PluginFileFailure(.exists, "the file already exists")) }
          if code == EISDIR || code == ENOTDIR || code == ENOTEMPTY { return .failure(PluginFileFailure(.refused, "that's a folder, not a file")) }
          return .failure(PluginFileFailure(.unavailable, "the file couldn't be saved (\(Self.errnoText(code)))"))
        }
        return .success(())
      }
      if case .failure(let failure) = placed {
        dropTemporary()
        return .failure(failure)
      }
      mutating("placed")
      guard intact(directory, in: opened) else { return .failure(Self.movedOut) }
      let answer = result(directory, name)
      if isData, case .success(let values) = answer, let size = values["size"] as? Int64 { quota?.adjust(root, by: size - oldSize) }
      return answer
    }
  }

  func unlinkOwn(_ directory: Directory, _ name: String, _ made: PluginFileIdentity?) {
    guard let made, entryIdentity(directory, name) == made else { return }
    unlinkat(directory.fd, name, 0)
  }

  func append(_ path: String, data: Data) -> Result<[String: Any], PluginFileFailure> {
    guard data.count <= Self.maxData else { return .failure(PluginFileFailure(.tooLarge, "an append carries at most 4 MiB")) }
    let parts: [String]
    switch Self.segments(path, allowRoot: false) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): parts = found
    }
    let opened: OpenedRoot
    switch openRoot() {
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    return coordinate(path, deleting: false) {
      let directory: Directory
      switch walk(opened, parts.dropLast(), create: true) {
      case .failure(let failure): return .failure(failure)
      case .success(let found): directory = found
      }
      let name = parts.last!
      if isData, let quota, usage(opened) + Int64(data.count) > quota.cap {
        return .failure(PluginFileFailure(.tooLarge, "the plugin's files would pass \(quota.cap >> 20) MiB"))
      }
      if Self.hasPlaceholder(in: directory, name) != nil {
        var info = stat()
        if fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
          requestDownload(path)
          return .failure(PluginFileFailure(.unavailable, "the file isn't downloaded yet"))
        }
      }
      var existing = stat()
      let existed = fstatat(directory.fd, name, &existing, AT_SYMLINK_NOFOLLOW) == 0
      if existed, (existing.st_mode & S_IFMT) == S_IFREG, isDataless(existing, path) {
        requestDownload(path)
        return .failure(PluginFileFailure(.unavailable, "the file isn't downloaded yet"))
      }
      if let failure = committed(directory, in: opened, "append") { return .failure(failure) }
      let appended: Result<(Int32, off_t), PluginFileFailure> = gated {
        mutating("append")
        guard intact(directory, in: opened) else { return .failure(Self.movedOut) }
        let flags = O_WRONLY | O_APPEND | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC
        var createdHere = false
        var fd: Int32 = -1
        if !existed {
          fd = openat(directory.fd, name, flags | O_CREAT | O_EXCL, fileMode)
          createdHere = fd >= 0
        }
        if fd < 0, existed || errno == EEXIST { fd = openat(directory.fd, name, flags) }
        guard fd >= 0 else {
          let code = errno
          if code == ELOOP { return .failure(PluginFileFailure(.refused, "the file is a link")) }
          if code == EISDIR { return .failure(PluginFileFailure(.refused, "that's a folder, not a file")) }
          if code == ENXIO { return .failure(PluginFileFailure(.refused, "that isn't a plain file")) }
          return .failure(PluginFileFailure(.unavailable, "the file couldn't be opened (\(Self.errnoText(code)))"))
        }
        let made = createdHere ? PluginFileIdentity(fd: fd) : nil
        var info = stat()
        let refuse = { (failure: PluginFileFailure) -> Result<(Int32, off_t), PluginFileFailure> in
          self.unlinkOwn(directory, name, made)
          Darwin.close(fd)
          return .failure(failure)
        }
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return refuse(PluginFileFailure(.refused, "that isn't a plain file")) }
        guard info.st_nlink <= 1 else { return refuse(Self.hardLinkRefusal) }
        guard intact(directory, in: opened), confinedFile(fd, in: opened) else { return refuse(PluginFileFailure(.refused, "the file moved out of the root")) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
        let before = info.st_size
        guard Self.writeAll(fd, data) else {
          var after = stat()
          if isData, fstat(fd, &after) == 0 { quota?.adjust(root, by: Int64(after.st_size - before)) }
          Darwin.close(fd)
          return .failure(PluginFileFailure(.unavailable, "the file couldn't be written"))
        }
        return .success((fd, before))
      }
      guard case .success(let (fd, before)) = appended else {
        if case .failure(let failure) = appended { return .failure(failure) }
        return .failure(PluginFileFailure(.unavailable, "the file couldn't be written"))
      }
      defer { Darwin.close(fd) }
      let synced = fsync(fd) == 0
      var info = stat()
      guard fstat(fd, &info) == 0 else { return .failure(PluginFileFailure(.unavailable, "the file couldn't be read back")) }
      if isData { quota?.adjust(root, by: Int64(info.st_size - before)) }
      guard synced else { return .failure(PluginFileFailure(.unavailable, "the file couldn't be saved")) }
      return .success(["size": Int64(info.st_size), "mtimeMs": Self.mtimeMs(info)])
    }
  }
}
