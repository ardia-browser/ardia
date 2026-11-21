import CryptoKit
import Foundation

public struct ArcLinkDestination: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable { case space, littleArc, mostRecent }

  public var kind: Kind
  public var spaceId: String?
  public var spaceName: String?

  public init(kind: Kind, spaceId: String? = nil, spaceName: String? = nil) {
    self.kind = kind
    self.spaceId = spaceId
    self.spaceName = spaceName
  }
}

public struct ArcLinkRule: Codable, Equatable, Sendable {
  public enum Match: String, Codable, Sendable { case contains, equals }

  public var id: String
  public var match: Match
  public var text: String
  public var to: ArcLinkDestination
}

public struct ArcRouting: Codable, Equatable, Sendable {
  public var rules: [ArcLinkRule] = []
  public var skipped = 0
  public var fallback: ArcLinkDestination?

  public var changesFallback: Bool {
    guard let fallback else { return false }
    return fallback.kind != .littleArc || fallback.spaceId != nil
  }
}

public struct ArcArchivedTab: Codable, Equatable, Sendable {
  public var url: String
  public var title: String
  public var customTitle: String?
  public var archivedAt: Double
  public var spaceId: String?
  public var spaceName: String?
  public var auto: Bool
}

public struct ArcArchive: Codable, Equatable, Sendable {
  public var tabs: [ArcArchivedTab] = []
  public var dropped = 0
  public var cleanUpAfterMinutes: Int?
}

public enum ArcExtras {
  public static let routingFile = "StorableLinkRouting.json"
  public static let archiveFile = "StorableArchiveItems.json"
  public static let iconCacheFolder = "SidebarItemsFaviconCache"
  public static let preferencesDomain = "company.thebrowser.Browser"
  public static let thresholdKey = "autoArchiveTimeThreshold"
  public static let maximumArchived = 1_500
  public static let maximumRules = 1_000
  public static let maximumArchiveItems = 50_000
  public static let maximumText = 2_048
  public static let maximumId = 128
  public static let maximumURL = 8_192
  public static let maximumTitle = 1_024
  public static let routingBytes = 4 << 20
  public static let archiveBytes = 64 << 20
  public static let preferencesBytes = 4 << 20
  static let appleEpochSeconds = 978_307_200.0

  public static let thresholdMinutes: [String: Int] = [
    "twelveHours": 12 * 60,
    "twentyFourHours": 24 * 60,
    "sevenDays": 7 * 24 * 60,
    "thirtyDays": 30 * 24 * 60,
  ]

  public static func routing(_ data: Data, spaces: [String: String]) throws -> ArcRouting {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ImportError.unreadable("\(routingFile) is not Arc's Air Traffic Control file")
    }
    var out = ArcRouting()
    out.fallback = destination(root["defaultDestination"], spaces: spaces)
    let candidates = root["rules"] as? [Any] ?? []
    for candidate in candidates.prefix(maximumRules) {
      if let rule = (candidate as? [String: Any]).flatMap({ rule(of: $0, spaces: spaces) }) { out.rules.append(rule) } else { out.skipped += 1 }
    }
    out.skipped += max(0, candidates.count - maximumRules)
    return out
  }

  static func only(_ value: Any?) -> (key: String, value: Any)? {
    guard let d = value as? [String: Any], d.count == 1, let entry = d.first else { return nil }
    return (entry.key, entry.value)
  }

  static func rule(of rule: [String: Any], spaces: [String: String]) -> ArcLinkRule? {
    guard let id = rule["id"] as? String, !id.isEmpty, id.utf8.count <= maximumId,
          let to = destination(rule["destination"], spaces: spaces),
          let components = rule["sourceComponents"] as? [Any], components.count == 1,
          let type = only((components[0] as? [String: Any])?["componentType"]), type.key == "urlMatch",
          let urlMatch = type.value as? [String: Any], urlMatch.count == 2,
          let style = only(urlMatch["_0"]), style.key == "contains" || style.key == "matches",
          let raw = urlMatch["_1"] as? String, raw.utf8.count <= maximumText else { return nil }
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    return ArcLinkRule(id: id, match: style.key == "matches" ? .equals : .contains, text: text, to: to)
  }

  static func destination(_ value: Any?, spaces: [String: String]) -> ArcLinkDestination? {
    guard let outer = only(value), outer.key == "space" || outer.key == "littleArc",
          let target = only((outer.value as? [String: Any])?["_0"]) else { return nil }
    let little = outer.key == "littleArc"
    if target.key == "mostRecent" { return ArcLinkDestination(kind: little ? .littleArc : .mostRecent) }
    guard target.key == "space", let id = (target.value as? [String: Any])?["_0"] as? String, !id.isEmpty, id.utf8.count <= maximumId else { return nil }
    return ArcLinkDestination(kind: little ? .littleArc : .space, spaceId: id, spaceName: spaces[id])
  }

  public static func archive(_ data: Data?, threshold: String?, spaces: [String: String]) throws -> ArcArchive {
    var out = ArcArchive()
    out.cleanUpAfterMinutes = threshold.flatMap { thresholdMinutes[$0] }
    guard let data else { return out }
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ImportError.unreadable("\(archiveFile) is not Arc's archive")
    }
    let entries = ArcSidebar.objects(root["items"])
    out.dropped = max(0, entries.count - maximumArchiveItems)
    out.tabs = entries.prefix(maximumArchiveItems).compactMap { archived($0, spaces: spaces) }.sorted { $0.archivedAt > $1.archivedAt }
    if out.tabs.count > maximumArchived {
      out.dropped += out.tabs.count - maximumArchived
      out.tabs.removeLast(out.tabs.count - maximumArchived)
    }
    return out
  }

  static func archived(_ entry: [String: Any], spaces: [String: String]) -> ArcArchivedTab? {
    guard let item = entry["sidebarItem"] as? [String: Any],
          let tab = (item["data"] as? [String: Any])?["tab"] as? [String: Any],
          let url = tab["savedURL"] as? String, url.utf8.count <= maximumURL, URL.isWebURL(url),
          let at = (entry["archivedAt"] as? NSNumber)?.doubleValue else { return nil }
    let source = (entry["source"] as? [String: Any])?["space"] as? [String: Any]
    let id = (source?["_0"] as? String).flatMap { spaces[$0] != nil ? $0 : nil }
    return ArcArchivedTab(url: url, title: String((tab["savedTitle"] as? String ?? "").prefix(maximumTitle)),
                          customTitle: ArcSidebar.customTitle(item).map { String($0.prefix(maximumTitle)) },
                          archivedAt: (at + appleEpochSeconds) * 1000, spaceId: id, spaceName: id.flatMap { spaces[$0] },
                          auto: entry["reason"] as? String == "auto")
  }

  public static func threshold(preferences url: URL) -> String? {
    guard let data = boundedRead(url, within: url.deletingLastPathComponent(), limit: preferencesBytes),
          let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return nil }
    return plist[thresholdKey] as? String
  }

  public static func boundedRead(_ url: URL, within folder: URL, limit: Int) -> Data? {
    guard let root = realpath(folder.path, nil) else { return nil }
    let rootPath = String(cString: root)
    free(root)
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= off_t(limit) else { return nil }
    var opened = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fcntl(fd, F_GETPATH, &opened) != -1, String(cString: opened).hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/") else { return nil }
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let n = read(fd, &chunk, chunk.count)
      if n < 0 { return nil }
      if n == 0 { return data }
      data.append(chunk, count: n)
      if data.count > limit { return nil }
    }
  }

  public static func iconFileName(itemId: String) -> String {
    Insecure.MD5.hash(data: Data(itemId.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  public static let sidebarBytes = 64 << 20

  public static func cachedFavicons(folder: URL, root: URL, items: [String: String], pages: [String], known: [ImportedFavicon]) -> [ImportedFavicon] {
    let icons = Dictionary(known.map { ($0.page, $0.icon) }, uniquingKeysWith: { first, _ in first })
    var seen = Set<String>()
    var total = 0
    var out: [ImportedFavicon] = []
    for page in pages where URL.isWebURL(page) && seen.insert(page).inserted {
      if seen.count > ChromiumFavicons.maximumPages || total >= ChromiumFavicons.maximumTotalBytes { break }
      guard let id = items[page], let icon = icons[page] ?? ChromiumFavicons.origin(of: page).map({ $0 + "/favicon.ico" }) else { continue }
      let file = folder.appendingPathComponent(iconFileName(itemId: id))
      guard let png = boundedRead(file, within: root, limit: ChromiumFavicons.maximumPNGBytes), png.starts(with: ChromiumFavicons.pngSignature) else { continue }
      let encoded = png.base64EncodedString()
      total += encoded.count
      if total > ChromiumFavicons.maximumTotalBytes { break }
      out.append(ImportedFavicon(page: page, icon: icon, png: encoded))
    }
    return out
  }

  public static func preferring(_ cached: [ImportedFavicon], over known: [ImportedFavicon]) -> [ImportedFavicon] {
    let taken = Set(cached.map(\.page))
    var total = cached.reduce(0) { $0 + $1.png.count }
    return cached + known.filter { icon in
      guard !taken.contains(icon.page), total + icon.png.count <= ChromiumFavicons.maximumTotalBytes else { return false }
      total += icon.png.count
      return true
    }
  }
}
