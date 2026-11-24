import Foundation

struct VaultSavedLogin: Sendable, Equatable {
  var origin: String
  var username: String
}

struct VaultSavedIndex: Sendable {
  let logins: [VaultSavedLogin]
  let generation: Int
  private let sites: [String]
  private let haystacks: [VaultHaystack]
  private let realms: [String]
  let order: [Int]

  init(_ logins: [VaultSavedLogin], generation: Int = VaultItemsRevision.next()) {
    VaultOffMain.check()
    self.logins = logins
    self.generation = generation
    let sites = logins.map { VaultOriginMatch.siteLabel(of: $0.origin) ?? $0.origin }
    self.sites = sites
    haystacks = logins.map { VaultHaystack(Self.haystack($0)) }
    realms = logins.map { Self.realm($0.origin) }
    order = logins.indices.sorted { a, b in
      let site = VaultCatalog.collate(sites[a], sites[b])
      if site != .orderedSame { return site == .orderedAscending }
      return VaultCatalog.collate(logins[a].username, logins[b].username) == .orderedAscending
    }
  }

  func site(_ index: Int) -> String { sites[index] }

  func matching(_ terms: [[UInt8]]) -> [Int] {
    guard !terms.isEmpty else { return order }
    return order.filter { haystacks[$0].contains(all: terms) }
  }

  func on(_ origin: String) -> [VaultSavedLogin] {
    let wanted = Self.realm(origin)
    return logins.indices.filter { realms[$0] == wanted }.map { logins[$0] }
  }

  static func realm(_ origin: String) -> String {
    var trimmed = Substring(origin)
    while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
    return trimmed.lowercased()
  }

  static func haystack(_ login: VaultSavedLogin) -> String {
    [login.origin, login.username].map { field in
      field.range(of: "xn--", options: .caseInsensitive) == nil ? field : "\(field) \(VaultPunycode.displayed(field))"
    }.joined(separator: " ").lowercased()
  }

  static func parse(_ json: String) -> [VaultSavedLogin]? {
    VaultOffMain.check()
    guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], object["error"] == nil,
      let entries = object["passwords"] as? [[String: Any]]
    else { return nil }
    return entries.map { VaultSavedLogin(origin: $0["origin"] as? String ?? "", username: $0["username"] as? String ?? "") }
  }
}

extension VaultCatalog {
  func listMatches(_ terms: [[UInt8]], filter: ProfileFilter) -> [Int] {
    listOrder.filter { index in filter.keeps(items[index], own: ownProvider) && listKeys[index].haystack.contains(all: terms) }
  }

  func listedCount(_ filter: ProfileFilter) -> Int { items.reduce(0) { $0 + (filter.keeps($1, own: ownProvider) ? 1 : 0) } }
}

struct VaultPaneOrder: Sendable {
  let rows: [Int32]
  let listed: Int

  static func merge(saved: VaultSavedIndex, catalog: VaultCatalog?, query: String) -> VaultPaneOrder {
    VaultOffMain.check()
    let terms = VaultCatalog.words(query, folded: false).map(VaultHaystack.needle)
    let own = saved.matching(terms)
    let managers = catalog?.listMatches(terms, filter: .managersOnly) ?? []
    var rows: [Int32] = []
    rows.reserveCapacity(own.count + managers.count)
    var i = 0
    var j = 0
    while i < own.count, j < managers.count, let catalog {
      let key = catalog.listKeys[managers[j]]
      let site = VaultCatalog.collate(saved.site(own[i]), key.site)
      let savedFirst = site == .orderedAscending || site == .orderedSame && VaultCatalog.collate(saved.logins[own[i]].username, key.username) != .orderedDescending
      if savedFirst {
        rows.append(Int32(own[i]))
        i += 1
      } else {
        rows.append(-Int32(managers[j]) - 1)
        j += 1
      }
    }
    while i < own.count {
      rows.append(Int32(own[i]))
      i += 1
    }
    while j < managers.count {
      rows.append(-Int32(managers[j]) - 1)
      j += 1
    }
    return VaultPaneOrder(rows: rows, listed: saved.logins.count + (catalog?.listedCount(.managersOnly) ?? 0))
  }
}
