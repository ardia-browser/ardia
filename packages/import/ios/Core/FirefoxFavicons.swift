import Foundation

public enum FirefoxFavicons {
  static let largestSide = 64
  static let pngHeaderBytes = 24
  static let candidatesPerSource = 32
  static let recentPagesPerSite = 8
  static let maximumRootIcons = 50_000
  static let boundPerQuery = 200
  static let exactAddressesPerPage = 16
  static let tables = ["moz_icons", "moz_pages_w_icons", "moz_icons_to_pages"]

  struct Icon: Equatable {
    var url: String
    var png: String
  }

  struct Origin: Hashable {
    var scheme: String
    var host: String
    var port: Int?

    var site: String { "\(scheme)://\(host)\(port.map { ":\($0)" } ?? "")" }
    var home: String { site + "/" }
    var rootKey: String { (host.hasPrefix("www.") ? String(host.dropFirst(4)) : host) + (port.map { ":\($0)" } ?? "") }
    var reversedHost: String {
      let bare = host.hasPrefix("[") ? String(host.dropFirst().dropLast()) : host
      return String(bare.reversed()) + "."
    }
  }

  struct Group {
    var key: String
    var pages: [String]
    var origin: Origin?
  }

  enum Source: Hashable {
    case page(Int64)
    case icons([Int64])
  }

  public static func merged(profile: URL, pages: [String], known: [ImportedFavicon], snapshots: SQLiteSnapshots = .init(),
                            cancellation: Cancellation = .init()) throws -> [ImportedFavicon] {
    var out: [ImportedFavicon] = []
    var keys = Set<String>()
    var total = 0
    for icon in known where keys.count < ChromiumFavicons.maximumPages && !keys.contains(key(icon.page)) {
      guard total + icon.png.count <= ChromiumFavicons.maximumTotalBytes else { continue }
      keys.insert(key(icon.page))
      total += icon.png.count
      out.append(icon)
    }
    var wanted: [Group] = []
    var groupAt: [String: Int] = [:]
    for page in pages where URL.isWebURL(page) && !keys.contains(key(page)) {
      if let at = groupAt[key(page)] {
        if wanted[at].pages.count < exactAddressesPerPage, !wanted[at].pages.contains(page) { wanted[at].pages.append(page) }
        continue
      }
      guard keys.count + wanted.count < ChromiumFavicons.maximumPages else { continue }
      groupAt[key(page)] = wanted.count
      wanted.append(Group(key: key(page), pages: [page], origin: origin(of: page)))
    }
    guard !wanted.isEmpty, total < ChromiumFavicons.maximumTotalBytes,
          let db = try? snapshots.snapshot(copying: profile.appendingPathComponent("favicons.sqlite")),
          tables.allSatisfy(db.tableExists) else { return out }

    var chosen: [Source: Icon?] = [:]
    func choose(_ source: Source) -> Icon? {
      if let known = chosen[source] { return known }
      let picked = best(db, source)
      chosen[source] = .some(picked)
      return picked
    }

    let homes = Set(wanted.compactMap(\.origin?.home))
    let pageIds = try lookUp(db, urls: Array(Set(wanted.flatMap { $0.pages + [$0.key] }).union(homes)), cancellation: cancellation)
    let roots = rootIcons(db, keys: Set(wanted.compactMap(\.origin?.rootKey)))
    var found: [String: Icon] = [:]
    for (i, group) in wanted.enumerated() {
      if i % 64 == 0 { try cancellation.check() }
      var ids: [Int64] = []
      for url in group.pages + [group.key] { if let id = pageIds[url], !ids.contains(id) { ids.append(id) } }
      var sources = ids.map(Source.page)
      if let origin = group.origin {
        if let rootIds = roots[origin.rootKey] { sources.append(.icons(rootIds)) }
        if let home = pageIds[origin.home], !ids.contains(home) { sources.append(.page(home)) }
      }
      if let hit = sources.lazy.compactMap(choose).first { found[group.key] = hit }
    }

    let missing = wanted.compactMap { group in found[group.key] == nil ? group.origin.map { (group.key, $0) } : nil }
    if !missing.isEmpty, let places = try? snapshots.snapshot(copying: profile.appendingPathComponent("places.sqlite")),
       places.tableExists("moz_places") {
      var recent: [Origin: [String]] = [:]
      for (i, origin) in Set(missing.map(\.1)).enumerated() {
        if i % 64 == 0 { try cancellation.check() }
        recent[origin] = recentPages(places, of: origin)
      }
      let recentIds = try lookUp(db, urls: Array(Set(recent.values.joined())), cancellation: cancellation)
      for (groupKey, origin) in missing {
        let sources = (recent[origin] ?? []).compactMap { recentIds[$0] }.map(Source.page)
        if let hit = sources.lazy.compactMap(choose).first { found[groupKey] = hit }
      }
    }

    for group in wanted {
      guard let icon = found[group.key] else { continue }
      total += icon.png.count
      if total > ChromiumFavicons.maximumTotalBytes { break }
      out.append(ImportedFavicon(page: group.pages[0], icon: icon.url, png: icon.png))
    }
    return out
  }

  static func lookUp(_ db: SQLiteSnapshot, urls: [String], cancellation: Cancellation) throws -> [String: Int64] {
    var ids: [String: Int64] = [:]
    for start in stride(from: 0, to: urls.count, by: boundPerQuery) {
      try cancellation.check()
      let chunk = Array(urls[start..<min(start + boundPerQuery, urls.count)])
      try? db.query("SELECT id, page_url FROM moz_pages_w_icons WHERE page_url IN (\(placeholders(chunk.count)))",
                    chunk.map(SQLiteSnapshot.Value.text)) { row in
        if let url = row.text(1) { ids[url] = row.int(0) }
        return true
      }
    }
    return ids
  }

  static func rootIcons(_ db: SQLiteSnapshot, keys: Set<String>) -> [String: [Int64]] {
    var roots: [String: [Int64]] = [:]
    guard !keys.isEmpty else { return roots }
    try? db.query("SELECT id, icon_url FROM moz_icons WHERE root = 1 ORDER BY id LIMIT \(maximumRootIcons)") { row in
      if let url = row.text(1), let key = rootIconKey(url), keys.contains(key) { roots[key, default: []].append(row.int(0)) }
      return true
    }
    return roots
  }

  static func recentPages(_ places: SQLiteSnapshot, of origin: Origin) -> [String] {
    var urls: [String] = []
    try? places.query("""
      SELECT url FROM moz_places
      WHERE rev_host = ? AND last_visit_date IS NOT NULL AND url >= ? AND url < ? AND url <> ?
      ORDER BY last_visit_date DESC LIMIT \(recentPagesPerSite)
      """, [.text(origin.reversedHost), .text(origin.home), .text(origin.site + "0"), .text(origin.home)]) { row in
      if let url = row.text(0) { urls.append(url) }
      return true
    }
    return urls
  }

  static func best(_ db: SQLiteSnapshot, _ source: Source) -> Icon? {
    let filter: String
    let bindings: [SQLiteSnapshot.Value]
    switch source {
    case .page(let id):
      filter = "id IN (SELECT icon_id FROM moz_icons_to_pages WHERE page_id = ?)"
      bindings = [.int(id)]
    case .icons(let ids):
      filter = "id IN (\(placeholders(ids.count)))"
      bindings = ids.map(SQLiteSnapshot.Value.int)
    }
    var picked: (icon: Icon, width: Int, height: Int)?
    try? db.query("""
      SELECT icon_url, data FROM moz_icons
      WHERE \(filter) AND typeof(data) = 'blob' AND length(data) BETWEEN \(pngHeaderBytes) AND \(ChromiumFavicons.maximumPNGBytes)
      ORDER BY id LIMIT \(candidatesPerSource)
      """, bindings) { row in
      guard let url = row.text(0), let data = row.blob(1), data.count <= ChromiumFavicons.maximumPNGBytes,
            let size = pngSize(data) else { return true }
      if picked.map({ size.width > $0.width || (size.width == $0.width && size.height > $0.height) }) ?? true {
        picked = (Icon(url: url, png: data.base64EncodedString()), size.width, size.height)
      }
      return true
    }
    return picked?.icon
  }

  static func headerSize(_ head: [UInt8]) -> (width: Int, height: Int)? {
    guard head.count >= pngHeaderBytes, head.starts(with: ChromiumFavicons.pngSignature),
          head[8..<16].elementsEqual([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]) else { return nil }
    let width = word(head, 16), height = word(head, 20)
    guard (1...largestSide).contains(width), (1...largestSide).contains(height) else { return nil }
    return (width, height)
  }

  static func pngSize(_ data: Data) -> (width: Int, height: Int)? {
    let bytes = [UInt8](data)
    guard let size = headerSize(bytes) else { return nil }
    var at = 8
    var sawData = false
    while at + 12 <= bytes.count {
      let length = word(bytes, at)
      let type = bytes[at + 4..<at + 8]
      guard length <= bytes.count - at - 12 else { return nil }
      let end = at + 12 + length
      if at == 8 {
        guard type.elementsEqual("IHDR".utf8), length == 13 else { return nil }
      } else if type.elementsEqual("IHDR".utf8) {
        return nil
      } else if type.elementsEqual("IDAT".utf8) {
        sawData = sawData || length > 0
      } else if type.elementsEqual("IEND".utf8) {
        return length == 0 && end == bytes.count && sawData ? size : nil
      }
      at = end
    }
    return nil
  }

  static func word(_ bytes: [UInt8], _ at: Int) -> Int { bytes[at..<at + 4].reduce(0) { $0 << 8 | Int($1) } }

  static func key(_ page: String) -> String { String(page.prefix { $0 != "#" }) }

  static func placeholders(_ count: Int) -> String { Array(repeating: "?", count: count).joined(separator: ", ") }

  struct Parts {
    var origin: Origin
    var hasUser: Bool
    var path: String
    var hasQuery: Bool
    var hasFragment: Bool
  }

  static let nameCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-_".unicodeScalars)
  static let addressCharacters = Set("0123456789ABCDEFabcdef:.".unicodeScalars)
  static let digits = Set("0123456789".unicodeScalars)

  static func parts(of url: String) -> Parts? {
    guard let separator = url.range(of: "://") else { return nil }
    let scheme = url[..<separator.lowerBound].lowercased()
    guard scheme == "http" || scheme == "https" else { return nil }
    let rest = url[separator.upperBound...]
    let authorityEnd = rest.firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? rest.endIndex
    let authority = rest[..<authorityEnd]
    let hostAndPort = authority.split(separator: "@", omittingEmptySubsequences: false).last ?? authority
    let host: Substring
    let port: Substring?
    if hostAndPort.hasPrefix("[") {
      guard let close = hostAndPort.firstIndex(of: "]") else { return nil }
      let address = hostAndPort[hostAndPort.index(after: hostAndPort.startIndex)..<close]
      guard !address.isEmpty, address.unicodeScalars.allSatisfy(addressCharacters.contains) else { return nil }
      host = hostAndPort[...close]
      let after = hostAndPort[hostAndPort.index(after: close)...]
      guard after.isEmpty || after.hasPrefix(":") else { return nil }
      port = after.isEmpty ? nil : after.dropFirst()
    } else if let colon = hostAndPort.lastIndex(of: ":") {
      host = hostAndPort[..<colon]
      port = hostAndPort[hostAndPort.index(after: colon)...]
    } else {
      host = hostAndPort
      port = nil
    }
    guard !host.isEmpty, host.hasPrefix("[") || host.unicodeScalars.allSatisfy(nameCharacters.contains) else { return nil }
    var number: Int?
    if let port {
      guard (1...5).contains(port.unicodeScalars.count), port.unicodeScalars.allSatisfy(digits.contains), let value = Int(port), (1...65535).contains(value) else { return nil }
      number = value == (scheme == "https" ? 443 : 80) ? nil : value
    }
    let tail = rest[authorityEnd...]
    let pathEnd = tail.firstIndex { $0 == "?" || $0 == "#" } ?? tail.endIndex
    return Parts(origin: Origin(scheme: scheme, host: host.lowercased(), port: number), hasUser: authority.contains("@"),
                 path: String(tail[..<pathEnd]), hasQuery: pathEnd < tail.endIndex && tail[pathEnd] == "?", hasFragment: tail.contains("#"))
  }

  static func origin(of url: String) -> Origin? { parts(of: url)?.origin }

  static func rootIconKey(_ url: String) -> String? {
    guard let parts = parts(of: url), !parts.hasUser, parts.path == "/favicon.ico", !parts.hasQuery, !parts.hasFragment else { return nil }
    return parts.origin.rootKey
  }

  static func sessionIcons(_ icons: [ImportedFavicon], for pages: [String]) -> [ImportedFavicon] {
    let wanted = Set(pages.map(key))
    var seen = Set<String>()
    let unique = icons.filter { wanted.contains(key($0.page)) && seen.insert(key($0.page)).inserted }
    var total = 0
    var out: [ImportedFavicon] = []
    for icon in unique where out.count < ChromiumFavicons.maximumPages {
      guard total + icon.png.count <= ChromiumFavicons.maximumTotalBytes else { continue }
      total += icon.png.count
      out.append(icon)
    }
    return out
  }
}
