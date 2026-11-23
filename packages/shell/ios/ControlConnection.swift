import Darwin
import Foundation

final class ControlConnection {
  static let maxLine = 1_048_576
  static let maxPendingRequests = 32
  static let lineDeadline: TimeInterval = 30
  static let retireDeadline: TimeInterval = 5
  static let maxRetiring = 16
  private(set) static var retiring: [ControlConnection] = []
  private static let readSize = 65536

  let id: Int
  private let fd: Int32
  private let queue: DispatchQueue
  private let onLine: (ControlConnection, String) -> Void
  private let onClose: (ControlConnection) -> Void
  private let onWritten: ([Int]) -> Void
  private let onPeerFinished: (ControlConnection) -> Void
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var writeArmed = false
  private var openSources = 0
  private var input: [UInt8] = []
  private var output = ControlOutput()
  private var pendingRequests = 0
  private var deadline: DispatchWorkItem?
  private(set) var closed = false
  private var finishingLine = false
  private var draining = false
  private var readSuspended = false
  private var announced = false
  private var roomWaiters: [(limit: Int, work: () -> Void)] = []

  var bufferedBytes: Int { output.bytes }

  func whenRoom(below limit: Int, _ work: @escaping () -> Void) {
    guard !closed, !finishingLine else { return }
    if output.bytes < limit { return work() }
    roomWaiters.append((limit, work))
  }

  func release() {
    pendingRequests = max(0, pendingRequests - 1)
    closeIfDrained()
  }

  private func wakeRoomWaiters() {
    guard !roomWaiters.isEmpty else { return }
    let bytes = output.bytes
    let ready = roomWaiters.filter { bytes < $0.limit }
    roomWaiters.removeAll { bytes < $0.limit }
    ready.forEach { $0.work() }
  }

  init(
    id: Int, fd: Int32, queue: DispatchQueue, onLine: @escaping (ControlConnection, String) -> Void,
    onClose: @escaping (ControlConnection) -> Void, onWritten: @escaping ([Int]) -> Void,
    onPeerFinished: @escaping (ControlConnection) -> Void = { _ in }
  ) {
    self.id = id
    self.fd = fd
    self.queue = queue
    self.onLine = onLine
    self.onClose = onClose
    self.onWritten = onWritten
    self.onPeerFinished = onPeerFinished
  }

  func open() {
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in self?.readAvailable() }
    adopt(source)
    readSource = source
    source.activate()
  }

  func reply(_ data: Data, ticket: Int) {
    guard !closed, !finishingLine else { return report(ticket > 0 ? [ticket] : []) }
    pendingRequests = max(0, pendingRequests - 1)
    guard output.addReply(data, ticket: ticket) else {
      report(ticket > 0 ? [ticket] : [])
      return retire()
    }
    if !writeArmed { flush() }
  }

  func send(_ data: Data) {
    guard !closed, !finishingLine, !draining else { return }
    guard output.addKept(data) else { return retire() }
    if !writeArmed { flush() }
  }

  func event(_ data: Data) {
    guard !closed, !finishingLine, !draining else { return }
    enqueue(output.addEvent(data))
  }

  func retire() {
    guard !closed, !finishingLine else { return }
    guard output.midLine else { return close() }
    finishingLine = true
    deadline?.cancel()
    input = []
    report(output.keepOnlyHead())
    announce()
    Self.retiring.append(self)
    if Self.retiring.count > Self.maxRetiring { Self.retiring.first?.close() }
    let item = DispatchWorkItem { [weak self] in self?.close() }
    deadline = item
    queue.asyncAfter(deadline: .now() + Self.retireDeadline, execute: item)
    flush()
    guard !closed else { return }
    stopReading()
  }

  private func announce() {
    guard !announced else { return }
    announced = true
    onClose(self)
  }

  func close() {
    guard !closed else { return }
    closed = true
    deadline?.cancel()
    deadline = nil
    if let writeSource {
      if !writeArmed { writeSource.resume() }
      writeSource.cancel()
    }
    stopReading()
    let unwritten = output.takeFinishedTickets() + output.waitingTickets
    output = ControlOutput()
    input = []
    roomWaiters = []
    announce()
    report(unwritten)
    Self.retiring.removeAll { $0 === self }
  }

  private func stopReading() {
    guard let source = readSource else { return }
    readSource = nil
    if readSuspended {
      readSuspended = false
      source.resume()
    }
    source.cancel()
  }

  private func report(_ tickets: [Int]) {
    if !tickets.isEmpty { onWritten(tickets) }
  }

  private func adopt(_ source: DispatchSourceProtocol) {
    openSources += 1
    source.setCancelHandler { [self] in
      openSources -= 1
      if openSources == 0 { Darwin.close(fd) }
    }
  }

  private func enqueue(_ accepted: Bool) {
    guard accepted else { return retire() }
    if !writeArmed { flush() }
  }

  private func flush() {
    let result = output.write(to: fd)
    report(output.takeFinishedTickets())
    defer { wakeRoomWaiters() }
    switch result {
    case .drained:
      if finishingLine { return close() }
      disarmWrite()
      closeIfDrained()
    case .blocked:
      armWrite()
    case .failed:
      close()
    }
  }

  private func armWrite() {
    guard !writeArmed else { return }
    writeArmed = true
    if let writeSource {
      writeSource.resume()
      return
    }
    let source = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in self?.flush() }
    adopt(source)
    writeSource = source
    source.activate()
  }

  private func disarmWrite() {
    guard writeArmed, let writeSource else { return }
    writeArmed = false
    writeSource.suspend()
  }

  private func readAvailable() {
    guard !closed, !finishingLine else { return }
    var buffer = [UInt8](repeating: 0, count: Self.readSize)
    let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, Self.readSize) }
    if count > 0 { return take(buffer[0..<count]) }
    if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { return }
    if count == 0 { return drainAfterPeerClosed() }
    close()
  }

  private func drainAfterPeerClosed() {
    draining = true
    onPeerFinished(self)
    output.keepOnlyReplies()
    if !readSuspended {
      readSuspended = true
      readSource?.suspend()
    }
    input = []
    deadline?.cancel()
    let item = DispatchWorkItem { [weak self] in self?.close() }
    deadline = item
    queue.asyncAfter(deadline: .now() + Self.retireDeadline, execute: item)
    closeIfDrained()
  }

  private func closeIfDrained() {
    guard draining, !closed, output.isEmpty, pendingRequests == 0 else { return }
    close()
  }

  private func take(_ bytes: ArraySlice<UInt8>) {
    let scanFrom = input.count
    input.append(contentsOf: bytes)
    var lineStart = 0
    var index = scanFrom
    var consumed = false
    while let newline = input[index...].firstIndex(of: 10) {
      let length = newline - lineStart
      guard length <= Self.maxLine else { return retire() }
      pendingRequests += 1
      guard pendingRequests <= Self.maxPendingRequests else { return retire() }
      onLine(self, String(decoding: input[lineStart..<newline], as: UTF8.self))
      if closed { return }
      lineStart = newline + 1
      index = lineStart
      consumed = true
    }
    if lineStart > 0 { input.removeFirst(lineStart) }
    guard input.count <= Self.maxLine else { return retire() }
    if input.isEmpty || consumed {
      deadline?.cancel()
      deadline = nil
    }
    if !input.isEmpty && deadline == nil { armDeadline() }
  }

  private func armDeadline() {
    let item = DispatchWorkItem { [weak self] in
      guard let self, !self.closed, !self.input.isEmpty else { return }
      self.retire()
    }
    deadline = item
    queue.asyncAfter(deadline: .now() + Self.lineDeadline, execute: item)
  }
}

