import Foundation

struct VaultCatalog: Sendable {
  static let siteItemsLimit = 500
  static let searchLimit = 200
  static let pageLimit = 1000
  static let usernamesLimit = 50
  static let slowBuild = Duration.milliseconds(250)

  enum ProfileFilter: Sendable, Equatable {
    case everyProfile
    case managersOnly
    case profile(String)

    func keeps(_ item: VaultItem, own: String) -> Bool {
      guard item.provider == own else { return true }
      switch self {
      case .everyProfile: return true
      case .managersOnly: return false
      case .profile(let name): return item.profile == name
      }
    }
  }

  private struct SearchKey: Sendable {
    let title: String
    let haystack: String
    let order: String
  }

  private struct ListKey: Sendable {
    let site: String
    let username: String
    let haystack: String
  }

  let items: [VaultItem]
  let ownProvider: String
  private let sites: VaultSiteIndex
  private let searchKeys: [SearchKey]
  private let searchOrder: [Int]
  private let listKeys: [ListKey]
  private let listOrder: [Int]

  init(_ items: [VaultItem], ownProvider: String) {
    VaultOffMain.check()
    self.items = items
    self.ownProvider = ownProvider
    sites = VaultSiteIndex(items.map(\.urls))
    let searchKeys = items.map(Self.searchKey)
    self.searchKeys = searchKeys
    searchOrder = items.indices.sorted { searchKeys[$0].order < searchKeys[$1].order }
    let listKeys = items.map(Self.listKey)
    self.listKeys = listKeys
    listOrder = items.indices.sorted { a, b in
      let site = Self.collate(listKeys[a].site, listKeys[b].site)
      if site != .orderedSame { return site == .orderedAscending }
      return Self.collate(listKeys[a].username, listKeys[b].username) == .orderedAscending
    }
  }

  static func collate(_ a: String, _ b: String) -> ComparisonResult {
    a.compare(b, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive, .numeric], range: nil, locale: Locale.current)
  }

  static func fold(_ text: String) -> String {
    var scalars = String.UnicodeScalarView()
    for scalar in text.decomposedStringWithCompatibilityMapping.unicodeScalars where !isMark(scalar) { scalars.append(scalar) }
    return String(scalars).lowercased()
  }

  private static func isMark(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x0300...0x036F, 0x1AB0...0x1AFF, 0x1DC0...0x1DFF, 0x20D0...0x20FF, 0xFE20...0xFE2F: return true
    default: return false
    }
  }

  static func words(_ query: String, folded: Bool) -> [String] {
    (folded ? fold(query) : query.lowercased()).split(whereSeparator: { $0.isWhitespace }).map(String.init)
  }

  private static func searchKey(_ item: VaultItem) -> SearchKey {
    let title = fold(item.title)
    let username = fold(item.username)
    let hosts = item.urls.map { VaultOriginMatch.host(of: $0) ?? $0.lowercased() }
    return SearchKey(title: title, haystack: ([title, username] + hosts).joined(separator: "\n"), order: "\(title)\u{0}\(username)")
  }

  static func withScheme(_ url: String) -> String {
    guard !url.isEmpty, url.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) == nil else { return url }
    return "https://\(url)"
  }

  private static func listKey(_ item: VaultItem) -> ListKey {
    let url = withScheme(item.urls.first ?? "")
    let site = url.isEmpty ? item.title : (VaultOriginMatch.siteLabel(of: url) ?? url)
    return ListKey(site: site, username: item.username, haystack: [url.isEmpty ? site : url, item.username, item.title].joined(separator: " ").lowercased())
  }

  private static let emailShape = try? NSRegularExpression(pattern: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#)

  static func looksLikeEmail(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return emailShape?.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) != nil
  }

  private static func rankUsernames(_ items: [VaultItem], email: Bool) -> [VaultItem] {
    struct Seen {
      var item: Int
      var username: String
      var count: Int
      var usedAt: Double
    }
    var byName: [String: Seen] = [:]
    for (index, item) in items.enumerated() {
      let username = item.username.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !username.isEmpty else { continue }
      let key = username.lowercased()
      let usedAt = item.updatedAt ?? 0
      guard var known = byName[key] else {
        byName[key] = Seen(item: index, username: username, count: 1, usedAt: usedAt)
        continue
      }
      known.count += 1
      if usedAt > known.usedAt {
        known.item = index
        known.username = username
        known.usedAt = usedAt
      }
      byName[key] = known
    }
    let ranked = byName.values.map { ($0, email && looksLikeEmail($0.username)) }
    return ranked
      .sorted { a, b in
        if a.1 != b.1 { return a.1 }
        if a.0.count != b.0.count { return a.0.count > b.0.count }
        if a.0.usedAt != b.0.usedAt { return a.0.usedAt > b.0.usedAt }
        return a.0.username < b.0.username
      }
      .map { items[$0.0.item] }
  }

  func near(_ origin: String) -> [VaultItem] {
    Array(sites.entries(near: origin).prefix(Self.siteItemsLimit).map { items[$0] })
  }

  func search(_ query: String, limit: Int, filter: ProfileFilter) -> [VaultItem] {
    let wanted = min(max(limit, 0), Self.searchLimit)
    guard wanted > 0 else { return [] }
    let terms = Self.words(query, folded: true)
    let first = terms.first ?? ""
    var buckets: [[Int]] = [[], [], []]
    for index in searchOrder {
      guard filter.keeps(items[index], own: ownProvider) else { continue }
      let key = searchKeys[index]
      guard terms.allSatisfy({ key.haystack.contains($0) }) else { continue }
      let score = first.isEmpty ? 0 : key.title.hasPrefix(first) ? 2 : key.title.contains(first) ? 1 : 0
      buckets[2 - score].append(index)
      if first.isEmpty, buckets[2].count >= wanted { break }
      if buckets[0].count >= wanted { break }
    }
    return Array(buckets.joined().prefix(wanted)).map { items[$0] }
  }

  func page(query: String, offset: Int, limit: Int, filter: ProfileFilter) -> (total: Int, items: [VaultItem]) {
    let terms = Self.words(query, folded: false)
    let start = max(offset, 0)
    let wanted = min(max(limit, 0), Self.pageLimit)
    var total = 0
    var picked: [VaultItem] = []
    for index in listOrder {
      let item = items[index]
      guard filter.keeps(item, own: ownProvider) else { continue }
      if !terms.isEmpty {
        let key = listKeys[index]
        guard terms.allSatisfy({ key.haystack.contains($0) }) else { continue }
      }
      if total >= start && picked.count < wanted { picked.append(item) }
      total += 1
    }
    return (total, picked)
  }

  func usernames(email: Bool, limit: Int, filter: ProfileFilter) -> [VaultItem] {
    let wanted = min(max(limit, 0), Self.usernamesLimit)
    guard wanted > 0 else { return [] }
    return Array(Self.rankUsernames(items.filter { filter.keeps($0, own: ownProvider) }, email: email).prefix(wanted))
  }
}
