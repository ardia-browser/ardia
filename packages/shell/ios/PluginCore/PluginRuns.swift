import Foundation

protocol PluginRun: AnyObject {
  var name: String { get }
  var run: Int { get }
  var exited: Bool { get }
  func stop(graceMs: Int, done: @escaping () -> Void)
}

final class PluginRuns<Run: PluginRun> {
  private(set) var current: [String: Run] = [:]
  private var retiring: [ObjectIdentifier: Run] = [:]

  var all: [Run] { Array(current.values) + Array(retiring.values) }

  func removeAll() {
    current.removeAll()
    retiring.removeAll()
  }

  func installed(_ run: Run) {
    current[run.name] = run
  }

  func exited(_ run: Run) {
    if current[run.name] === run { current.removeValue(forKey: run.name) }
    retiring.removeValue(forKey: ObjectIdentifier(run))
  }

  private func retire(_ name: String) {
    guard let run = current.removeValue(forKey: name) else { return }
    if !run.exited { retiring[ObjectIdentifier(run)] = run }
  }

  func stopAll(_ name: String, onlyRun: Int = 0, graceMs: Int, done: @escaping () -> Void) {
    if let run = current[name], onlyRun == 0 || run.run == onlyRun { retire(name) }
    let stopping = retiring.values.filter { $0.name == name && (onlyRun == 0 || $0.run == onlyRun) }
    guard !stopping.isEmpty else { return done() }
    var left = stopping.count
    for run in stopping {
      run.stop(graceMs: graceMs) {
        left -= 1
        if left == 0 { done() }
      }
    }
  }
}
