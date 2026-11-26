import Foundation

struct WebKitSiteChoices {
  struct Key: Hashable {
    let site: String
    let kind: String
  }

  struct ExternalGrant {
    let origin: String
    let scheme: String
    let app: String
    let appPath: String
  }

  private(set) var remembered: [Key: Bool] = [:]
  private(set) var externalAllowances: [Key: ExternalGrant] = [:]
  var zoom: [String: Double] = [:]
  private var rememberedAt: [Key: Date] = [:]
  private var allowedAt: [Key: Date] = [:]

  mutating func remember(_ key: Key, allowed: Bool, at now: Date = Date()) {
    remembered[key] = allowed
    rememberedAt[key] = now
  }

  mutating func forgetAnswer(_ key: Key) {
    remembered.removeValue(forKey: key)
    rememberedAt.removeValue(forKey: key)
  }

  mutating func allowExternal(_ key: Key, _ grant: ExternalGrant, at now: Date = Date()) {
    externalAllowances[key] = grant
    allowedAt[key] = now
  }

  mutating func removeExternal(_ key: Key) {
    externalAllowances.removeValue(forKey: key)
    allowedAt.removeValue(forKey: key)
  }

  mutating func forgetSiteChoices(since: Date?) {
    guard let since else {
      remembered = [:]
      rememberedAt = [:]
      externalAllowances = [:]
      allowedAt = [:]
      return
    }
    for (key, at) in rememberedAt where at >= since { forgetAnswer(key) }
    for (key, at) in allowedAt where at >= since { removeExternal(key) }
  }

  static func rangeStart(sinceMilliseconds since: Double) -> Date? {
    since.isFinite && since > 0 ? Date(timeIntervalSince1970: since / 1000) : nil
  }
}
