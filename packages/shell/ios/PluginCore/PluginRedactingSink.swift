import Darwin
import Foundation

final class PluginRedactingSink {
  static let longestLine = 4096
  static let keptLines = 200

  private let fd: Int32
  private let queue: DispatchQueue
  private let redact: (String) -> String
  private var source: DispatchSourceRead?
  private var partial = Data()
  private(set) var recent: [String] = []
  private(set) var seenLines = 0

  init(fd: Int32, queue: DispatchQueue, redact: @escaping (String) -> String) {
    self.fd = fd
    self.queue = queue
    self.redact = redact
  }

  func open() {
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    let reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    reader.setEventHandler { [weak self] in self?.drain() }
    reader.setCancelHandler { [fd] in Darwin.close(fd) }
    source = reader
    reader.activate()
  }

  func close() {
    flush()
    source?.cancel()
    source = nil
  }

  private func drain() {
    var buffer = [UInt8](repeating: 0, count: 16 << 10)
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count > 0 {
        take(Data(buffer[0..<count]))
        continue
      }
      if count < 0 && errno == EINTR { continue }
      if count == 0 { close() }
      return
    }
  }

  func take(_ data: Data) {
    partial.append(data)
    while let newline = partial.firstIndex(of: 10) {
      keep(Data(partial[partial.startIndex..<newline]))
      partial = Data(partial[partial.index(after: newline)...])
    }
    if partial.count > Self.longestLine {
      keep(partial)
      partial = Data()
    }
  }

  func flush() {
    if !partial.isEmpty { keep(partial) }
    partial = Data()
  }

  private func keep(_ bytes: Data) {
    seenLines += 1
    let line = redact(String(decoding: bytes.prefix(Self.longestLine), as: UTF8.self))
    recent.append(line)
    if recent.count > Self.keptLines { recent.removeFirst(recent.count - Self.keptLines) }
  }
}
