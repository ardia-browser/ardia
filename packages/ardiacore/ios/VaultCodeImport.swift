import Foundation

enum VaultCodeImport {
  struct Row: Equatable, Sendable {
    let origin: String
    let username: String
    let uri: String
    let name: String
  }

  static let urlKeys = ["url", "login_uri", "website", "web site", "origin", "hostname", "login url"]
  static let userKeys = ["username", "login_username", "login", "user", "email", "user name"]
  static let nameKeys = ["name", "title", "label", "account", "account name", "issuer"]
  static let codeKeys = ["otpauth", "totp", "login_totp", "otp", "one-time password", "one time password", "otpauth uri", "2fa", "authenticator key"]
  static let longestFile = 32 * 1024 * 1024

  static func rows(_ text: String) -> [Row] {
    let table = csv(text)
    guard let header = table.first?.map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) else { return [] }
    func column(_ keys: [String]) -> Int? { keys.lazy.compactMap { header.firstIndex(of: $0) }.first }
    guard let code = column(codeKeys) else { return [] }
    let url = column(urlKeys)
    let user = column(userKeys)
    let name = column(nameKeys)
    func field(_ row: [String], _ index: Int?) -> String {
      guard let index, index < row.count else { return "" }
      return row[index].trimmingCharacters(in: .whitespacesAndNewlines)
    }
    var found: [Row] = []
    for row in table.dropFirst() {
      let secret = field(row, code)
      guard !secret.isEmpty else { continue }
      let origin = origin(ofLogin: field(row, url))
      guard let uri = VaultTotpURI.setupURI(inText: secret, origin: origin ?? "") else { continue }
      let entry = Row(origin: origin ?? "", username: field(row, user), uri: uri, name: field(row, name))
      if !entry.origin.isEmpty, let index = found.firstIndex(where: { $0.origin == entry.origin && $0.username == entry.username }) {
        found[index] = entry
      } else {
        found.append(entry)
      }
    }
    return found
  }

  static func plan(_ wanted: [(String, String)], existing: [String: String]) -> (fresh: [(String, String)], replacing: [(String, String)]) {
    var fresh: [(String, String)] = []
    var replacing: [(String, String)] = []
    for (id, uri) in wanted {
      guard let held = existing[id] else {
        fresh.append((id, uri))
        continue
      }
      if VaultTotpSecret(held) != VaultTotpSecret(uri) { replacing.append((id, uri)) }
    }
    return (fresh, replacing)
  }

  static func standalone(_ rows: [Row], matched: Set<Int>, existing: [ArdiaStandaloneCode], loginCodes: [String], now: Double) -> [ArdiaStandaloneCode] {
    var secrets = (existing.map(\.uri) + loginCodes).compactMap { VaultTotpSecret($0) }
    var made: [ArdiaStandaloneCode] = []
    for (index, row) in rows.enumerated() where !matched.contains(index) {
      guard let secret = VaultTotpSecret(row.uri), !secrets.contains(secret) else { continue }
      let names = VaultTotpURI.labels(row.uri) ?? (issuer: "", account: "")
      let site = row.origin.isEmpty ? "" : VaultOriginMatch.siteName(of: row.origin) ?? ""
      let label = [row.name, names.account, names.issuer, site].first { !$0.isEmpty } ?? ""
      let issuer = names.issuer.caseInsensitiveCompare(label) == .orderedSame ? nil : names.issuer
      guard let code = ArdiaStandaloneCode.made(uri: row.uri, label: label, issuer: issuer, website: row.origin.isEmpty ? nil : row.origin, at: now) else { continue }
      secrets.append(secret)
      made.append(code)
    }
    return made
  }

  static func origin(ofLogin url: String) -> String? {
    for part in url.split(separator: ",") {
      let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { continue }
      let absolute: String
      if trimmed.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) != nil {
        absolute = trimmed
      } else if trimmed.hasPrefix("//") {
        absolute = "https:" + trimmed
      } else {
        absolute = "https://" + trimmed
      }
      guard let range = absolute.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+"#, options: .regularExpression) else { continue }
      let authority = String(absolute[range])
      guard URLComponents(string: authority)?.host?.isEmpty == false, let origin = VaultOriginMatch.canonicalOrigin(authority),
        VaultOriginMatch.isWebOrigin(origin)
      else { continue }
      return origin
    }
    return nil
  }

  static func csv(_ text: String) -> [[String]] {
    var rows: [[String]] = []
    var row: [String] = []
    var field = ""
    var quoted = false
    var iterator = text.unicodeScalars.makeIterator()
    var pending = iterator.next()
    if pending == "\u{FEFF}" { pending = iterator.next() }
    func endRow() {
      row.append(field)
      field = ""
      if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
      row = []
    }
    while let character = pending {
      pending = iterator.next()
      if quoted {
        if character == "\"" {
          if pending == "\"" {
            field.unicodeScalars.append("\"")
            pending = iterator.next()
          } else {
            quoted = false
          }
        } else {
          field.unicodeScalars.append(character)
        }
        continue
      }
      switch character {
      case "\"" where field.isEmpty: quoted = true
      case ",":
        row.append(field)
        field = ""
      case "\r":
        if pending == "\n" { pending = iterator.next() }
        endRow()
      case "\n": endRow()
      default: field.unicodeScalars.append(character)
      }
    }
    if !field.isEmpty || !row.isEmpty { endRow() }
    return rows
  }
}
