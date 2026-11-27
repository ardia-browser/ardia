import Foundation

final class ApplePasswordsPipe: @unchecked Sendable {
  static let maxMessageBytes = 1 << 20
  static let killedAtLaunchSeconds: TimeInterval = 2

  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private let lock = NSLock()
  private let drainLock = NSLock()
  private var buffer = Data()
  private var ended = false
  private var stopped = false
  private var startedAt = Date()
  private(set) var killedByMacOS = false
  var onMessage: (([String: Any]) -> Void)?
  var onExit: (() -> Void)?

  init(program: URL, origin: String) {
    process.executableURL = program
    process.arguments = [origin]
    process.standardInput = input.fileHandleForReading
    process.standardOutput = output.fileHandleForWriting
    process.standardError = FileHandle.nullDevice
    process.environment = LaunchConfig.shared.environmentForChildProcesses
    _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
  }

  var hasEnded: Bool { lock.withLock { ended } }

  func start() throws {
    let fd = output.fileHandleForReading.fileDescriptor
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    output.fileHandleForReading.readabilityHandler = { [weak self] _ in self?.drain() }
    process.terminationHandler = { [weak self] process in
      guard let self else { return }
      let killed = self.lock.withLock {
        process.terminationReason == .uncaughtSignal && process.terminationStatus == SIGKILL
          && Date().timeIntervalSince(self.startedAt) < Self.killedAtLaunchSeconds && !self.stopped
      }
      self.drain()
      self.finish(killed: killed)
    }
    lock.withLock { startedAt = Date() }
    try process.run()
    try? input.fileHandleForReading.close()
    try? output.fileHandleForWriting.close()
  }

  func write(_ message: [String: Any]) throws {
    let json = try JSONSerialization.data(withJSONObject: message)
    guard json.count <= Self.maxMessageBytes, !hasEnded else { throw ApplePasswordsPipeEnded() }
    var length = UInt32(json.count).littleEndian
    var frame = Data(bytes: &length, count: 4)
    frame.append(json)
    try input.fileHandleForWriting.write(contentsOf: frame)
  }

  func stop() {
    lock.withLock { stopped = true }
    try? input.fileHandleForWriting.close()
    let process = self.process
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
  }

  private func drain() {
    drainLock.lock()
    defer { drainLock.unlock() }
    let fd = output.fileHandleForReading.fileDescriptor
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = Darwin.read(fd, &chunk, chunk.count)
      if count > 0 {
        take(Data(chunk.prefix(count)))
        continue
      }
      if count < 0 && errno == EINTR { continue }
      if count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK) { output.fileHandleForReading.readabilityHandler = nil }
      return
    }
  }

  private func take(_ data: Data) {
    var heard: [[String: Any]] = []
    lock.withLock {
      buffer.append(data)
      while buffer.count >= 4 {
        let length = Int(buffer.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian })
        guard buffer.count >= 4 + length else { break }
        let body = buffer.subdata(in: buffer.startIndex + 4..<buffer.startIndex + 4 + length)
        buffer.removeSubrange(buffer.startIndex..<buffer.startIndex + 4 + length)
        if let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] { heard.append(message) }
      }
    }
    heard.forEach { onMessage?($0) }
  }

  private func finish(killed: Bool) {
    let exit: (() -> Void)? = lock.withLock {
      guard !ended else { return nil }
      ended = true
      killedByMacOS = killed
      return onExit
    }
    output.fileHandleForReading.readabilityHandler = nil
    try? input.fileHandleForWriting.close()
    exit?()
  }
}

struct ApplePasswordsPipeEnded: Error {}
