import Darwin
import Foundation

final class HostChannel {
  static let maxIncomingLine = 32 << 20
  static let maxOutgoingLine = (1 << 20) - 1
  static let maxPendingOutput = 16 << 20

  private let fd: Int32
  private let queue: DispatchQueue
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var writeSuspended = true
  private var incoming = Data()
  private var outgoing = Data()
  private let onLine: (String) -> Void
  private let onClose: () -> Void

  init(fd: Int32, queue: DispatchQueue, onLine: @escaping (String) -> Void, onClose: @escaping () -> Void) {
    self.fd = fd
    self.queue = queue
    self.onLine = onLine
    self.onClose = onClose
  }

  func open() {
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    let reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    reader.setEventHandler { [weak self] in self?.drain() }
    readSource = reader
    reader.activate()
    let writer = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
    writer.setEventHandler { [weak self] in self?.flush() }
    writeSource = writer
    writer.activate()
    writer.suspend()
  }

  private func drain() {
    var buffer = [UInt8](repeating: 0, count: 64 << 10)
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count > 0 {
        incoming.append(contentsOf: buffer[0..<count])
        deliverLines()
        continue
      }
      if count < 0 && errno == EINTR { continue }
      if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
      return close()
    }
  }

  private func deliverLines() {
    while let newline = incoming.firstIndex(of: 10) {
      let line = incoming[incoming.startIndex..<newline]
      incoming = Data(incoming[incoming.index(after: newline)...])
      if !line.isEmpty { onLine(String(decoding: line, as: UTF8.self)) }
    }
    if incoming.count > Self.maxIncomingLine {
      FileHandle.standardError.write(Data("[ardia] a line from Ardia was over \(Self.maxIncomingLine >> 20) MB, so the channel closed\n".utf8))
      close()
    }
  }

  enum SendRefusal: Error {
    case tooLong, hasNewline, backedUp, closed
    var message: String {
      switch self {
      case .tooLong: return "a line to Ardia is at most 1 MB"
      case .hasNewline: return "a line to Ardia can't contain a newline"
      case .backedUp: return "Ardia isn't reading, so the line was dropped"
      case .closed: return "the channel to Ardia is closed"
      }
    }
  }

  func send(_ line: String) -> SendRefusal? {
    guard readSource != nil else { return .closed }
    let bytes = Data(line.utf8)
    guard bytes.count <= Self.maxOutgoingLine else { return .tooLong }
    guard !bytes.contains(10) && !bytes.contains(13) else { return .hasNewline }
    guard outgoing.count + bytes.count < Self.maxPendingOutput else { return .backedUp }
    outgoing.append(bytes)
    outgoing.append(10)
    flush()
    return nil
  }

  private func flush() {
    while !outgoing.isEmpty {
      let count = outgoing.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
      if count > 0 {
        outgoing.removeFirst(count)
        continue
      }
      if count < 0 && errno == EINTR { continue }
      if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
        if writeSuspended {
          writeSuspended = false
          writeSource?.resume()
        }
        return
      }
      return close()
    }
    if !writeSuspended {
      writeSuspended = true
      writeSource?.suspend()
    }
  }

  func close() {
    guard let reader = readSource else { return }
    readSource = nil
    reader.cancel()
    if writeSuspended { writeSource?.resume() }
    writeSource?.cancel()
    writeSource = nil
    onClose()
  }
}
