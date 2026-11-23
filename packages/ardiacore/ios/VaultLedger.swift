import Foundation

struct VaultLedgerEntry: Codable, Equatable, Sendable {
  var value: String?
  var stamp: Int64
  var device: String

  func beats(_ other: VaultLedgerEntry) -> Bool {
    if stamp != other.stamp { return stamp > other.stamp }
    if device != other.device { return device > other.device }
    switch (value, other.value) {
    case (nil, nil): return false
    case (nil, _): return false
    case (_, nil): return true
    case (let mine?, let theirs?): return mine > theirs
    }
  }
}

struct VaultLedger: Codable, Equatable, Sendable {
  var entries: [String: VaultLedgerEntry] = [:]

  var values: [String: String] { entries.compactMapValues(\.value) }

  func value(_ key: String) -> String? { entries[key]?.value }

  func isRemoved(_ key: String) -> Bool { entries[key].map { $0.value == nil } ?? false }

  static func stamp(at time: Double, after known: Int64?) -> Int64 {
    let wall = time.isFinite ? Int64(max(0, min(time * 1000, Double(Int64.max / 2)))) : 0
    guard let known else { return wall }
    let next = known == Int64.max ? known : known + 1
    return max(wall, next)
  }

  @discardableResult
  mutating func set(_ key: String, _ value: String?, at time: Double, device: String) -> Bool {
    let known = entries[key]
    if known == nil && value == nil { return false }
    if let known, known.value == value { return false }
    entries[key] = VaultLedgerEntry(value: value, stamp: Self.stamp(at: time, after: known?.stamp), device: device)
    return true
  }

  @discardableResult
  mutating func merge(_ other: VaultLedger) -> Bool {
    var changed = false
    for (key, theirs) in other.entries {
      if let mine = entries[key], !theirs.beats(mine) { continue }
      entries[key] = theirs
      changed = true
    }
    return changed
  }
}
