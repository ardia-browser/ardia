import Foundation

struct ApplePasswordsEntry: Equatable {
  let user: String
  let sites: [String]
}

struct ApplePasswordsCode: Equatable {
  let user: String
  let domain: String
  let source: String
  let code: String
}

enum ApplePasswordsReply {
  static let placeholderUser = "Passwords\u{a0}not\u{a0}saved"
  static let noPassword = "Not Included"
  static let entriesMax = 1000
  static let sitesMax = 100

  static func list(_ answer: [String: Any]) -> [[String: Any]] {
    if let list = answer["Entries"] as? [[String: Any]] { return Array(list.prefix(entriesMax)) }
    return Array(answer.keys.filter { $0.hasPrefix("Entry_") }.sorted().compactMap { answer[$0] as? [String: Any] }.prefix(entriesMax))
  }

  static func text(_ value: Any?) -> String? {
    guard let text = value as? NSString, ApplePasswordsMatch.fits(text) else { return nil }
    return text as String
  }

  static func entries(_ answer: [String: Any]) -> [ApplePasswordsEntry] {
    list(answer).compactMap { entry in
      guard let user = text(entry["USR"]), user != placeholderUser else { return nil }
      let sites = (entry["sites"] as? [Any] ?? []).prefix(sitesMax).compactMap(text)
      return ApplePasswordsEntry(user: user, sites: sites)
    }
  }

  static func password(_ answer: [String: Any], host: String, user: String) -> String? {
    let entries = list(answer)
    let entry = entries.first { ($0["sites"] as? [Any] ?? []).contains { $0 as? String == host } && text($0["USR"]) == user } ?? entries.first { text($0["USR"]) == user }
    guard let password = text(entry?["PWD"]), !password.isEmpty, password != noPassword else { return nil }
    return password
  }

  static func codes(_ answer: [String: Any]) -> [ApplePasswordsCode] {
    list(answer).compactMap { entry in
      guard let user = text(entry["username"] ?? ""), let domain = text(entry["domain"] ?? ""), let source = text(entry["source"] ?? ApplePasswordsMatch.timeCodeSource) else { return nil }
      let code = text(entry["code"]).flatMap { $0.range(of: "^[A-Za-z0-9]{4,10}$", options: .regularExpression) == nil ? nil : $0 } ?? ""
      return ApplePasswordsCode(user: user, domain: domain, source: source, code: code)
    }
  }
}

enum ApplePasswordsMatch {
  static let timeCodeSource = "totp"

  struct Login: Equatable {
    let user: String
    let insecure: Bool
  }

  static let probeLabel = "a."

  static let savedMax = 1024

  static func savable(username: Any?, password: Any?) -> (username: String, password: String)? {
    guard let password = password as? NSString, password.length > 0, fits(password) else { return nil }
    let username = username as? NSString ?? ""
    guard fits(username) else { return nil }
    return (username as String, password as String)
  }

  static func fits(_ text: NSString) -> Bool {
    guard text.length <= savedMax else { return false }
    var i = 0
    while i < text.length {
      let unit = text.character(at: i)
      if unit == 0 || UTF16.isTrailSurrogate(unit) { return false }
      if UTF16.isLeadSurrogate(unit) {
        guard i + 1 < text.length, UTF16.isTrailSurrogate(text.character(at: i + 1)) else { return false }
        i += 1
      }
      i += 1
    }
    return true
  }

  private static func labels(_ host: String) -> [Substring] { host.split(separator: ".") }

  private static func isAddress(_ host: String) -> Bool {
    host.contains(":") || labels(host).allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isNumber) }
  }

  static func normalized(_ host: String) -> String { host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) }

  static func probes(_ hosts: [String]) -> [String] {
    var out: [String] = []
    for host in Set(hosts.map(normalized)) {
      out.append(host)
      if !isAddress(host), labels(host).count > 2 { out.append(probeLabel + host) }
    }
    return out
  }

  static func site(_ host: String, domains: [String: String]) -> String {
    let name = normalized(host)
    let parts = labels(name)
    guard !isAddress(name), parts.count > 1 else { return name }
    guard let domain = domains[name] else { return name }
    if domain != name { return domain }
    if parts.count == 2 || domains[probeLabel + name] == name { return name }
    return parts.suffix(2).joined(separator: ".")
  }

  static func sameSite(_ a: String, _ b: String, domains: [String: String]) -> Bool {
    site(a, domains: domains) == site(b, domains: domains)
  }

  static func split(_ site: String) -> (insecure: Bool, host: String) {
    let lowered = site.lowercased()
    for (scheme, insecure) in [("http://", true), ("https://", false)] where lowered.hasPrefix(scheme) {
      let rest = String(lowered.dropFirst(scheme.count))
      let authority = rest.split(separator: "/", maxSplits: 1).first.map(String.init) ?? rest
      let host = authority.split(separator: ":").first.map(String.init) ?? authority
      return (insecure, normalized(host))
    }
    return (false, normalized(lowered))
  }

  static func siteHosts(_ entries: [ApplePasswordsEntry]) -> [String] {
    entries.flatMap { $0.sites.map { split($0).host } }
  }

  static func logins(_ entries: [ApplePasswordsEntry], scheme: String, host: String, domains: [String: String]) -> [Login] {
    let insecurePage = scheme.lowercased() == "http"
    let page = site(host, domains: domains)
    var seen = Set<String>()
    let found = entries.filter { entry in
      let sites = entry.sites.isEmpty ? [host] : entry.sites
      return sites.map(split).contains { $0.insecure == insecurePage && site($0.host, domains: domains) == page }
    }
    return found.compactMap { entry in seen.insert(entry.user).inserted ? Login(user: entry.user, insecure: insecurePage) : nil }
      .sorted { $0.user.localizedCaseInsensitiveCompare($1.user) == .orderedAscending }
  }

  static func typedFirst(_ codes: [ApplePasswordsCode], user: String?) -> [ApplePasswordsCode] {
    guard let typed = user?.lowercased() else { return codes }
    return codes.filter { $0.user.lowercased() == typed } + codes.filter { $0.user.lowercased() != typed }
  }

  static func codeHosts(_ codes: [ApplePasswordsCode]) -> [String] { codes.map { normalized($0.domain) }.filter { !$0.isEmpty } }

  static func codes(_ codes: [ApplePasswordsCode], host: String, domains: [String: String]) -> [ApplePasswordsCode] {
    let page = site(host, domains: domains)
    var seen = Set<String>()
    return codes.filter { code in
      code.source == timeCodeSource && site(code.domain.isEmpty ? host : code.domain, domains: domains) == page && seen.insert(code.user.lowercased()).inserted
    }
  }
}
