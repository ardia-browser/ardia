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
      let complete = Self.writeAll(fd, data) && fsync(fd) == 0
      Darwin.close(fd)
      guard complete else {
        unlinkat(directory.fd, temporary, 0)
        return .failure(PluginFileFailure(.unavailable, "the file couldn't be written"))
      }
      if let failure = committed(directory, in: opened, "write") {
        unlinkat(directory.fd, temporary, 0)
        return .failure(failure)
      }
      let replaced: Result<Void, PluginFileFailure> = gated {
        replace(directory, temporary: temporary, name: name, exclusive: exclusive, in: opened).map { .failure($0) } ?? .success(())
      }
      if case .failure(let failure) = replaced {
        if failure == Self.accessEnded { unlinkat(directory.fd, temporary, 0) }
        return .failure(failure)
      }
      let answer = result(directory, name)
      if isData, case .success(let values) = answer, let size = values["size"] as? Int64 { quota?.adjust(root, by: size - oldSize) }
      return answer
    }
  }

  func replace(_ directory: Directory, temporary: String, name: String, exclusive: Bool, in opened: OpenedRoot) -> PluginFileFailure? {
    let written = entryIdentity(directory, temporary)
    mutating("write")
    var swapped = false
    if renameatx_np(directory.fd, temporary, directory.fd, name, UInt32(RENAME_EXCL)) != 0 {
      let code = errno
      if code == EEXIST, !exclusive, renameatx_np(directory.fd, temporary, directory.fd, name, UInt32(RENAME_SWAP)) == 0 {
        swapped = true
      } else {
        let code = code == EEXIST && !exclusive ? errno : code
        unlinkat(directory.fd, temporary, 0)
        if code == EEXIST { return PluginFileFailure(.exists, "the file already exists") }
        if code == EISDIR || code == ENOTDIR || code == ENOTEMPTY { return PluginFileFailure(.refused, "that's a folder, not a file") }
        return PluginFileFailure(.unavailable, "the file couldn't be saved (\(Self.errnoText(code)))")
      }
    }
    guard intact(directory, in: opened) else {
      if swapped {
        renameatx_np(directory.fd, temporary, directory.fd, name, UInt32(RENAME_SWAP))
        unlinkat(directory.fd, temporary, 0)
      } else if let written, entryIdentity(directory, name) == written {
        unlinkat(directory.fd, name, 0)
      }
      return Self.movedOut
    }
    if swapped { unlinkat(directory.fd, temporary, 0) }
    return nil
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
      if let failure = committed(directory, in: opened, "append") { return .failure(failure) }
      return gated {
        let existed = entryIdentity(directory, name) != nil
        mutating("append")
        let fd = openat(directory.fd, name, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, fileMode)
        guard fd >= 0 else {
          let code = errno
          if code == ELOOP { return .failure(PluginFileFailure(.refused, "the file is a link")) }
          if code == EISDIR { return .failure(PluginFileFailure(.refused, "that's a folder, not a file")) }
          if code == ENXIO { return .failure(PluginFileFailure(.refused, "that isn't a plain file")) }
          return .failure(PluginFileFailure(.unavailable, "the file couldn't be opened (\(Self.errnoText(code)))"))
        }
        defer { Darwin.close(fd) }
        let dropMade = {
          if !existed, let made = PluginFileIdentity(fd: fd), self.entryIdentity(directory, name) == made { unlinkat(directory.fd, name, 0) }
        }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return .failure(PluginFileFailure(.refused, "that isn't a plain file")) }
        guard info.st_nlink <= 1 else { return .failure(Self.hardLinkRefusal) }
        guard intact(directory, in: opened), confinedFile(fd, in: opened) else {
          dropMade()
          return .failure(PluginFileFailure(.refused, "the file moved out of the root"))
        }
        if isDataless(info, path) {
          requestDownload(path)
          return .failure(PluginFileFailure(.unavailable, "the file isn't downloaded yet"))
        }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
        let before = info.st_size
        let complete = Self.writeAll(fd, data) && fsync(fd) == 0
        guard intact(directory, in: opened), confinedFile(fd, in: opened) else {
          ftruncate(fd, before)
          dropMade()
          return .failure(Self.movedOut)
        }
        guard fstat(fd, &info) == 0 else { return .failure(PluginFileFailure(.unavailable, "the file couldn't be read back")) }
        if isData { quota?.adjust(root, by: Int64(info.st_size - before)) }
        guard complete else { return .failure(PluginFileFailure(.unavailable, "the file couldn't be written")) }
        return .success(["size": Int64(info.st_size), "mtimeMs": Self.mtimeMs(info)])
      }
    }
  }
}
