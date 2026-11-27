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

enum ApplePasswordsMatch {
  static let timeCodeSource = "totp"

  struct Login: Equatable {
    let user: String
    let insecure: Bool
  }

  static let probeLabel = "a."

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
    let domain = domains[name] ?? name
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

  static func codeHosts(_ codes: [ApplePasswordsCode]) -> [String] { codes.map { normalized($0.domain) }.filter { !$0.isEmpty } }

  static func codes(_ codes: [ApplePasswordsCode], host: String, domains: [String: String]) -> [ApplePasswordsCode] {
    let page = site(host, domains: domains)
    var seen = Set<String>()
    return codes.filter { code in
      code.source == timeCodeSource && site(code.domain.isEmpty ? host : code.domain, domains: domains) == page && seen.insert(code.user.lowercased()).inserted
    }
  }
}
