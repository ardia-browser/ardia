import Foundation

struct VaultFormatVersion: Decodable {
  let version: Int

  static func of(_ plain: Data) -> Int? { (try? JSONDecoder().decode(Self.self, from: plain))?.version }
}

struct VaultCacheSnapshot: Codable, Equatable, Sendable {
  struct Entry: Codable, Equatable, Sendable {
    var item: VaultItem
    var totpPeriod: Int?
  }

  struct Password: Codable, Equatable, Sendable {
    var value: String
    var itemUpdatedAt: Double?
  }

  static let currentVersion = 2

  var version = VaultCacheSnapshot.currentVersion
  var account: String
  var savedAt: Double
  var entries: [Entry]
  var passwords: [String: Password]
  var totps: [String: Password]?

  var items: [VaultItem] {
    entries.map { entry in
      var item = entry.item
      item.totpPeriod = entry.totpPeriod
      return item
    }
  }

  static func normalizedAccount(_ account: String) -> String {
    account.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  func sameAccount(_ other: VaultCacheSnapshot) -> Bool {
    Self.normalizedAccount(account) == Self.normalizedAccount(other.account)
  }

  static func merged(_ first: VaultCacheSnapshot, _ second: VaultCacheSnapshot) -> VaultCacheSnapshot {
    let secondIsNewer = second.savedAt > first.savedAt || (second.savedAt == first.savedAt && second.entries.count > first.entries.count)
    let newer = secondIsNewer ? second : first
    let older = secondIsNewer ? first : second
    guard newer.sameAccount(older) else { return newer }
    var result = newer
    result.version = max(first.version, second.version)
    var passwords: [String: Password] = [:]
    var totps: [String: Password] = [:]
    for entry in newer.entries {
      let id = entry.item.id
      let updatedAt = entry.item.updatedAt
      if let kept = matching(newer.passwords[id], older.passwords[id], updatedAt) { passwords[id] = kept }
      if let kept = matching(newer.totps?[id], older.totps?[id], updatedAt) { totps[id] = kept }
    }
    result.passwords = passwords
    result.totps = newer.totps == nil && older.totps == nil ? nil : totps
    return result
  }

  private static func matching(_ preferred: Password?, _ fallback: Password?, _ updatedAt: Double?) -> Password? {
    if let preferred, preferred.itemUpdatedAt == updatedAt { return preferred }
    if let fallback, fallback.itemUpdatedAt == updatedAt { return fallback }
    return nil
  }

  static func decoded(_ plain: Data) -> VaultCacheSnapshot? {
    guard let snapshot = try? JSONDecoder().decode(VaultCacheSnapshot.self, from: plain), (1...currentVersion).contains(snapshot.version) else { return nil }
    return snapshot
  }

  static func isNewerFormat(_ plain: Data) -> Bool { (VaultFormatVersion.of(plain) ?? 0) > currentVersion }

  struct CloudPlan: Equatable {
    var local: VaultCacheSnapshot?
    var push: VaultCacheSnapshot?
    var newerElsewhere = false
  }

  static func cloudPlan(local: VaultCacheSnapshot?, remotes: [Data], account: String?) -> CloudPlan {
    let remote = remotes.compactMap(decoded).reduce(nil as VaultCacheSnapshot?) { held, next in held.map { merged($0, next) } ?? next }
    var fresh = local
    if let remote, let account, account.isEmpty || normalizedAccount(remote.account) == account {
      fresh = local.map { merged($0, remote) } ?? remote
    }
    var plan = CloudPlan(local: fresh != local ? fresh : nil)
    guard !remotes.contains(where: isNewerFormat) else {
      plan.newerElsewhere = true
      return plan
    }
    guard let base = fresh ?? local else { return plan }
    let target = remote.map { merged(base, $0) } ?? base
    if target != remote || remotes.count > 1 { plan.push = target }
    return plan
  }
}
