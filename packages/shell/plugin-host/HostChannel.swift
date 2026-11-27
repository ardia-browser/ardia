import Darwin
import Foundation

final class HostChannel {
  static let maxIncomingLine = 32 << 20
  static let maxOutgoingLine = 8 << 20
  static let maxPendingOutput = 32 << 20
  static let urgentReserve = 16 << 20
  static let closedStatus: Int32 = 3

  private let fd: Int32
  private let queue: DispatchQueue
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var writeSuspended = true
  private var incoming: [UInt8] = []
  private var head = Data()
  private var urgent: [Data] = []
  private var bulk: [Data] = []
  private var urgentBytes = 0
  private var bulkBytes = 0
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
        let scanFrom = incoming.count
        incoming.append(contentsOf: buffer[0..<count])
        deliverLines(scanningFrom: scanFrom)
        guard readSource != nil else { return }
        continue
      }
      if count < 0 && errno == EINTR { continue }
      if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
      return close()
    }
  }

  private func deliverLines(scanningFrom scanFrom: Int) {
    var lineStart = 0
    var index = scanFrom
    while let newline = incoming[index...].firstIndex(of: 10) {
      if newline > lineStart { onLine(String(decoding: incoming[lineStart..<newline], as: UTF8.self)) }
      lineStart = newline + 1
      index = lineStart
      guard readSource != nil else { return }
    }
    if lineStart > 0 { incoming.removeFirst(lineStart) }
    if incoming.count > Self.maxIncomingLine {
      FileHandle.standardError.write(Data("[ardia] a line from Ardia was over \(Self.maxIncomingLine >> 20) MB, so the channel closed\n".utf8))
      close()
    }
  }

  enum SendRefusal: Error {
    case tooLong, hasNewline, backedUp, closed
    var message: String {
      switch self {
      case .tooLong: return "a line to Ardia is at most 8 MiB"
      case .hasNewline: return "a line to Ardia can't contain a newline"
      case .backedUp: return "Ardia isn't reading, so the line was dropped"
      case .closed: return "the channel to Ardia is closed"
      }
    }
  }

  var queuedOrder: [String] { ([head] + urgent + bulk).filter { !$0.isEmpty }.map { String(decoding: $0.dropLast(), as: UTF8.self) } }

  func send(_ line: String, urgent isUrgent: Bool = false) -> SendRefusal? {
    guard readSource != nil else { return .closed }
    var bytes = Data(line.utf8)
    guard bytes.count <= Self.maxOutgoingLine else { return .tooLong }
    guard !bytes.contains(10) && !bytes.contains(13) else { return .hasNewline }
    bytes.append(10)
    if isUrgent {
      guard urgentBytes + bytes.count < Self.urgentReserve else { return .backedUp }
      urgent.append(bytes)
      urgentBytes += bytes.count
    } else {
      guard head.count + bulkBytes + bytes.count < Self.maxPendingOutput else { return .backedUp }
      bulk.append(bytes)
      bulkBytes += bytes.count
    }
    flush()
    return nil
  }

  private func nextLine() -> Bool {
    guard head.isEmpty else { return true }
    if !urgent.isEmpty {
      head = urgent.removeFirst()
      urgentBytes -= head.count
      return true
    }
    if !bulk.isEmpty {
      head = bulk.removeFirst()
      bulkBytes -= head.count
      return true
    }
    return false
  }

  private func flush() {
    while nextLine() {
      let count = head.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
      if count > 0 {
        head.removeFirst(count)
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
