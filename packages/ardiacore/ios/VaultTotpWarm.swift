import Foundation

struct VaultTotpWarmPlan: Sendable {
  static let absent = ""
  static let page = 20
  static let pause = Duration.milliseconds(120)
  static let sweepLimit = 2_000
  static let persistEvery = Duration.seconds(20)

  enum Knowledge: Equatable, Sendable {
    case secret
    case none
    case unknown
  }

  static func knowledge(of item: VaultItem, cached: VaultCacheSnapshot.Password?) -> Knowledge {
    if item.hasTotp == false { return .none }
    guard let cached, cached.itemUpdatedAt == item.updatedAt else { return .unknown }
    return cached.value == absent ? .none : .secret
  }

  static func entry(for revealed: String?, item: VaultItem) -> VaultCacheSnapshot.Password {
    let value = revealed.flatMap { VaultTotpSecret($0) == nil ? nil : $0 } ?? absent
    return VaultCacheSnapshot.Password(value: value, itemUpdatedAt: item.updatedAt)
  }

  static func order(
    _ items: [VaultItem], cached: [String: VaultCacheSnapshot.Password], tried: Set<String>, urgent: Set<String>, focusSite: String?,
    sweepLeft: Int, limit: Int = page
  ) -> [VaultItem] {
    var first: [VaultItem] = []
    var site: [VaultItem] = []
    var listed: [VaultItem] = []
    var unknown: [VaultItem] = []
    for item in items where !tried.contains(item.id) && knowledge(of: item, cached: cached[item.id]) == .unknown {
      if urgent.contains(item.id) {
        first.append(item)
      } else if let focusSite, item.urls.contains(where: { VaultOriginMatch.host(of: $0).map(VaultOriginMatch.siteKey) == focusSite }) {
        site.append(item)
      } else if item.hasTotp == true {
        listed.append(item)
      } else if sweepLeft > 0 {
        unknown.append(item)
      }
    }
    let newest: (VaultItem, VaultItem) -> Bool = { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    let swept = unknown.sorted(by: newest).prefix(max(0, sweepLeft))
    return Array((first + site.sorted(by: newest) + listed.sorted(by: newest) + swept).prefix(limit))
  }
}
