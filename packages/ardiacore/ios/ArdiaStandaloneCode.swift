import Foundation

struct ArdiaStandaloneCode: Codable, Equatable, Sendable {
  static let idPrefix = "code."
  static let longestLabel = 120
  static let longestWebsite = 2048

  var uri: String
  var label: String
  var issuer: String?
  var website: String?
  var createdAt: Double?

  static func isId(_ id: String) -> Bool {
    id.hasPrefix(idPrefix) && id.count <= idPrefix.count + 64
  }

  static func newId() -> String { idPrefix + UUID().uuidString.lowercased() }

  static func made(uri: String, label: String, issuer: String?, website: String?, at time: Double) -> ArdiaStandaloneCode? {
    guard let cleanLabel = cleanedText(label) else { return nil }
    var site: String?
    if let website, !website.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      guard let origin = websiteOrigin(website) else { return nil }
      site = origin
    }
    return ArdiaStandaloneCode(uri: uri, label: cleanLabel, issuer: issuer.flatMap(cleanedText), website: site, createdAt: time)
  }

  static func cleanedText(_ text: String) -> String? {
    let flat = text.unicodeScalars.filter { !CharacterSet.newlines.contains($0) && !CharacterSet.controlCharacters.contains($0) }
    let trimmed = String(String.UnicodeScalarView(flat)).trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return nil }
    return String(trimmed.prefix(longestLabel))
  }

  static func websiteOrigin(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= longestWebsite, !trimmed.contains(where: \.isWhitespace) else { return nil }
    let absolute = trimmed.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) == nil ? "https://" + trimmed : trimmed
    guard let components = URLComponents(string: absolute), let scheme = components.scheme?.lowercased(),
      let host = components.host?.lowercased(), !host.isEmpty, components.user == nil, components.password == nil
    else { return nil }
    let local = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1"
    guard scheme == "https" || (scheme == "http" && local) else { return nil }
    guard local || host.contains("."), !host.hasPrefix("."), !host.hasSuffix("."), !host.contains("..") else { return nil }
    let shownHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    let origin = "\(scheme)://\(shownHost)" + (components.port.map { ":\($0)" } ?? "")
    guard VaultOriginMatch.isWebOrigin(origin), VaultOriginMatch.isSecure(origin) else { return nil }
    return origin
  }

  func encoded() -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) }
  }

  static func decoded(_ value: String?) -> ArdiaStandaloneCode? {
    guard let value, let code = try? JSONDecoder().decode(ArdiaStandaloneCode.self, from: Data(value.utf8)),
      !code.uri.isEmpty, cleanedText(code.label) != nil
    else { return nil }
    return code
  }

  static func decodedAll(_ raw: [String: String]) -> [String: ArdiaStandaloneCode] {
    var codes: [String: ArdiaStandaloneCode] = [:]
    for (id, value) in raw where isId(id) {
      if let code = decoded(value) { codes[id] = code }
    }
    return codes
  }

  static func apply(_ change: (inout [String: ArdiaStandaloneCode]) -> Void, to raw: inout [String: String]) -> Bool {
    let before = decodedAll(raw)
    var after = before
    change(&after)
    var changed = false
    for id in Set(before.keys).union(after.keys) where isId(id) && before[id] != after[id] {
      if let code = after[id] {
        guard let value = code.encoded() else { continue }
        raw[id] = value
      } else {
        raw[id] = nil
      }
      changed = true
    }
    return changed
  }

  func metadata(id: String, period: Int?) -> [String: Any] {
    var object: [String: Any] = ["id": id, "label": label]
    if let issuer { object["issuer"] = issuer }
    if let website { object["website"] = website }
    if let period { object["period"] = period }
    if let createdAt, createdAt.isFinite { object["createdAt"] = createdAt * 1000 }
    return object
  }

  func matches(origin: String, userChose: Bool) -> Bool {
    guard VaultOriginMatch.isSecure(origin) else { return false }
    if userChose { return true }
    guard let website else { return false }
    return VaultOriginMatch.matches([website], origin: origin)
  }
}
