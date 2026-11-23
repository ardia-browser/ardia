import Darwin
import Foundation
import os

final class VaultCommand: @unchecked Sendable {
  static let outputLimit = 32 * 1024 * 1024
  static let errorLimit = 1024 * 1024
  static let killDelay: TimeInterval = 2
  static let drainDelay: TimeInterval = 2

  private let executable: String
  private let arguments: [String]
  private let environment: [String: String]
  private let input: Data?
  private let timeout: TimeInterval
  private let onOutput: (@Sendable (String) -> Void)?
  private let onLine: (@Sendable (_ fromErrors: Bool, _ line: String) -> Void)?
  private let lineLimit: Int
  private let outputLimit: Int
  private let queue = DispatchQueue(label: "dev.ardia.vaults.command")
  private static let feeding = DispatchQueue(label: "dev.ardia.vaults.command.input", attributes: .concurrent)
  private let lock = NSLock()
  private static let live = OSAllocatedUnfairLock(initialState: [ObjectIdentifier: VaultCommand]())
  private static let escalating = OSAllocatedUnfairLock(initialState: [ObjectIdentifier: VaultCommand]())

  private var process: Process?
  private var outputPipe: Pipe?
  private var errorPipe: Pipe?
  private var timer: DispatchSourceTimer?
  private var completion: (@Sendable (VaultCommandResult) -> Void)?
  private var output = Data()
  private var errors = Data()
  private var outputClosed = false
  private var errorsClosed = false
  private var exitStatus: Int32?
  private var started = false
  private var finished = false
  private var timedOut = false
  private var cancelled = false
  private var overflowed = false
  private var incomplete = false
  private var leadsGroup = false
  private var pendingKills = 0
  private var partialOutputLine = Data()
  private var partialErrorLine = Data()

  init(executable: String, arguments: [String], environment: [String: String], input: Data?, timeout: TimeInterval,
       outputLimit: Int = VaultCommand.outputLimit, onOutput: (@Sendable (String) -> Void)? = nil,
       lineLimit: Int = 16 * 1024, onLine: (@Sendable (_ fromErrors: Bool, _ line: String) -> Void)? = nil) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.input = input
    self.timeout = timeout
    self.onOutput = onOutput
    self.outputLimit = outputLimit
    self.onLine = onLine
    self.lineLimit = lineLimit
  }

  static var running: Int { live.withLock { $0.count } }

  static func haltAll(waiting grace: TimeInterval = 0.5) {
    let commands = live.withLock { Array($0.values) }
    for command in commands { command.cancel() }
    let deadline = Date().addingTimeInterval(grace)
    while Date() < deadline, live.withLock({ !$0.isEmpty }) { usleep(10_000) }
    let unfinished = live.withLock { Array($0.values) }
    let stopping = escalating.withLock { Array($0.values) }
    for command in unfinished + stopping { command.killGroup(SIGKILL) }
  }

  func run() async -> VaultCommandResult {
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        start { continuation.resume(returning: $0) }
      }
    } onCancel: {
      cancel()
    }
  }

  func start(_ completion: @escaping @Sendable (VaultCommandResult) -> Void) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    let outputPipe = Pipe()
    let errorPipe = Pipe()
    let inputPipe: Pipe? = input == nil ? nil : Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe
    if let inputPipe {
      process.standardInput = inputPipe
    } else {
      process.standardInput = FileHandle.nullDevice
    }

    lock.lock()
    if started || cancelled {
      let refused = cancelled ? VaultCommandResult.cancelledBeforeLaunch : .notLaunched
      lock.unlock()
      return completion(refused)
    }
    started = true
    self.process = process
    self.outputPipe = outputPipe
    self.errorPipe = errorPipe
    self.completion = completion
    lock.unlock()

    outputPipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        self.closed(errors: false)
      } else {
        self.received(data, errors: false)
      }
    }
    errorPipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        self.closed(errors: true)
      } else {
        self.received(data, errors: true)
      }
    }
    process.terminationHandler = { ended in self.exited(ended.terminationStatus) }

    Self.live.withLock { $0[ObjectIdentifier(self)] = self }
    do {
      try process.run()
    } catch {
      process.terminationHandler = nil
      finish(launched: false)
      return
    }

    let pid = process.processIdentifier
    let leads = getpgid(pid) == pid
    lock.lock()
    leadsGroup = leads
    lock.unlock()

    if let inputPipe, let input {
      let handle = inputPipe.fileHandleForWriting
      Self.feeding.async { Self.feed(input, to: handle) }
    }

    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + timeout)
    timer.setEventHandler { self.stop(timedOut: true) }
    timer.resume()
    lock.lock()
    let alreadyFinished = finished
    if !alreadyFinished { self.timer = timer }
    lock.unlock()
    if alreadyFinished { timer.cancel() }
  }

  func cancel() { stop(timedOut: false) }

  private func stop(timedOut: Bool) {
    lock.lock()
    guard started else {
      if !timedOut { cancelled = true }
      lock.unlock()
      return
    }
    guard !finished, let process = self.process else {
      lock.unlock()
      return
    }
    if exitStatus == nil {
      if timedOut { self.timedOut = true } else { cancelled = true }
    }
    lock.unlock()
    halt(process)
  }

  private func halt(_ process: Process) {
    lock.lock()
    pendingKills += 1
    lock.unlock()
    signalGroup(of: process, SIGTERM)
    queue.asyncAfter(deadline: .now() + Self.killDelay) {
      self.signalGroup(of: process, SIGKILL)
      self.killSent()
    }
  }

  private func killSent() {
    lock.lock()
    pendingKills -= 1
    if finished && pendingKills == 0 {
      process = nil
      Self.escalating.withLock { _ = $0.removeValue(forKey: ObjectIdentifier(self)) }
    }
    lock.unlock()
  }

  private func killGroup(_ signal: Int32) {
    lock.lock()
    let process = self.process
    lock.unlock()
    if let process { signalGroup(of: process, signal) }
  }

  private func signalGroup(of process: Process, _ signal: Int32) {
    let pid = process.processIdentifier
    lock.lock()
    let leadsGroup = self.leadsGroup && (!finished || pendingKills > 0)
    let exited = exitStatus != nil
    lock.unlock()
    guard pid > 0 else { return }
    if leadsGroup { kill(-pid, signal) }
    if !exited && process.isRunning { kill(pid, signal) }
  }

  private func received(_ data: Data, errors isErrors: Bool) {
    var snapshot: String?
    var runaway: Process?
    var lines: [String] = []
    lock.lock()
    if onLine != nil { lines = splitLines(data, errors: isErrors, flush: false) }
    if isErrors {
      let room = Self.errorLimit - errors.count
      if room > 0 { errors.append(data.prefix(room)) }
      if onOutput != nil { snapshot = shownOutput() }
    } else if output.count + data.count > outputLimit {
      if !overflowed && exitStatus == nil { runaway = process }
      overflowed = true
    } else {
      output.append(data)
      if onOutput != nil { snapshot = shownOutput() }
    }
    lock.unlock()
    if let runaway { halt(runaway) }
    if let snapshot { onOutput?(snapshot) }
    for line in lines { onLine?(isErrors, line) }
  }

  private func splitLines(_ data: Data, errors isErrors: Bool, flush: Bool) -> [String] {
    var partial = isErrors ? partialErrorLine : partialOutputLine
    partial.append(data)
    var lines: [String] = []
    while let newline = partial.firstIndex(of: 10) {
      lines.append(String(decoding: partial[partial.startIndex..<newline].prefix(lineLimit), as: UTF8.self))
      partial = Data(partial[partial.index(after: newline)...])
    }
    if flush, !partial.isEmpty {
      lines.append(String(decoding: partial.prefix(lineLimit), as: UTF8.self))
      partial = Data()
    }
    if partial.count > lineLimit * 4 { partial = Data(partial.prefix(lineLimit)) }
    if isErrors { partialErrorLine = partial } else { partialOutputLine = partial }
    return lines
  }

  private func shownOutput() -> String {
    String(decoding: output, as: UTF8.self) + "\n" + String(decoding: errors, as: UTF8.self)
  }

  private func closed(errors isErrors: Bool) {
    lock.lock()
    if isErrors { errorsClosed = true } else { outputClosed = true }
    let ready = exitStatus != nil && outputClosed && errorsClosed
    let rest = onLine == nil ? [] : splitLines(Data(), errors: isErrors, flush: true)
    lock.unlock()
    for line in rest { onLine?(isErrors, line) }
    if ready { finish(launched: true) }
  }

  private func exited(_ status: Int32) {
    lock.lock()
    exitStatus = status
    let ready = outputClosed && errorsClosed
    lock.unlock()
    if ready {
      finish(launched: true)
    } else {
      queue.asyncAfter(deadline: .now() + Self.drainDelay) { self.drainExpired() }
    }
  }

  private func drainExpired() {
    lock.lock()
    if !(outputClosed && errorsClosed) { incomplete = true }
    lock.unlock()
    finish(launched: true)
  }

  private func finish(launched: Bool) {
    lock.lock()
    if finished {
      lock.unlock()
      return
    }
    finished = true
    let result = VaultCommandResult(
      status: exitStatus ?? -1, stdout: overflowed ? Data() : output, stderr: String(decoding: errors, as: UTF8.self), launched: launched,
      timedOut: timedOut, cancelled: cancelled, overflowed: overflowed, incomplete: incomplete)
    let completion = self.completion
    let timer = self.timer
    let outputPipe = self.outputPipe
    let errorPipe = self.errorPipe
    self.completion = nil
    self.timer = nil
    self.outputPipe = nil
    self.errorPipe = nil
    if pendingKills > 0 {
      Self.escalating.withLock { $0[ObjectIdentifier(self)] = self }
    } else {
      self.process = nil
    }
    output = Data()
    errors = Data()
    lock.unlock()
    Self.live.withLock { _ = $0.removeValue(forKey: ObjectIdentifier(self)) }

    timer?.cancel()
    for pipe in [outputPipe, errorPipe].compactMap({ $0 }) {
      pipe.fileHandleForReading.readabilityHandler = nil
      try? pipe.fileHandleForReading.close()
    }
    completion?(result)
  }

  private static func feed(_ data: Data, to handle: FileHandle) {
    let descriptor = handle.fileDescriptor
    _ = fcntl(descriptor, F_SETNOSIGPIPE, 1)
    data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard let base = buffer.baseAddress else { return }
      var offset = 0
      while offset < buffer.count {
        let written = Darwin.write(descriptor, base + offset, buffer.count - offset)
        if written > 0 {
          offset += written
        } else if written < 0 && errno == EINTR {
          continue
        } else {
          break
        }
      }
    }
    try? handle.close()
  }
}
