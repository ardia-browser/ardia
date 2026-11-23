import Foundation

struct VaultUsageEntry: Codable, Equatable, Sendable {
  var lastUsed: Double
  var score: Double
  var scoredAt: Double
}

struct VaultUsageBook: Codable, Equatable, Sendable {
  static let halfLife: Double = 30 * 24 * 3600 * 1000
  static let editedRecently: Double = 14 * 24 * 3600 * 1000
  static let sitesKept = 2000
  static let itemsPerSite = 64

  var version = 1
  var sites: [String: [String: VaultUsageEntry]] = [:]
  var edited: [String: Double] = [:]

  static func siteKey(profile: String?, origin: String) -> String? {
    guard let host = VaultOriginMatch.host(of: origin) else { return nil }
    return "\(profile ?? "")\n\(VaultOriginMatch.siteKey(host))"
  }

  static func itemKey(_ item: VaultItem) -> String { "\(item.provider)/\(item.id)" }

  static func decayed(_ entry: VaultUsageEntry, now: Double) -> Double {
    entry.score * pow(0.5, max(0, now - entry.scoredAt) / halfLife)
  }

  mutating func noteFill(profile: String?, origin: String, item key: String, now: Double) {
    guard let site = Self.siteKey(profile: profile, origin: origin) else { return }
    var entries = sites[site] ?? [:]
    let earlier = entries[key]
    let score = earlier.map { Self.decayed($0, now: now) } ?? 0
    entries[key] = VaultUsageEntry(lastUsed: now, score: score + 1, scoredAt: now)
    if entries.count > Self.itemsPerSite, let oldest = entries.min(by: { $0.value.lastUsed < $1.value.lastUsed })?.key { entries[oldest] = nil }
    sites[site] = entries
    if sites.count > Self.sitesKept, let stalest = sites.min(by: { a, b in (a.value.values.map(\.lastUsed).max() ?? 0) < (b.value.values.map(\.lastUsed).max() ?? 0) })?.key {
      sites[stalest] = nil
    }
  }

  mutating func noteEdit(item key: String, now: Double) { edited[key] = now }

  mutating func forget(provider: String) {
    let prefix = "\(provider)/"
    for site in Array(sites.keys) {
      sites[site] = sites[site]?.filter { !$0.key.hasPrefix(prefix) }
      if sites[site]?.isEmpty == true { sites[site] = nil }
    }
    edited = edited.filter { !$0.key.hasPrefix(prefix) }
  }

  mutating func keepOnly(listed keys: Set<String>, of providers: Set<String>) -> Bool {
    let owned = { (key: String) in providers.contains(String(key.prefix { $0 != "/" })) }
    var changed = false
    for site in Array(sites.keys) {
      let kept = sites[site]!.filter { !owned($0.key) || keys.contains($0.key) }
      if kept.count != sites[site]!.count {
        changed = true
        sites[site] = kept.isEmpty ? nil : kept
      }
    }
    let keptEdits = edited.filter { !owned($0.key) || keys.contains($0.key) }
    if keptEdits.count != edited.count {
      changed = true
      edited = keptEdits
    }
    return changed
  }

  func signals(profile: String?, origin: String, now: Double) -> VaultUsageSignals {
    let entries = Self.siteKey(profile: profile, origin: origin).flatMap { sites[$0] } ?? [:]
    let last = entries.max { $0.value.lastUsed < $1.value.lastUsed }?.key
    let recentEdits = Set(edited.filter { now - $0.value <= Self.editedRecently }.keys)
    return VaultUsageSignals(lastHere: last, frequency: entries.mapValues { Self.decayed($0, now: now) }, recentlyEdited: recentEdits)
  }
}

struct VaultUsageSignals: Sendable, Equatable {
  var lastHere: String?
  var frequency: [String: Double]
  var recentlyEdited: Set<String>

  static let none = VaultUsageSignals(lastHere: nil, frequency: [:], recentlyEdited: [])

  func boost(_ key: String) -> Double {
    (lastHere == key ? 1000 : 0) + (frequency[key] ?? 0) * 10 + (recentlyEdited.contains(key) ? 1 : 0)
  }
}

final class VaultUsage: @unchecked Sendable {
  static let name = "usage"

  private let queue = DispatchQueue(label: "dev.ardia.vaults.usage", qos: .utility)
  private let lock = NSLock()
  private var book: VaultUsageBook?
  private var dirty = false
  private var flushing = false
  private let read: @Sendable () -> Data?
  private let write: @Sendable (Data) -> Void
  private let clock: @Sendable () -> Double

  init(read: @escaping @Sendable () -> Data?, write: @escaping @Sendable (Data) -> Void, clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.read = read
    self.write = write
    self.clock = clock
  }

  private func loaded() -> VaultUsageBook {
    if let book { return book }
    let found = read().flatMap { try? JSONDecoder().decode(VaultUsageBook.self, from: $0) } ?? VaultUsageBook()
    book = found
    return found
  }

  private func change(_ body: @escaping (inout VaultUsageBook) -> Bool) {
    queue.async { [self] in
      VaultOffMain.check()
      let now = lock.withLock { () -> Bool in
        var current = loaded()
        guard body(&current) else { return false }
        book = current
        dirty = true
        return !flushing
      }
      guard now else { return }
      lock.withLock { flushing = true }
      queue.async { [self] in flush() }
    }
  }

  private func flush() {
    let data = lock.withLock { () -> Data? in
      flushing = false
      guard dirty, let book else { return nil }
      dirty = false
      return try? JSONEncoder().encode(book)
    }
    if let data { write(data) }
  }

  func noteFill(profile: String?, origin: String, provider: String, id: String) {
    let key = "\(provider)/\(id)"
    let now = clock()
    change { $0.noteFill(profile: profile, origin: origin, item: key, now: now); return true }
  }

  func noteEdit(provider: String, id: String) {
    let key = "\(provider)/\(id)"
    let now = clock()
    change { $0.noteEdit(item: key, now: now); return true }
  }

  func forget(provider: String) {
    change { book in
      let before = book
      book.forget(provider: provider)
      return book != before
    }
  }

  func prune(listed items: [VaultItem], providers: Set<String>) {
    let keys = Set(items.map(VaultUsageBook.itemKey))
    change { $0.keepOnly(listed: keys, of: providers) }
  }

  func signals(profile: String?, origin: String) -> VaultUsageSignals {
    VaultOffMain.check()
    let now = clock()
    return queue.sync { lock.withLock { loaded() }.signals(profile: profile, origin: origin, now: now) }
  }

  func settle() {
    queue.sync {}
    queue.sync {}
  }
}
