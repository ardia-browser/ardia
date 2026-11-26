import Darwin
import Foundation

enum PluginBoundedFile {
  static func openRegular(_ path: String) -> Result<(fd: Int32, size: Int), FolderRefusal> {
    let fd = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { return .failure(FolderRefusal(reason: errno == ELOOP ? "it's a link" : "it couldn't be opened")) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
      Darwin.close(fd)
      return .failure(FolderRefusal(reason: "it isn't a regular file"))
    }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
    return .success((fd, Int(info.st_size)))
  }

  static func read(_ fd: Int32, offset: Int, length: Int) -> Data? {
    guard offset >= 0, length >= 0 else { return nil }
    var out = Data(count: length)
    var done = 0
    while done < length {
      let step = out.withUnsafeMutableBytes { pread(fd, $0.baseAddress!.advanced(by: done), length - done, off_t(offset + done)) }
      if step < 0 && errno == EINTR { continue }
      if step < 0 { return nil }
      if step == 0 { break }
      done += step
    }
    return out.prefix(done)
  }

  static func readWhole(_ fd: Int32, max: Int) -> Data? {
    guard let data = read(fd, offset: 0, length: max + 1), data.count <= max else { return nil }
    return data
  }
}
