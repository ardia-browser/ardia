import Foundation
import os

enum VaultMatchTier: Int, Comparable, Sendable {
  case none = 0
  case sibling = 1
  case subdomain = 2
  case www = 3
  case sameHost = 4
  case exact = 5

  static func < (lhs: VaultMatchTier, rhs: VaultMatchTier) -> Bool { lhs.rawValue < rhs.rawValue }
}

enum VaultPublicSuffix {
  private struct Rules: Sendable {
    var exact: Set<String> = []
    var wildcard: Set<String> = []
    var exception: Set<String> = []
  }

  private static let rules: Rules = {
    var built = Rules()
    for group in VaultPublicSuffixRules.text.split(separator: ";") {
      guard let colon = group.firstIndex(of: ":") else { continue }
      let tld = String(group[..<colon])
      for prefix in group[group.index(after: colon)...].split(separator: ",", omittingEmptySubsequences: false) {
        let rule = prefix.isEmpty ? tld : "\(prefix).\(tld)"
        if rule.hasPrefix("!") {
          built.exception.insert(String(rule.dropFirst()))
        } else if rule.hasPrefix("*.") {
          built.wildcard.insert(String(rule.dropFirst(2)))
        } else {
          built.exact.insert(rule)
        }
      }
    }
    return built
  }()

  static func suffix(of host: String) -> String {
    var start = host.startIndex
    while true {
      let candidate = String(host[start...])
      let dot = candidate.firstIndex(of: ".")
      if rules.exception.contains(candidate) { return dot.map { String(candidate[candidate.index(after: $0)...]) } ?? "" }
      if rules.exact.contains(candidate) { return candidate }
      guard let dot else { return candidate }
      if rules.wildcard.contains(String(candidate[candidate.index(after: dot)...])) { return candidate }
      start = host.index(start, offsetBy: candidate.distance(from: candidate.startIndex, to: dot) + 1)
    }
  }
}

enum VaultOriginMatch {
  struct Site: Sendable, Equatable {
    let scheme: String
    let host: String
    let port: Int?
    let schemeGiven: Bool
  }

  private static let localHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]
  private static let cacheLimit = 50_000
  private static let parsed = OSAllocatedUnfairLock(initialState: [String: Site?]())
  private static let registrable = OSAllocatedUnfairLock(initialState: [String: String]())

  static func isLocalHost(_ host: String) -> Bool { localHosts.contains(normalized(host)) }

  static func isSecure(_ origin: String) -> Bool {
    guard let page = site(origin, assumingHTTPS: false) else { return false }
    return page.scheme == "https" || (page.scheme == "http" && localHosts.contains(page.host))
  }

  static func isWebOrigin(_ origin: String) -> Bool {
    let lowered = origin.lowercased()
    return (lowered.hasPrefix("https://") || lowered.hasPrefix("http://")) && host(of: origin) != nil
  }

  static func host(of text: String) -> String? { site(text, assumingHTTPS: true)?.host }

  static func canonicalOrigin(_ text: String) -> String? {
    guard let found = site(text, assumingHTTPS: true), found.scheme == "https" || found.scheme == "http" else { return nil }
    let host = found.host.contains(":") ? "[\(found.host)]" : found.host
    guard let port = found.port, port != defaultPort(found.scheme) else { return "\(found.scheme)://\(host)" }
    return "\(found.scheme)://\(host):\(port)"
  }

  static func siteName(of text: String) -> String? {
    host(of: text).map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }
  }

  static func matches(_ urls: [String], origin: String) -> Bool { tier(urls, origin: origin) >= .subdomain }

  static func matches(_ url: String, origin: String) -> Bool { tier(url, origin: origin) >= .subdomain }

  static func tier(_ urls: [String], origin: String) -> VaultMatchTier {
    urls.reduce(.none) { max($0, tier($1, origin: origin)) }
  }

  static func tier(_ urls: [String], modes: [String]?, origin: String) -> VaultMatchTier {
    guard let modes, modes.count == urls.count else { return tier(urls, origin: origin) }
    return zip(urls, modes).reduce(.none) { max($0, capped(tier($1.0, origin: origin), mode: $1.1)) }
  }

  static func capped(_ tier: VaultMatchTier, mode: String) -> VaultMatchTier {
    switch mode {
    case "exact": return tier == .exact ? .exact : .none
    case "host": return tier >= .sameHost ? tier : .none
    default: return tier
    }
  }

  static func tier(_ url: String, origin: String) -> VaultMatchTier {
    guard isSecure(origin), let page = site(origin, assumingHTTPS: false), let saved = site(url, assumingHTTPS: true),
      saved.scheme == "https" || saved.scheme == "http"
    else { return .none }
    let pagePort = page.port ?? defaultPort(page.scheme)
    if let port = saved.port, port != pagePort { return .none }
    if saved.port == nil, pagePort != defaultPort(page.scheme) {
      return localHosts.contains(page.host) && saved.host == page.host ? .sibling : .none
    }
    if saved.host == page.host { return sameOrigin(page, saved) ? .exact : .sameHost }
    guard !isAddress(saved.host), !isAddress(page.host) else { return .none }
    let pageHost = bare(page.host)
    let savedHost = bare(saved.host)
    if pageHost == savedHost { return .www }
    let domain = registrableDomain(pageHost)
    guard !domain.isEmpty, registrableDomain(savedHost) == domain else { return .none }
    if pageHost.hasSuffix("." + savedHost) || savedHost.hasSuffix("." + pageHost) { return .subdomain }
    return .sibling
  }

  static func registrableDomain(_ host: String) -> String {
    let key = normalized(host)
    if let known = registrable.withLock({ $0[key] }) { return known }
    let found = registrableUncached(key)
    registrable.withLock { cache in
      if cache.count >= cacheLimit { cache.removeAll() }
      cache[key] = found
    }
    return found
  }

  static func siteKey(_ host: String) -> String {
    let value = bare(normalized(host))
    let domain = isAddress(value) ? "" : registrableDomain(value)
    return domain.isEmpty ? value : domain
  }

  private static func site(_ text: String, assumingHTTPS: Bool) -> Site? {
    let key = (assumingHTTPS ? "1" : "0") + text
    if let known = parsed.withLock({ $0[key] }) { return known }
    let found = parse(text, assumingHTTPS: assumingHTTPS)
    parsed.withLock { cache in
      if cache.count >= cacheLimit { cache.removeAll() }
      cache[key] = .some(found)
    }
    return found
  }

  private static func parse(_ text: String, assumingHTTPS: Bool) -> Site? {
    let trimmed = trimmedLikeURLs(text)
    let value = trimmed.contains("\\") ? trimmed.replacingOccurrences(of: "\\", with: "/") : trimmed
    guard !value.isEmpty else { return nil }
    let scheme: String
    var rest: Substring
    let schemeGiven: Bool
    if let separator = value.range(of: "://"), isScheme(value[..<separator.lowerBound]) {
      scheme = value[..<separator.lowerBound].lowercased()
      rest = value[separator.upperBound...]
      schemeGiven = true
    } else {
      guard assumingHTTPS else { return nil }
      scheme = "https"
      rest = value[...]
      schemeGiven = false
    }
    if let end = rest.firstIndex(where: { "/?#".contains($0) }) { rest = rest[..<end] }
    if let at = rest.firstIndex(of: "@") { rest = rest[rest.index(after: at)...] }
    var rawHost: Substring
    var portText: Substring = ""
    if rest.hasPrefix("[") {
      guard let close = rest.firstIndex(of: "]") else { return nil }
      rawHost = rest[...close]
      let after = rest[rest.index(after: close)...]
      if after.hasPrefix(":") { portText = after.dropFirst() }
    } else if let colon = rest.firstIndex(of: ":") {
      rawHost = rest[..<colon]
      portText = rest[rest.index(after: colon)...]
    } else {
      rawHost = rest
    }
    let digits = portText.prefix { $0.isASCII && $0.isNumber }
    let port = digits.isEmpty ? nil : Int(digits)
    if !digits.isEmpty, (port ?? Int.max) > 65535 { return nil }
    let host = asciiHost(normalized(String(rawHost)))
    guard !host.isEmpty, host.utf8.allSatisfy(isHostByte) else { return nil }
    return Site(scheme: scheme, host: host, port: port, schemeGiven: schemeGiven)
  }

  static func trimmedLikeURLs(_ text: String) -> String {
    let scalars = text.unicodeScalars
    guard let first = scalars.firstIndex(where: { $0.value > 0x20 }), let last = scalars.lastIndex(where: { $0.value > 0x20 }) else { return "" }
    if first == scalars.startIndex && last == scalars.index(before: scalars.endIndex) { return text }
    return String(scalars[first...last])
  }

  private static func isScheme(_ text: Substring) -> Bool {
    guard let first = text.unicodeScalars.first, first.isASCII, first.properties.isAlphabetic else { return false }
    return text.unicodeScalars.allSatisfy { $0.isASCII && ($0.properties.isAlphabetic || ("0"..."9").contains($0) || "+.-".unicodeScalars.contains($0)) }
  }

  private static func isHostByte(_ byte: UInt8) -> Bool {
    (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x30 && byte <= 0x39) || byte == 0x2D || byte == 0x2E
      || byte == 0x3A || byte == 0x5F
  }

  private static func asciiHost(_ host: String) -> String {
    guard host.utf8.contains(where: { $0 >= 0x80 }) else { return host }
    return host.split(separator: ".", omittingEmptySubsequences: false).map { label -> String in
      guard label.contains(where: { !$0.isASCII }), let encoded = VaultPunycode.encode(String(label)) else { return String(label) }
      return "xn--" + encoded
    }.joined(separator: ".")
  }

  private static func registrableUncached(_ host: String) -> String {
    guard !host.isEmpty else { return "" }
    if isAddress(host) || localHosts.contains(host) { return host }
    let suffix = VaultPublicSuffix.suffix(of: host)
    guard suffix != host, host.hasSuffix("." + suffix) else { return "" }
    let head = host.dropLast(suffix.count + 1)
    let label = head.split(separator: ".").last.map(String.init) ?? String(head)
    return "\(label).\(suffix)"
  }

  private static func sameOrigin(_ page: Site, _ saved: Site) -> Bool {
    let scheme = saved.schemeGiven ? saved.scheme == page.scheme : page.scheme == "https" || localHosts.contains(page.host)
    let port = saved.port != nil || (page.port ?? defaultPort(page.scheme)) == defaultPort(page.scheme)
    return scheme && port
  }

  private static func bare(_ host: String) -> String {
    guard host.hasPrefix("www.") else { return host }
    let rest = String(host.dropFirst(4))
    let domain = registrableDomain(host)
    return !domain.isEmpty && domain == registrableDomain(rest) ? rest : host
  }

  private static func isAddress(_ host: String) -> Bool {
    host.contains(":") || host.allSatisfy { $0.isASCII && ($0.isNumber || $0 == ".") }
  }

  private static func defaultPort(_ scheme: String) -> Int { scheme == "http" ? 80 : 443 }

  private static func normalized(_ host: String) -> String {
    let plain = host.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D || $0 == 0x2E }
    if plain && host.last != "." { return host }
    var value = host.lowercased()
    if value.hasPrefix("[") && value.hasSuffix("]") { value = String(value.dropFirst().dropLast()) }
    while value.hasSuffix(".") { value.removeLast() }
    return value
  }
}

struct VaultSiteIndex: Sendable {
  private var entriesBySite: [String: [Int]] = [:]

  init(_ urlsOfEntries: [[String]]) {
    for (entry, urls) in urlsOfEntries.enumerated() {
      var keys = Set<String>()
      for url in urls {
        if let host = VaultOriginMatch.host(of: url) { keys.insert(VaultOriginMatch.siteKey(host)) }
      }
      for key in keys { entriesBySite[key, default: []].append(entry) }
    }
  }

  func entries(near origin: String) -> [Int] {
    guard let host = VaultOriginMatch.host(of: origin) else { return [] }
    return entriesBySite[VaultOriginMatch.siteKey(host)] ?? []
  }
}

enum VaultPunycode {
  private static let base = 36
  private static let tMin = 1
  private static let tMax = 26
  private static let skew = 38
  private static let damp = 700
  private static let initialBias = 72
  private static let initialN = 128

  static func encode(_ input: String) -> String? {
    let scalars = input.unicodeScalars.map { Int($0.value) }
    var output = scalars.filter { $0 < 0x80 }.compactMap { Unicode.Scalar($0).map(Character.init) }.map(String.init).joined()
    let basicCount = output.count
    var handled = basicCount
    if basicCount > 0 { output += "-" }
    var n = initialN
    var delta = 0
    var bias = initialBias
    while handled < scalars.count {
      guard let m = scalars.filter({ $0 >= n }).min() else { return nil }
      delta += (m - n) * (handled + 1)
      n = m
      for scalar in scalars {
        if scalar < n { delta += 1 }
        if scalar == n {
          var q = delta
          var k = base
          while true {
            let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)
            if q < t { break }
            output.append(digit(t + (q - t) % (base - t)))
            q = (q - t) / (base - t)
            k += base
          }
          output.append(digit(q))
          bias = adapt(delta, handled + 1, handled == basicCount)
          delta = 0
          handled += 1
        }
      }
      delta += 1
      n += 1
    }
    return output
  }

  private static func digit(_ value: Int) -> Character {
    Character(Unicode.Scalar(UInt8(value < 26 ? value + 97 : value + 22)))
  }

  private static func adapt(_ delta: Int, _ count: Int, _ first: Bool) -> Int {
    var value = first ? delta / damp : delta / 2
    value += value / count
    var k = 0
    while value > ((base - tMin) * tMax) / 2 {
      value /= base - tMin
      k += base
    }
    return k + (((base - tMin + 1) * value) / (value + skew))
  }
}
