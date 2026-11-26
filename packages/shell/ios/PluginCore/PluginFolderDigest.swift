import CryptoKit
import Darwin
import Foundation

enum PluginFolderDigest {
  static let prefix = "local-"
  static let maxFiles = 4096
  static let maxBytes: Int64 = 256 << 20
  static let skippedNames: Set<String> = [".DS_Store"]

  enum Failure: Error, Equatable {
    case unreadable(String)
    case special(String)
    case tooBig
  }

  private struct Walk {
    var files = 0
    var bytes: Int64 = 0
    var lines: [(path: [UInt8], kind: UInt8, size: Int64, executable: Bool)] = []
  }

  static func folderId(_ digest: String) -> String { prefix + digest }

  static func digest(_ folder: Int32) -> Result<String, Failure> {
    var walk = Walk()
    if let failure = collect(folder, relative: [], into: &walk) { return .failure(failure) }
    var hasher = SHA256()
    hasher.update(data: Data("ardia-folder-v1\n".utf8))
    let sorted = walk.lines.sorted { $0.path.lexicographicallyPrecedes($1.path) }
    for line in sorted {
      hasher.update(data: Data([line.kind, 0]))
      hasher.update(data: Data(line.path))
      hasher.update(data: Data([0]))
      guard line.kind == UInt8(ascii: "f") else { continue }
      hasher.update(data: Data("\(line.size)\u{0}\(line.executable ? "x" : "-")\u{0}".utf8))
      let relative = String(decoding: line.path, as: UTF8.self)
      let fd = PluginFiles.openBeneath(folder, relative, flags: O_RDONLY | O_NONBLOCK)
      guard fd >= 0 else { return .failure(.unreadable(relative)) }
      defer { close(fd) }
      var info = stat()
      guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, Int64(info.st_size) == line.size else { return .failure(.unreadable(relative)) }
      var left = line.size
      var buffer = [UInt8](repeating: 0, count: 64 << 10)
      while left > 0 {
        let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, min($0.count, Int(left))) }
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { return .failure(.unreadable(relative)) }
        hasher.update(data: Data(buffer[0..<count]))
        left -= Int64(count)
      }
    }
    return .success(hasher.finalize().map { String(format: "%02x", $0) }.joined())
  }

  private static func collect(_ folder: Int32, relative: [UInt8], into walk: inout Walk) -> Failure? {
    let shownFolder = relative.isEmpty ? "its folder" : String(decoding: relative, as: UTF8.self)
    let listing = dup(folder)
    guard listing >= 0, let directory = fdopendir(listing) else {
      if listing >= 0 { close(listing) }
      return .unreadable(shownFolder)
    }
    defer { closedir(directory) }
    rewinddir(directory)
    var names: [[UInt8]] = []
    while let entry = readdir(directory) {
      let name = withUnsafeBytes(of: entry.pointee.d_name) { Array($0.prefix(Int(entry.pointee.d_namlen))) }
      if name != [0x2E] && name != [0x2E, 0x2E] { names.append(name) }
    }
    for name in names {
      let text = String(decoding: name, as: UTF8.self)
      let path = relative.isEmpty ? name : relative + [0x2F] + name
      let shown = String(decoding: path, as: UTF8.self)
      var info = stat()
      guard fstatat(folder, text, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return .unreadable(shown) }
      if skippedNames.contains(text) && (info.st_mode & S_IFMT) == S_IFREG { continue }
      walk.files += 1
      if walk.files > maxFiles { return .tooBig }
      switch info.st_mode & S_IFMT {
      case S_IFDIR:
        walk.lines.append((path, UInt8(ascii: "d"), 0, false))
        let child = openat(folder, text, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { return .unreadable(shown) }
        defer { close(child) }
        if let failure = collect(child, relative: path, into: &walk) { return failure }
      case S_IFREG:
        walk.bytes += Int64(info.st_size)
        if walk.bytes > maxBytes { return .tooBig }
        walk.lines.append((path, UInt8(ascii: "f"), Int64(info.st_size), info.st_mode & 0o111 != 0))
      default:
        return .special(shown)
      }
    }
    return nil
  }

  static func reason(_ failure: Failure) -> String {
    switch failure {
    case .unreadable(let path): return "\(path) couldn't be read"
    case .special(let path): return "\(path) is a link or a special file; a plugin folder holds only files and folders"
    case .tooBig: return "it's over \(maxFiles) files or \(maxBytes >> 20) MB"
    }
  }
}

final class FolderDigests {
  static let shared = FolderDigests()

  private let lock = NSLock()
  private var known: [String: (stamp: [[Int64]], digest: String)] = [:]

  func digest(_ folder: OpenedFolder) -> Result<String, PluginFolderDigest.Failure> {
    let stamp = StoreVerification.treeStamp(folder.path)
    lock.lock()
    if let stamp, let found = known[folder.path], found.stamp == stamp {
      lock.unlock()
      return .success(found.digest)
    }
    lock.unlock()
    let made = PluginFolderDigest.digest(folder.fd)
    if case .success(let digest) = made, let stamp {
      lock.lock()
      if known.count > 128 { known.removeAll() }
      known[folder.path] = (stamp, digest)
      lock.unlock()
    }
    return made
  }

  func forgetAll() {
    lock.lock()
    known.removeAll()
    lock.unlock()
  }
}
