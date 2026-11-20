import CryptoKit
import Darwin
import Foundation

struct OpenedFolder {
  let fd: Int32
  let path: String
  let id: String

  func close() { Darwin.close(fd) }
}

struct FolderRefusal: Error {
  let reason: String
}

enum ManifestRead: Equatable {
  case text(String)
  case missing, link, notFile, tooBig, unreadable

  var status: String {
    switch self {
    case .text: return "ok"
    case .missing: return "missing"
    case .link: return "link"
    case .notFile: return "notFile"
    case .tooBig: return "tooBig"
    case .unreadable: return "unreadable"
    }
  }
}

enum PluginFiles {
  static let logLimit: off_t = 1 << 20
  static let manifestName = "plugin.json"
  static let manifestLimit = 1 << 20

  static func openedPath(_ fd: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fcntl(fd, F_GETPATH, &buffer) == 0 else { return nil }
    return String(cString: buffer)
  }

  static func openFolder(_ path: String) -> OpenedFolder? {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    var info = stat()
    guard fstat(fd, &info) == 0, let real = openedPath(fd) else {
      Darwin.close(fd)
      return nil
    }
    return OpenedFolder(fd: fd, path: real, id: "\(info.st_dev):\(info.st_ino)")
  }

  static func readManifest(in folder: OpenedFolder) -> ManifestRead {
    let fd = openat(folder.fd, manifestName, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
    if fd < 0 { return errno == ELOOP ? .link : errno == ENOENT || errno == ENOTDIR ? .missing : .unreadable }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { return .unreadable }
    guard (info.st_mode & S_IFMT) == S_IFREG else { return .notFile }
    guard info.st_size <= manifestLimit else { return .tooBig }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while data.count <= manifestLimit {
      let count = Darwin.read(fd, &buffer, buffer.count)
      if count < 0 {
        if errno == EINTR { continue }
        return .unreadable
      }
      if count == 0 { break }
      data.append(buffer, count: count)
    }
    guard data.count <= manifestLimit else { return .tooBig }
    guard let text = String(data: data, encoding: .utf8) else { return .unreadable }
    return .text(text)
  }

  static func approvalHash(text: String, folderId: String) -> String {
    SHA256.hash(data: Data("\(text)\u{0}\(folderId)".utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func approvedFolder(_ path: String, folderId: String, approved: String, identity: String? = nil) -> Result<OpenedFolder, FolderRefusal> {
    guard let opened = openFolder(path) else { return .failure(FolderRefusal(reason: "its folder is missing")) }
    let folder = identity.map { OpenedFolder(fd: opened.fd, path: opened.path, id: $0) } ?? opened
    guard folder.id == folderId else {
      folder.close()
      return .failure(FolderRefusal(reason: "its folder was replaced since you approved it"))
    }
    guard case .text(let text) = readManifest(in: folder), approvalHash(text: text, folderId: folder.id) == approved else {
      folder.close()
      return .failure(FolderRefusal(reason: "its plugin.json changed since you approved it"))
    }
    return .success(folder)
  }

  static func pathParts(_ relative: String) -> [String]? {
    let pieces = relative.utf8.split(separator: UInt8(ascii: "/"), omittingEmptySubsequences: false)
    var parts: [String] = []
    for piece in pieces {
      guard !piece.isEmpty, !piece.contains(0), let part = String(bytes: piece, encoding: .utf8), part != ".", part != ".." else { return nil }
      parts.append(part)
    }
    return parts.isEmpty ? nil : parts
  }

  static func openBeneath(_ folder: Int32, _ relative: String, flags: Int32) -> Int32 {
    guard let parts = pathParts(relative) else { return -1 }
    var directory = folder
    defer { if directory != folder { Darwin.close(directory) } }
    for part in parts.dropLast() {
      let next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else { return -1 }
      if directory != folder { Darwin.close(directory) }
      directory = next
    }
    return openat(directory, parts.last!, flags | O_NOFOLLOW | O_CLOEXEC)
  }

  static let maxPageFile = 10 << 20

  static func readPageFile(_ path: String, folderId: String, approved: String, relative: String, identity: String? = nil) -> Data? {
    guard case .success(let folder) = approvedFolder(path, folderId: folderId, approved: approved, identity: identity) else { return nil }
    defer { folder.close() }
    let fd = openBeneath(folder.fd, relative, flags: O_RDONLY | O_NONBLOCK)
    guard fd >= 0 else { return nil }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= maxPageFile else { return nil }
    return readAll(fd, limit: maxPageFile)
  }

  static func readAll(_ fd: Int32, limit: Int) -> Data? {
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 64 << 10)
    while true {
      let got = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if got < 0 && errno == EINTR { continue }
      if got < 0 { return nil }
      if got == 0 { return data }
      data.append(contentsOf: chunk[0..<got])
      if data.count > limit { return nil }
    }
  }

  static func localProgram(_ relative: String, in folder: OpenedFolder) -> String? {
    let fd = openBeneath(folder.fd, relative, flags: O_RDONLY | O_NONBLOCK)
    guard fd >= 0 else { return nil }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_mode & 0o111 != 0 else { return nil }
    return "./" + relative
  }

  static func openDataFolder(_ path: String) -> OpenedFolder? {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == geteuid(), let real = openedPath(fd) else {
      Darwin.close(fd)
      return nil
    }
    for sub in ["home", "tmp"] {
      var made = stat()
      if mkdirat(fd, sub, 0o700) != 0 && errno != EEXIST || fstatat(fd, sub, &made, AT_SYMLINK_NOFOLLOW) != 0 || (made.st_mode & S_IFMT) != S_IFDIR {
        Darwin.close(fd)
        return nil
      }
    }
    return OpenedFolder(fd: fd, path: real, id: "\(info.st_dev):\(info.st_ino)")
  }

  static func openLog(in folder: OpenedFolder) -> Int32 {
    var info = stat()
    if fstatat(folder.fd, "plugin.log", &info, AT_SYMLINK_NOFOLLOW) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size > logLimit {
      renameat(folder.fd, "plugin.log", folder.fd, "plugin.log.1")
    }
    let fd = openat(folder.fd, "plugin.log", O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0o600)
    guard fd >= 0 else { return -1 }
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
      Darwin.close(fd)
      errno = EFTYPE
      return -1
    }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
    return fd
  }

}
