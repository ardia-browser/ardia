import Foundation

enum VaultMatchReason: String, Sendable {
  case origin, site, shared, brand
}

struct VaultRanked: Sendable {
  let item: VaultItem
  let tier: VaultMatchTier
  let reason: VaultMatchReason
  let site: String?

  func jsonObject() -> [String: Any] {
    var object = item.jsonObject()
    var match: [String: Any] = ["tier": tier.rawValue, "reason": reason.rawValue]
    if let site { match["site"] = site }
    object["match"] = match
    return object
  }
}

struct VaultRankKey: Sendable {
  let fullHosts: [String]
  let username: [UInt8]
  let title: [UInt8]
  let vault: [UInt8]
  let haystack: [UInt8]
  let hosts: [[UInt8]]
  let leading: [[UInt8]]
  let words: [[UInt8]]
  let hostNames: [String]
  let siteKeys: [String]
}

struct VaultRankIndex: Sendable {
  static let recommendLimit = 200
  static let fuzzyShortest = 4

  let keys: [VaultRankKey]
  let position: [Int]
  let recency: [Int]
  let titledOnly: [String: [Int]]

  static func keys(_ items: [VaultItem]) -> [VaultRankKey] { items.map(key) }

  init(_ items: [VaultItem], keys: [VaultRankKey], order: [Int]) {
    var titledOnly: [String: [Int]] = [:]
    for (index, item) in items.enumerated() {
      let key = keys[index]
      if item.urls.isEmpty {
        for word in Set(key.words.filter { $0.count >= 3 }.map { String(decoding: $0, as: UTF8.self) }) { titledOnly[word, default: []].append(index) }
      }
    }
    var position = [Int](repeating: 0, count: items.count)
    for (rank, index) in order.enumerated() { position[index] = rank }
    recency = items.indices.sorted { a, b in
      let x = items[a].updatedAt ?? 0
      let y = items[b].updatedAt ?? 0
      return x != y ? x > y : position[a] < position[b]
    }
    self.keys = keys
    self.position = position
    self.titledOnly = titledOnly
  }

  static func bytes(_ text: String) -> [UInt8] { Array(VaultCatalog.fold(text).utf8) }

  static func split(_ text: [UInt8]) -> [[UInt8]] {
    var words: [[UInt8]] = []
    var current: [UInt8] = []
    for byte in text {
      if byte >= 0x80 || (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x7A) {
        current.append(byte)
      } else if !current.isEmpty {
        words.append(current)
        current = []
      }
    }
    if !current.isEmpty { words.append(current) }
    return words
  }

  static func bareHost(_ host: String) -> String { host.hasPrefix("www.") ? String(host.dropFirst(4)) : host }

  private static func key(_ item: VaultItem) -> VaultRankKey {
    let username = bytes(item.username)
    let title = bytes(item.title)
    var hostNames: [String] = []
    var siteKeys: [String] = []
    var fullHosts: [String] = []
    for url in item.urls {
      guard let host = VaultOriginMatch.host(of: url) else {
        fullHosts.append(url.lowercased())
        continue
      }
      fullHosts.append(host)
      let bare = bareHost(host)
      if !hostNames.contains(bare) { hostNames.append(bare) }
      let site = VaultOriginMatch.siteKey(host)
      if !siteKeys.contains(site) { siteKeys.append(site) }
    }
    let hosts = hostNames.map { Array($0.utf8) }
    let leading = split(username) + split(title)
    var words = leading
    for host in hosts { words += split(host) }
    let vault = item.vault.map(bytes) ?? []
    var haystack = username
    for part in [title, vault] + hosts {
      haystack.append(1)
      haystack += part
    }
    return VaultRankKey(fullHosts: fullHosts, username: username, title: title, vault: vault, haystack: haystack, hosts: hosts, leading: leading, words: words, hostNames: hostNames,
                        siteKeys: siteKeys)
  }
}

enum VaultBytes {
  static func hasPrefix(_ text: [UInt8], _ prefix: [UInt8]) -> Bool {
    guard prefix.count <= text.count else { return false }
    return text.withUnsafeBufferPointer { a in prefix.withUnsafeBufferPointer { b in memcmp(a.baseAddress!, b.baseAddress!, b.count) == 0 } }
  }

  static func contains(_ text: [UInt8], _ needle: [UInt8]) -> Bool {
    guard !needle.isEmpty, needle.count <= text.count else { return needle.isEmpty }
    return text.withUnsafeBufferPointer { a in needle.withUnsafeBufferPointer { b in memmem(a.baseAddress!, a.count, b.baseAddress!, b.count) != nil } }
  }

  static func withinOneEdit(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    let (long, short) = a.count >= b.count ? (a, b) : (b, a)
    guard long.count - short.count <= 1 else { return false }
    var i = 0
    var j = 0
    var edits = 0
    while i < long.count && j < short.count {
      if long[i] == short[j] {
        i += 1
        j += 1
        continue
      }
      edits += 1
      if edits > 1 { return false }
      if long.count == short.count {
        if i + 1 < long.count, long[i] == short[j + 1], long[i + 1] == short[j] {
          i += 2
          j += 2
          continue
        }
        i += 1
        j += 1
      } else {
        i += 1
      }
    }
    return edits + (long.count - i) + (short.count - j) <= 1
  }
}

extension VaultCatalog {
  static func tokenScore(_ key: VaultRankKey, _ token: [UInt8], fuzzy: Bool = true) -> Int {
    guard VaultBytes.contains(key.haystack, token) else {
      return fuzzy && token.count >= VaultRankIndex.fuzzyShortest && key.words.contains(where: { VaultBytes.withinOneEdit($0, token) }) ? 1 : 0
    }
    if VaultBytes.hasPrefix(key.username, token) || VaultBytes.hasPrefix(key.title, token) || key.leading.contains(where: { VaultBytes.hasPrefix($0, token) }) { return 4 }
    if key.hosts.contains(where: { VaultBytes.hasPrefix($0, token) }) || key.words.contains(where: { VaultBytes.hasPrefix($0, token) }) { return 3 }
    return 2
  }

  struct Page: Sendable {
    let host: String
    let site: String
    let shared: [String]
    let sharedSet: Set<String>
    let brand: String?

    init?(_ origin: String) {
      guard let host = VaultOriginMatch.host(of: origin) else { return nil }
      self.host = VaultRankIndex.bareHost(host)
      site = VaultOriginMatch.siteKey(host)
      shared = VaultSharedSites.sources(host: self.host, site: site)
      sharedSet = Set(shared)
      let label = site.split(separator: ".").first.map(String.init) ?? site
      brand = label.count >= 3 && site.contains(".") && label.allSatisfy({ $0.isLetter || $0.isNumber }) ? label : nil
    }

    func relevance(_ key: VaultRankKey) -> Int {
      if key.hostNames.contains(host) { return 3 }
      if key.siteKeys.contains(site) { return 2 }
      if !sharedSet.isEmpty, key.siteKeys.contains(where: sharedSet.contains) || key.hostNames.contains(where: sharedSet.contains) { return 1 }
      return 0
    }
  }

  func smartSearch(_ query: String, origin: String, limit: Int, filter: ProfileFilter, isCancelled: () -> Bool = { false }) -> [VaultItem]? {
    VaultOffMain.check()
    let wanted = min(max(limit, 0), Self.searchLimit)
    let tokens = Self.words(query, folded: true).map { Array($0.utf8) }
    guard wanted > 0, !tokens.isEmpty else { return [] }
    let page = Page(origin)
    var buckets: [Int: [Int]] = [:]
    var found = 0
    var missed: [Int] = []
    let score = { (key: VaultRankKey, fuzzy: Bool) -> Int? in
      var total = 0
      for token in tokens {
        let one = Self.tokenScore(key, token, fuzzy: fuzzy)
        if one == 0 { return fuzzy || token.count < VaultRankIndex.fuzzyShortest ? 0 : nil }
        total += one
      }
      return total
    }
    for (step, index) in rank.recency.enumerated() {
      if step & 4095 == 0, isCancelled() { return nil }
      guard filter.keeps(items[index], own: ownProvider) else { continue }
      let key = rank.keys[index]
      guard let total = score(key, false) else {
        missed.append(index)
        continue
      }
      guard total > 0 else { continue }
      found += 1
      buckets[total * 4 + (page?.relevance(key) ?? 0), default: []].append(index)
    }
    if found < wanted {
      for (step, index) in missed.enumerated() {
        if step & 4095 == 0, isCancelled() { return nil }
        let key = rank.keys[index]
        guard let total = score(key, true), total > 0 else { continue }
        buckets[total * 4 + (page?.relevance(key) ?? 0), default: []].append(index)
      }
    }
    var picked: [VaultItem] = []
    for bucket in buckets.keys.sorted(by: >) {
      for index in buckets[bucket]! {
        picked.append(items[index])
        if picked.count == wanted { return picked }
      }
    }
    return picked
  }

  static func top<T>(_ values: [T], _ count: Int, by better: (T, T) -> Bool) -> [T] {
    guard values.count > count * 4 else { return Array(values.sorted(by: better).prefix(count)) }
    var kept: [T] = []
    kept.reserveCapacity(count + 1)
    for value in values {
      if kept.count == count, let last = kept.last, !better(value, last) { continue }
      let at = kept.firstIndex { better(value, $0) } ?? kept.count
      kept.insert(value, at: at)
      if kept.count > count { kept.removeLast() }
    }
    return kept
  }

  func recommend(origin: String, filter: ProfileFilter, usage: VaultUsageSignals, pageUsername: String?, remembered: String?) -> [VaultRanked] {
    VaultOffMain.check()
    guard let page = Page(origin) else { return [] }
    struct Candidate {
      let index: Int
      let tier: VaultMatchTier
      let reason: VaultMatchReason
      let site: String?
      let host: String
      let scheme: String
    }
    var seen = Set<Int>()
    var candidates: [Candidate] = []
    let fullTier: (Int) -> (tier: VaultMatchTier, url: String)? = { index in
      let item = self.items[index]
      var best: (tier: VaultMatchTier, url: String)? = nil
      for (offset, url) in item.urls.enumerated() {
        let mode = item.urlMatch.flatMap { $0.count == item.urls.count ? $0[offset] : nil }
        let found = mode.map { VaultOriginMatch.capped(VaultOriginMatch.tier(url, origin: origin), mode: $0) } ?? VaultOriginMatch.tier(url, origin: origin)
        if found > (best?.tier ?? .none) { best = (found, url) }
      }
      guard let best, best.tier > .none else { return nil }
      return best
    }
    var approximated = Set<Int>()
    for index in sitesNear(origin) where seen.insert(index).inserted && filter.keeps(items[index], own: ownProvider) {
      let key = rank.keys[index]
      if key.hostNames.contains(page.host) || VaultMatchTier.blocksShared(items[index]) {
        guard let best = fullTier(index) else { continue }
        let host = VaultOriginMatch.host(of: best.url).map(VaultRankIndex.bareHost) ?? ""
        let scheme = best.url.lowercased().hasPrefix("http://") ? "http" : "https"
        candidates.append(Candidate(index: index, tier: best.tier, reason: best.tier >= .sameHost ? .origin : .site, site: nil, host: host, scheme: scheme))
        continue
      }
      guard let host = key.hostNames.first(where: { $0 == page.site || $0.hasSuffix(".\(page.site)") }) ?? key.hostNames.first else { continue }
      let nested = key.hostNames.contains { page.host.hasSuffix(".\($0)") || $0.hasSuffix(".\(page.host)") }
      approximated.insert(index)
      candidates.append(Candidate(index: index, tier: nested ? .subdomain : .sibling, reason: .site, site: nil, host: host, scheme: "https"))
    }
    for domain in page.shared {
      for index in sitesNear("https://\(domain)") where !seen.contains(index) && filter.keeps(items[index], own: ownProvider) {
        let key = rank.keys[index]
        guard key.siteKeys.contains(domain) || key.hostNames.contains(domain), !VaultMatchTier.blocksShared(items[index]) else { continue }
        seen.insert(index)
        candidates.append(Candidate(index: index, tier: .sibling, reason: .shared, site: domain, host: domain, scheme: "https"))
      }
    }
    if candidates.isEmpty, let brand = page.brand {
      for index in rank.titledOnly[brand] ?? [] where seen.insert(index).inserted && filter.keeps(items[index], own: ownProvider) {
        candidates.append(Candidate(index: index, tier: .sibling, reason: .brand, site: nil, host: "", scheme: "https"))
      }
    }
    let wantedUser = pageUsername?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    let classOf: (Candidate) -> Int = { candidate in
      switch candidate.reason {
      case .origin: return 0
      case .site: return 1
      case .shared: return 2
      case .brand: return 3
      }
    }
    let pinned: (Candidate) -> Bool = { candidate in
      !wantedUser.isEmpty && candidate.reason != .shared && candidate.reason != .brand
        && self.items[candidate.index].username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == wantedUser
    }
    let quiet = usage == .none && remembered == nil
    let boost: (Candidate) -> Double = { candidate in
      if quiet { return 0 }
      let key = VaultUsageBook.itemKey(self.items[candidate.index])
      return usage.boost(key) + (key == remembered ? 500 : 0)
    }
    struct Order {
      let candidate: Candidate
      let pinned: Bool
      let group: Int
      let boost: Double
    }
    let keyed = candidates.map { Order(candidate: $0, pinned: pinned($0), group: classOf($0), boost: boost($0)) }
    let ordered = keyed.sorted { a, b in
      if a.pinned != b.pinned { return a.pinned }
      if a.group != b.group { return a.group < b.group }
      if a.boost != b.boost { return a.boost > b.boost }
      if a.candidate.tier != b.candidate.tier { return a.candidate.tier > b.candidate.tier }
      let x = rank.keys[a.candidate.index], y = rank.keys[b.candidate.index]
      if x.username != y.username { return x.username.lexicographicallyPrecedes(y.username) }
      if x.title != y.title { return x.title.lexicographicallyPrecedes(y.title) }
      let p = items[a.candidate.index], q = items[b.candidate.index]
      if (p.updatedAt ?? 0) != (q.updatedAt ?? 0) { return (p.updatedAt ?? 0) > (q.updatedAt ?? 0) }
      if p.provider != q.provider { return p.provider < q.provider }
      return rank.position[a.candidate.index] < rank.position[b.candidate.index]
    }.map(\.candidate)
    var kept: [String: [(provider: String, scheme: String)]] = [:]
    var ranked: [VaultRanked] = []
    for found in ordered {
      var candidate = found
      if approximated.contains(found.index) {
        guard let best = fullTier(found.index) else { continue }
        let scheme = best.url.lowercased().hasPrefix("http://") ? "http" : "https"
        let host = VaultOriginMatch.host(of: best.url).map(VaultRankIndex.bareHost) ?? found.host
        candidate = Candidate(index: found.index, tier: best.tier, reason: best.tier >= .sameHost ? .origin : .site, site: nil, host: host, scheme: scheme)
      }
      let item = items[candidate.index]
      let user = item.username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let login = "\(user)\n\(candidate.host)"
      let earlier = kept[login] ?? []
      if !user.isEmpty, earlier.contains(where: { $0.provider != item.provider || $0.scheme != candidate.scheme }) { continue }
      kept[login, default: []].append((item.provider, candidate.scheme))
      ranked.append(VaultRanked(item: item, tier: candidate.tier, reason: candidate.reason, site: candidate.site))
      if ranked.count >= VaultRankIndex.recommendLimit { break }
    }
    return ranked
  }
}

extension VaultMatchTier {
  static func blocksShared(_ item: VaultItem) -> Bool {
    guard let modes = item.urlMatch else { return false }
    return modes.allSatisfy { $0 == "exact" || $0 == "host" }
  }
}
