import Foundation

final class PluginRunTable<Value> {
  enum Admission: Equatable {
    case admitted(UInt64)
    case closed
    case taken
    case full
    case failed
  }

  private struct Entry {
    let token: UInt64
    var value: Value?
  }

  private let lock = NSRecursiveLock()
  private var entries: [String: Entry] = [:]
  private var issued: [String: UInt64] = [:]
  private static var maxIssued: Int { 4096 }
  private var closedRuns: [String] = []
  private var lastToken: UInt64 = 0
  private let maxClosedRuns: Int

  init(maxClosedRuns: Int = 1024) {
    self.maxClosedRuns = maxClosedRuns
  }

  static func runKey(_ name: String, _ run: Int) -> String { "\(name)#\(run)" }
  static func key(_ name: String, _ run: Int, _ id: String) -> String { "\(runKey(name, run))/\(id)" }

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  func isClosed(_ name: String, _ run: Int) -> Bool {
    locked { closedRuns.contains(Self.runKey(name, run)) }
  }

  func admit(_ name: String, _ run: Int, _ id: String, cap: Int, live: () -> Bool = { true }, make: (UInt64) -> Value?) -> Admission {
    locked {
      let runKey = Self.runKey(name, run)
      if closedRuns.contains(runKey) || !live() { return .closed }
      let key = Self.key(name, run, id)
      if entries[key] != nil { return .taken }
      if entries.keys.filter({ $0.hasPrefix(runKey + "/") }).count >= cap { return .full }
      lastToken += 1
      let token = lastToken
      entries[key] = Entry(token: token, value: nil)
      if issued.count >= Self.maxIssued { issued = issued.filter { entries[$0.key] != nil } }
      issued[key] = token
      guard let value = make(token) else {
        if entries[key]?.token == token { entries[key] = nil }
        return .failed
      }
      guard entries[key]?.token == token else { return .failed }
      entries[key]?.value = value
      return .admitted(token)
    }
  }

  func current(_ name: String, _ run: Int, _ id: String, token: UInt64) -> Bool {
    locked { entries[Self.key(name, run, id)]?.token == token }
  }

  func untaken(_ name: String, _ run: Int, _ id: String, by token: UInt64) -> Bool {
    locked {
      let key = Self.key(name, run, id)
      return entries[key].map { $0.token == token } ?? (issued[key] == token)
    }
  }

  func value(_ name: String, _ run: Int, _ id: String) -> Value? {
    locked { entries[Self.key(name, run, id)]?.value }
  }

  @discardableResult
  func remove(_ name: String, _ run: Int, _ id: String, token: UInt64) -> Bool {
    locked {
      let key = Self.key(name, run, id)
      guard entries[key]?.token == token else { return false }
      entries[key] = nil
      return true
    }
  }

  func removeValue(_ name: String, _ run: Int, _ id: String, token: UInt64) -> Value? {
    locked {
      let key = Self.key(name, run, id)
      guard let entry = entries[key], entry.token == token else { return nil }
      entries[key] = nil
      return entry.value
    }
  }

  func take(_ name: String, _ run: Int, _ id: String) -> (token: UInt64, value: Value?)? {
    locked {
      guard let entry = entries.removeValue(forKey: Self.key(name, run, id)) else { return nil }
      return (entry.token, entry.value)
    }
  }

  func closeRun(_ name: String, run: Int) -> [Value] {
    locked {
      let prefix = run == 0 ? "\(name)#" : Self.runKey(name, run) + "/"
      if run != 0 {
        closedRuns.append(Self.runKey(name, run))
        if closedRuns.count > maxClosedRuns { closedRuns.removeFirst(closedRuns.count - maxClosedRuns) }
      }
      let closing = entries.filter { $0.key.hasPrefix(prefix) }
      for key in closing.keys { entries[key] = nil }
      for key in issued.keys where key.hasPrefix(prefix) { issued[key] = nil }
      return closing.values.compactMap(\.value)
    }
  }

  func count(_ name: String) -> Int {
    locked { entries.keys.filter { $0.hasPrefix("\(name)#") }.count }
  }
}
