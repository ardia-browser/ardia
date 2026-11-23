import ArdiaCore
import Foundation

final class PluginCredentialLink: CredentialPluginLink, @unchecked Sendable {
  static let pacedBufferBytes = 8 << 20

  private let queue: DispatchQueue
  private weak var process: PluginProcess?
  private let forwardLine: (PluginProcess, String) -> Void
  private let stop: (PluginProcess) -> Void
  private var pending: [Data] = []
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
      pending.append(data)
      pump()
    }
  }

  func sendPaced(_ lines: [String], then: @escaping @Sendable (Bool) -> Void) {
    let framed = lines.map(Self.framed)
    queue.async { [self] in
      pending.append(contentsOf: framed)
      finishing.append((pending.count, then))
      pump()
    }
  }

  private func pump() {
    guard let connection = process?.connection, !connection.closed else {
      pending = []
      let done = finishing
      finishing = []
      done.forEach { $0.done(false) }
      return
    }
    var sent = 0
    while !pending.isEmpty, connection.bufferedBytes < Self.pacedBufferBytes {
      connection.send(pending.removeFirst())
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
