import Darwin
import Foundation

struct PluginFetchRequest: Equatable {
  let url: URL
  let method: String
  let headers: [String: String]
  let body: Data?
  let timeout: TimeInterval
}

enum PluginFetchPolicy {
  static let minTimeoutMs = 1000
  static let maxTimeoutMs = 60000
  static let maxResponseBytes = 700 * 1024
  static let maxRequestBytes = 512 * 1024
  static let maxRedirects = 5
  static let maxAllowedHosts = 256
  static let methods: Set<String> = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  static let refusedHeaders: Set<String> = [
    "host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization", "proxy-connection", "expect",
  ]
  static let crossOriginSafeHeaders: Set<String> = ["accept", "accept-language", "content-language", "content-type", "user-agent"]
  static let blockedNames: Set<String> = ["localhost", "metadata", "metadata.google.internal", "metadata.goog", "instance-data"]
  static let blockedSuffixes = [".localhost", ".local", ".internal", ".home.arpa", ".in-addr.arpa", ".ip6.arpa"]
  static let loopbackForTests = "127.0.0.1"

  static func clampedTimeout(_ ms: Int) -> TimeInterval {
    TimeInterval(min(maxTimeoutMs, max(minTimeoutMs, ms))) / 1000
  }

  static func normalizedHost(_ host: String) -> String {
    var lowered = host.lowercased()
    if lowered.hasPrefix("["), lowered.hasSuffix("]") { lowered = String(lowered.dropFirst().dropLast()) }
    while lowered.hasSuffix(".") { lowered.removeLast() }
    return lowered
  }

  static func hostAllowed(_ host: String, by allowedHosts: [String]) -> Bool {
    let host = normalizedHost(host)
    guard !host.isEmpty else { return false }
    for entry in allowedHosts.prefix(maxAllowedHosts) {
      let trimmed = entry.trimmingCharacters(in: .whitespaces)
      if trimmed == "*" { return true }
      let rule = normalizedHost(trimmed)
      if rule.hasPrefix("*.") {
        let apex = String(rule.dropFirst(2))
        guard !apex.isEmpty, !apex.contains("*") else { continue }
        if host.hasSuffix("." + apex) && host.count > apex.count + 1 { return true }
        continue
      }
      if !rule.isEmpty, !rule.contains("*"), rule == host { return true }
    }
    return false
  }

  static func ipv4Bytes(_ host: String) -> [UInt8]? {
    var address = in_addr()
    guard !host.isEmpty, host.utf8.allSatisfy({ $0 < 0x80 }), inet_aton(host, &address) == 1 else { return nil }
    let value = UInt32(bigEndian: address.s_addr)
    return [UInt8(value >> 24), UInt8((value >> 16) & 0xff), UInt8((value >> 8) & 0xff), UInt8(value & 0xff)]
  }

  static func ipv6Bytes(_ host: String) -> [UInt8]? {
    var address = in6_addr()
    let bare = host.split(separator: "%", maxSplits: 1).first.map(String.init) ?? host
    guard bare.contains(":"), inet_pton(AF_INET6, bare, &address) == 1 else { return nil }
    return withUnsafeBytes(of: &address) { Array($0) }
  }

  static func isBlockedIPv4(_ b: [UInt8]) -> Bool {
    guard b.count == 4 else { return true }
    switch (b[0], b[1], b[2]) {
    case (0, _, _), (10, _, _), (127, _, _): return true
    case (100, 64...127, _): return true
    case (169, 254, _): return true
    case (172, 16...31, _): return true
    case (192, 0, 0), (192, 0, 2), (192, 88, 99), (192, 168, _): return true
    case (198, 18...19, _), (198, 51, 100), (203, 0, 113): return true
    default: return b[0] >= 224
    }
  }

  static func isBlockedIPv6(_ b: [UInt8]) -> Bool {
    guard b.count == 16 else { return true }
    if b.allSatisfy({ $0 == 0 }) { return true }
    if b[0..<15].allSatisfy({ $0 == 0 }) && b[15] == 1 { return true }
    if b[0..<10].allSatisfy({ $0 == 0 }) && b[10] == 0xff && b[11] == 0xff { return isBlockedIPv4(Array(b[12..<16])) }
    if b[0..<12].allSatisfy({ $0 == 0 }) { return true }
    if b[0] == 0x00, b[1] == 0x64, b[2] == 0xff, b[3] == 0x9b { return b[4..<12].allSatisfy({ $0 == 0 }) ? isBlockedIPv4(Array(b[12..<16])) : true }
    if b[0] == 0x20, b[1] == 0x02 { return isBlockedIPv4(Array(b[2..<6])) }
    if b[0] == 0x20, b[1] == 0x01, b[2] == 0x0d, b[3] == 0xb8 { return true }
    if b[0] == 0x20, b[1] == 0x01, b[2] == 0x00, b[3] == 0x00 { return true }
    if b[0] & 0xfe == 0xfc { return true }
    if b[0] == 0xfe, b[1] & 0xc0 == 0x80 || b[1] & 0xc0 == 0xc0 { return true }
    return b[0] == 0xff
  }

  static func isBlockedAddress(_ host: String, allowLoopback: Bool = false) -> Bool {
    let host = normalizedHost(host)
    if allowLoopback && host == loopbackForTests { return false }
    if let v4 = ipv4Bytes(host) { return isBlockedIPv4(v4) }
    if let v6 = ipv6Bytes(host) { return isBlockedIPv6(v6) }
    return false
  }

  static func isIPLiteral(_ host: String) -> Bool {
    let host = normalizedHost(host)
    return ipv4Bytes(host) != nil || ipv6Bytes(host) != nil
  }

  static func isBlockedName(_ host: String) -> Bool {
    let host = normalizedHost(host)
    return blockedNames.contains(host) || blockedSuffixes.contains { host.hasSuffix($0) }
  }

  static func loopbackAllowed(isolated: Bool, allowedHosts: [String]) -> Bool {
    isolated && allowedHosts.contains(loopbackForTests)
  }

  static func check(_ url: URL, allowedHosts: [String], allowLoopback: Bool = false) -> String? {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return "only https addresses can be fetched" }
    guard url.user == nil, url.password == nil else { return "the address carries a user name or password" }
    guard let rawHost = url.host, !rawHost.isEmpty else { return "the address has no host" }
    if scheme == "http", !(allowLoopback && normalizedHost(rawHost) == loopbackForTests) { return "only https addresses can be fetched; plain http would send the request unencrypted" }
    guard rawHost.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7f }) else { return "the host isn't ASCII; send an international name as punycode (xn--)" }
    let host = normalizedHost(rawHost)
    if let port = url.port, port < 1 || port > 65535 { return "the port is out of range" }
    if isBlockedName(host) { return "\(host) is a local or internal name" }
    if isBlockedAddress(host, allowLoopback: allowLoopback) { return "\(host) is a private, loopback or link-local address" }
    guard hostAllowed(host, by: allowedHosts) else { return "\(host) isn't in this plugin's allowed hosts" }
    return nil
  }

  static func isToken(_ text: String) -> Bool {
    let allowed = Set("!#$%&'*+-.^_`|~".utf8)
    return !text.isEmpty && text.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || allowed.contains($0) }
  }

  static func checkedHeaders(_ headers: [String: String]) -> Result<[String: String], FolderRefusal> {
    var checked: [String: String] = [:]
    for (name, value) in headers {
      let lowered = name.lowercased()
      guard isToken(name) else { return .failure(FolderRefusal(reason: "the header name \(name) isn't valid")) }
      guard !value.utf8.contains(where: { $0 == 0x0d || $0 == 0x0a || $0 == 0 }) else { return .failure(FolderRefusal(reason: "the header \(name) has a line break")) }
      if refusedHeaders.contains(lowered) || lowered.hasPrefix("proxy-") || lowered.hasPrefix("sec-") { continue }
      checked[lowered] = value
    }
    return .success(checked)
  }

  static func request(
    url raw: String, method rawMethod: String, headers: [String: String], body: String?, timeoutMs: Int, allowedHosts: [String], allowLoopback: Bool
  ) -> Result<PluginFetchRequest, FolderRefusal> {
    guard raw.count <= 8192, let url = URL(string: raw) else { return .failure(FolderRefusal(reason: "the address isn't valid")) }
    if let problem = check(url, allowedHosts: allowedHosts, allowLoopback: allowLoopback) { return .failure(FolderRefusal(reason: problem)) }
    let method = rawMethod.isEmpty ? "GET" : rawMethod.uppercased()
    guard methods.contains(method) else { return .failure(FolderRefusal(reason: "\(rawMethod) isn't a method a plugin can use")) }
    let data = body.map { Data($0.utf8) }
    if let data, data.count > maxRequestBytes { return .failure(FolderRefusal(reason: "the request body is over \(maxRequestBytes / 1024) KB")) }
    if data != nil && (method == "GET" || method == "HEAD") { return .failure(FolderRefusal(reason: "a \(method) request can't have a body")) }
    switch checkedHeaders(headers) {
    case .failure(let refusal): return .failure(refusal)
    case .success(let checked):
      return .success(PluginFetchRequest(url: url, method: method, headers: checked, body: data, timeout: clampedTimeout(timeoutMs)))
    }
  }

  static func sameOrigin(_ from: URL, _ to: URL) -> Bool {
    from.scheme?.lowercased() == to.scheme?.lowercased() && from.host.map(normalizedHost) == to.host.map(normalizedHost) && PluginHttpCodec.port(of: from) == PluginHttpCodec.port(of: to)
  }

  static func redirectHeaders(_ headers: [String: String], from: URL, to: URL) -> [String: String] {
    guard !sameOrigin(from, to) else { return headers }
    return headers.filter { crossOriginSafeHeaders.contains($0.key.lowercased()) }
  }

  static func checkRedirect(to url: URL, count: Int, allowedHosts: [String], allowLoopback: Bool) -> String? {
    guard count <= maxRedirects else { return "it redirected more than \(maxRedirects) times" }
    return check(url, allowedHosts: allowedHosts, allowLoopback: allowLoopback).map { "it redirected to an address it may not reach: \($0)" }
  }

  static func resolvedAddressesBlocked(_ addresses: [String], allowLoopback: Bool) -> Bool {
    addresses.contains { isBlockedAddress($0, allowLoopback: allowLoopback) }
  }

  static func pinnedAddress(for url: URL, resolved: [String]?, allowLoopback: Bool) -> Result<String, FolderRefusal> {
    vettedAddresses(for: url, resolved: resolved, allowLoopback: allowLoopback).map { $0[0] }
  }

  static func vettedAddresses(for url: URL, resolved: [String]?, allowLoopback: Bool) -> Result<[String], FolderRefusal> {
    guard let raw = url.host, !raw.isEmpty else { return .failure(FolderRefusal(reason: "the address has no host")) }
    let host = normalizedHost(raw)
    if isIPLiteral(host) {
      return isBlockedAddress(host, allowLoopback: allowLoopback) ? .failure(FolderRefusal(reason: "\(host) is a private, loopback or link-local address")) : .success([host])
    }
    let found = (resolved ?? []).map(normalizedHost).filter(isIPLiteral)
    guard !found.isEmpty else { return .failure(FolderRefusal(reason: "\(host) couldn't be found")) }
    if resolvedAddressesBlocked(found, allowLoopback: allowLoopback) { return .failure(FolderRefusal(reason: "\(host) points at a private, loopback or link-local address")) }
    return .success(interleavedByFamily(found))
  }

  static func interleavedByFamily(_ addresses: [String]) -> [String] {
    var seen = Set<String>()
    let unique = addresses.filter { seen.insert($0).inserted }
    guard let first = unique.first else { return [] }
    let preferIPv6 = ipv6Bytes(first) != nil
    let preferred = unique.filter { (ipv6Bytes($0) != nil) == preferIPv6 }
    let other = unique.filter { (ipv6Bytes($0) != nil) != preferIPv6 }
    var ordered: [String] = []
    for index in 0..<max(preferred.count, other.count) {
      if index < preferred.count { ordered.append(preferred[index]) }
      if index < other.count { ordered.append(other[index]) }
    }
    return ordered
  }

  static func responseHeaders(_ fields: [AnyHashable: Any]) -> [String: String] {
    var headers: [String: String] = [:]
    for (key, value) in fields {
      guard let name = key as? String else { continue }
      headers[name.lowercased()] = "\(value)"
    }
    return headers
  }
}
