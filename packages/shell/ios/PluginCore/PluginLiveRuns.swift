import Foundation

final class PluginLiveRuns {
  private let lock = NSLock()
  private var live: Set<String> = []

  private static func key(_ name: String, _ run: Int) -> String { "\(name)#\(run)" }

  func replace(with runs: [(name: String, run: Int)]) {
    let next = Set(runs.map { Self.key($0.name, $0.run) })
    lock.lock()
    live = next
    lock.unlock()
  }

  func markClosed(_ name: String, run: Int) {
    lock.lock()
    live.remove(Self.key(name, run))
    lock.unlock()
  }

  func contains(_ name: String, run: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return live.contains(Self.key(name, run))
  }
}
