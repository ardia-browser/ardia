import ArdiaCore
import Foundation

final class PluginCredentialLink: CredentialPluginLink, @unchecked Sendable {
  static let pacedBufferBytes = 8 << 20
  static let pendingBytes = 192 << 20

  private let queue: DispatchQueue
  private weak var process: PluginProcess?
  private let forwardLine: (PluginProcess, String) -> Void
  private let stop: (PluginProcess) -> Void
  private var pending: [Data] = []
  private var budget = PluginPendingBudget(limit: PluginCredentialLink.pendingBytes)
  private var finishing: [(remaining: Int, done: @Sendable (Bool) -> Void)] = []
  private var waiting = false

  init(queue: DispatchQueue, process: PluginProcess, forward: @escaping (PluginProcess, String) -> Void, stop: @escaping (PluginProcess) -> Void) {
    self.queue = queue
    self.process = process
    forwardLine = forward
    self.stop = stop
  }

  private static func framed(_ line: String) -> Data {
    var data = Data(line.utf8)
    data.append(10)
    return data
  }

  func send(_ line: String) {
    let data = Self.framed(line)
    queue.async { [self] in
      _ = budget.admit(data.count)
      pending.append(data)
      pump()
    }
  }

  func sendPaced(_ lines: [String], then: @escaping @Sendable (Bool) -> Void) {
    let framed = lines.map(Self.framed)
    let size = framed.reduce(0) { $0 + $1.count }
    queue.async { [self] in
      guard budget.admit(size) else { return then(false) }
      pending.append(contentsOf: framed)
      finishing.append((pending.count, then))
      pump()
    }
  }

  private func pump() {
    guard let connection = process?.connection, !connection.closed else {
      pending = []
      budget.reset()
      let done = finishing
      finishing = []
      done.forEach { $0.done(false) }
      return
    }
    var sent = 0
    while !pending.isEmpty, connection.bufferedBytes < Self.pacedBufferBytes {
      let line = pending.removeFirst()
      budget.release(line.count)
      connection.send(line)
      sent += 1
    }
    if sent > 0 {
      finishing = finishing.map { ($0.remaining - sent, $0.done) }
      let done = finishing.filter { $0.remaining <= 0 }
      finishing.removeAll { $0.remaining <= 0 }
      done.forEach { $0.done(true) }
    }
    guard !pending.isEmpty, !waiting else { return }
    waiting = true
    connection.whenRoom(below: Self.pacedBufferBytes) { [weak self] in
      guard let self else { return }
      waiting = false
      pump()
    }
  }

  func forward(_ line: String) {
    queue.async { [self] in
      guard let process else { return }
      forwardLine(process, line)
    }
  }

  func stopRun() {
    queue.async { [self] in
      guard let process else { return }
      stop(process)
    }
  }
}
