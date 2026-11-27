import Darwin
import Foundation

final class ControlRetirements {
  private static let lock = NSLock()
  private static var byQueue: [ObjectIdentifier: ControlRetirements] = [:]

  static func of(_ queue: DispatchQueue) -> ControlRetirements {
    lock.withLock {
      if let known = byQueue[ObjectIdentifier(queue)] { return known }
      let made = ControlRetirements()
      byQueue[ObjectIdentifier(queue)] = made
      return made
    }
  }

  private let guarded = NSLock()
  private var connections: [ControlConnection] = []

  private init() {}

  var count: Int { guarded.withLock { connections.count } }

  func holds(_ connection: ControlConnection) -> Bool { guarded.withLock { connections.contains { $0 === connection } } }

  func add(_ connection: ControlConnection, keepingAtMost limit: Int) {
    let oldest = guarded.withLock { () -> ControlConnection? in
      connections.append(connection)
      return connections.count > limit ? connections.first : nil
    }
    oldest?.close()
  }

  func remove(_ connection: ControlConnection) {
    guarded.withLock { connections.removeAll { $0 === connection } }
  }
}

final class ControlConnection {
  enum RetireReason: String, CaseIterable {
    case lineTooLong = "line_too_long"
    case tooManyRequests = "too_many_requests"
    case replyBacklog = "reply_backlog"
    case sendBacklog = "send_backlog"
    case lineDeadline = "line_deadline"
    case stalled
    case closed

    var explanation: String {
      switch self {
      case .lineTooLong: return "it sent a line over the line limit"
      case .tooManyRequests: return "it sent more requests than Ardia takes at once"
      case .replyBacklog: return "the replies it hadn't read filled the channel"
      case .sendBacklog: return "the messages for it that it hadn't read filled the channel"
      case .lineDeadline: return "a line it started didn't finish in 30 s"
      case .stalled: return "it read nothing and answered nothing for 30 s while Ardia waited"
      case .closed: return "Ardia closed it"
      }
    }
  }

  static let maxLine = 1_048_576
  static let maxPendingRequests = 32
  static let lineDeadline: TimeInterval = 30
  static let retireDeadline: TimeInterval = 5
  static let maxRetiring = 16
  private static let readSize = 65536
  static let pauseAt = ControlOutput.maxBytes / 2

  let id: Int
  let lineLimit: Int
  private let fd: Int32
  private let queue: DispatchQueue
  let retiring: ControlRetirements
  private let onLine: (ControlConnection, String) -> Void
  private let onClose: (ControlConnection) -> Void
  private let onWritten: ([Int]) -> Void
  private let onPeerFinished: (ControlConnection) -> Void
  private let mayWrite: (ControlConnection) -> Bool
  private let onRetire: (ControlConnection, RetireReason) -> Void
  let paced: Bool
  private(set) var retiredBecause: RetireReason?
  private(set) var paused = false
  private var stall: DispatchWorkItem?
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var writeArmed = false
  private var openSources = 0
  private var input: [UInt8] = []
  private var output: ControlOutput
  private var pendingRequests = 0
  private var deadline: DispatchWorkItem?
  private(set) var closed = false
  private var finishingLine = false
  private var draining = false
  private var readSuspended = false
  private var announced = false

  init(
    id: Int, fd: Int32, queue: DispatchQueue, onLine: @escaping (ControlConnection, String) -> Void,
    onClose: @escaping (ControlConnection) -> Void, onWritten: @escaping ([Int]) -> Void,
    onPeerFinished: @escaping (ControlConnection) -> Void = { _ in },
    mayWrite: @escaping (ControlConnection) -> Bool = { _ in true }, lineLimit: Int = ControlConnection.maxLine, paced: Bool = false,
    onRetire: @escaping (ControlConnection, RetireReason) -> Void = { _, _ in }
  ) {
    self.id = id
    self.lineLimit = lineLimit
    self.paced = paced
    self.onRetire = onRetire
    output = ControlOutput(lineLimit: lineLimit, ceiling: Self.ceiling(lineLimit: lineLimit, paced: paced))
    self.fd = fd
    self.queue = queue
    retiring = ControlRetirements.of(queue)
    self.onLine = onLine
    self.onClose = onClose
    self.onWritten = onWritten
    self.onPeerFinished = onPeerFinished
    self.mayWrite = mayWrite
  }

  static func ceiling(lineLimit: Int, paced: Bool) -> Int {
    paced ? ControlOutput.maxBytes + 4 * lineLimit : ControlOutput.maxBytes
  }

  var queuedBytes: Int { output.bytes }

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
      return retire(.replyBacklog)
    }
    noteProgress()
    if !writeArmed { flush() }
    resumeIfRoom()
  }

  func send(_ data: Data) {
    guard !closed, !finishingLine, !draining else { return }
    guard output.addKept(data) else { return retire(.sendBacklog) }
    if !writeArmed { flush() }
  }

  func event(_ data: Data) {
    guard !closed, !finishingLine, !draining else { return }
    enqueue(output.addEvent(data))
  }

  func retire(_ reason: RetireReason = .closed) {
    guard !closed, !finishingLine else { return }
    if retiredBecause == nil {
      retiredBecause = reason
      onRetire(self, reason)
    }
    stall?.cancel()
    stall = nil
    paused = false
    guard output.midLine else { return close() }
    finishingLine = true
    deadline?.cancel()
    input = []
    report(output.keepOnlyHead())
    announce()
    retiring.add(self, keepingAtMost: Self.maxRetiring)
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
    stall?.cancel()
    stall = nil
    paused = false
    if let writeSource {
      if !writeArmed { writeSource.resume() }
      writeSource.cancel()
    }
    stopReading()
    let unwritten = output.takeFinishedTickets() + output.waitingTickets
    output = ControlOutput(lineLimit: lineLimit, ceiling: Self.ceiling(lineLimit: lineLimit, paced: paced))
    input = []
    announce()
    report(unwritten)
    retiring.remove(self)
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
    guard accepted else { return retire(.sendBacklog) }
    if !writeArmed { flush() }
  }

  private func flush() {
    var result = ControlOutput.WriteResult.lineDone
    let before = output.bytes
    defer {
      if !closed && output.bytes < before {
        noteProgress()
        resumeIfRoom()
      }
    }
    while result == .lineDone {
      guard !closed, finishingLine || mayWrite(self) else { return }
      result = output.write(to: fd, oneLine: true)
      report(output.takeFinishedTickets())
    }
    switch result {
    case .drained, .lineDone:
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

  private var mustWait: Bool {
    paced && (pendingRequests >= Self.maxPendingRequests || output.bytes >= Self.pauseAt)
  }

  private func pause() {
    guard !paused, !closed, !finishingLine, !draining else { return }
    paused = true
    if !readSuspended {
      readSuspended = true
      readSource?.suspend()
    }
    deadline?.cancel()
    deadline = nil
    armStall()
  }

  private func resumeIfRoom() {
    guard paused, !closed, !finishingLine, !draining, !mustWait else { return }
    paused = false
    stall?.cancel()
    stall = nil
    scan(from: 0)
    guard !closed, !finishingLine, !paused, readSuspended, let readSource else { return }
    readSuspended = false
    readSource.resume()
  }

  private func noteProgress() {
    if paused { armStall() }
  }

  private func armStall() {
    stall?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.paused, !self.closed else { return }
      self.retire(self.pendingRequests >= Self.maxPendingRequests ? .tooManyRequests : .stalled)
    }
    stall = item
    queue.asyncAfter(deadline: .now() + Self.lineDeadline, execute: item)
  }

  private func take(_ bytes: ArraySlice<UInt8>) {
    let scanFrom = input.count
    input.append(contentsOf: bytes)
    scan(from: scanFrom)
  }

  private func scan(from scanFrom: Int) {
    var lineStart = 0
    var index = scanFrom
    var consumed = false
    while !mustWait, let newline = input[index...].firstIndex(of: 10) {
      let length = newline - lineStart
      guard length <= lineLimit else { return retire(.lineTooLong) }
      pendingRequests += 1
      guard paced || pendingRequests <= Self.maxPendingRequests else { return retire(.tooManyRequests) }
      onLine(self, String(decoding: input[lineStart..<newline], as: UTF8.self))
      if closed || finishingLine { return }
      lineStart = newline + 1
      index = lineStart
      consumed = true
    }
    if lineStart > 0 { input.removeFirst(lineStart) }
    if mustWait && !input.isEmpty { return pause() }
    guard input.count <= lineLimit else { return retire(.lineTooLong) }
    if input.isEmpty || consumed {
      deadline?.cancel()
      deadline = nil
    }
    if !input.isEmpty && deadline == nil { armDeadline() }
  }

  private func armDeadline() {
    let item = DispatchWorkItem { [weak self] in
      guard let self, !self.closed, !self.paused, !self.input.isEmpty else { return }
      self.retire(.lineDeadline)
    }
    deadline = item
    queue.asyncAfter(deadline: .now() + Self.lineDeadline, execute: item)
  }
}

