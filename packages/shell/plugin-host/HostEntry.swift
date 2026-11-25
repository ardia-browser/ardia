import Darwin
import Foundation

enum HostEntry {
  static let limit = 16 << 20

  static func parts(_ relative: String) -> [String]? {
    let pieces = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !pieces.isEmpty, pieces.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") }) else { return nil }
    return pieces
  }

  static func read(_ relative: String) -> Result<String, HostFailure> {
    guard let parts = parts(relative) else { return .failure(HostFailure("--entry \(relative) isn't a plain path inside the plugin's folder")) }
    var directory = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard directory >= 0 else { return .failure(HostFailure("the plugin's folder can't be opened")) }
    defer { Darwin.close(directory) }
    for part in parts.dropLast() {
      let next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else { return .failure(HostFailure("\(relative) isn't inside the plugin's folder")) }
      Darwin.close(directory)
      directory = next
    }
    let fd = openat(directory, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return .failure(HostFailure("\(relative) wasn't found, or is a link")) }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return .failure(HostFailure("\(relative) isn't a file")) }
    guard info.st_size <= off_t(limit) else { return .failure(HostFailure("\(relative) is over 16 MB")) }
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 64 << 10)
    while true {
      let got = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if got < 0 && errno == EINTR { continue }
      if got < 0 { return .failure(HostFailure("\(relative) couldn't be read")) }
      if got == 0 { break }
      data.append(contentsOf: chunk[0..<got])
      if data.count > limit { return .failure(HostFailure("\(relative) is over 16 MB")) }
    }
    guard let text = String(data: data, encoding: .utf8) else { return .failure(HostFailure("\(relative) isn't UTF-8 text")) }
    return .success(text)
  }
}

struct HostFailure: Error {
  let message: String
  init(_ message: String) { self.message = message }
}
