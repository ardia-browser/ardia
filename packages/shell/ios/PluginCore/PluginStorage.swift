import Darwin
import Foundation

enum PluginStorageRead: Equatable {
  case ok(String)
  case missing
  case error(String)

  var reply: [String: Any] {
    switch self {
    case .ok(let text): return ["status": "ok", "text": text]
    case .missing: return ["status": "missing"]
    case .error(let reason): return ["status": "error", "reason": reason]
    }
  }
}

enum PluginStorage {
  static let fileName = "storage.json"
  static let limit = 2 << 20

  static func read(in directory: Int32) -> PluginStorageRead {
    let fd = openat(directory, fileName, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
    if fd < 0 {
      if errno == ENOENT { return .missing }
      return .error(errno == ELOOP ? "its storage is a link" : "its storage couldn't be opened (\(String(cString: strerror(errno))))")
    }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return .error("its storage isn't a file") }
    guard info.st_size <= off_t(limit) else { return .error("its storage is over 2 MB") }
    guard let data = PluginFiles.readAll(fd, limit: limit) else { return .error("its storage couldn't be read") }
    guard let text = String(data: data, encoding: .utf8) else { return .error("its storage isn't UTF-8") }
    return .ok(text)
  }

  static func isJSON(_ text: String) -> Bool {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])) != nil
  }

  static func write(in directory: Int32, text: String) -> FolderRefusal? {
    let bytes = Array(text.utf8)
    guard bytes.count <= limit else { return FolderRefusal(reason: "its storage would be over 2 MB") }
    guard isJSON(text) else { return FolderRefusal(reason: "its storage has to be JSON") }
    var existing = stat()
    if fstatat(directory, fileName, &existing, AT_SYMLINK_NOFOLLOW) == 0, (existing.st_mode & S_IFMT) != S_IFREG {
      return FolderRefusal(reason: (existing.st_mode & S_IFMT) == S_IFLNK ? "its storage is a link" : "its storage isn't a file")
    }
    let temporary = ".\(fileName).\(UUID().uuidString)"
    let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return FolderRefusal(reason: "its storage couldn't be written (\(String(cString: strerror(errno))))") }
    var written = 0
    while written < bytes.count {
      let step = bytes[written...].withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
      if step < 0 && errno == EINTR { continue }
      if step <= 0 { break }
      written += step
    }
    let complete = written == bytes.count && fchmod(fd, 0o600) == 0 && fsync(fd) == 0
    Darwin.close(fd)
    guard complete, renameat(directory, temporary, directory, fileName) == 0 else {
      unlinkat(directory, temporary, 0)
      return FolderRefusal(reason: "its storage couldn't be saved")
    }
    return nil
  }
}
