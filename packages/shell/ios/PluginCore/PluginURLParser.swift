import Foundation

enum PluginURLParser {
  static let defaultPorts = ["http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21]

  static func isSpecial(_ scheme: String) -> Bool { defaultPorts[scheme] != nil || scheme == "file" }

  static func cleaned(_ input: String) -> String {
    let kept = input.unicodeScalars.filter { $0 != "\t" && $0 != "\n" && $0 != "\r" }
    var scalars = Array(kept)
    while let first = scalars.first, first.value <= 0x20 { scalars.removeFirst() }
    while let last = scalars.last, last.value <= 0x20 { scalars.removeLast() }
    return String(String.UnicodeScalarView(scalars))
  }

  static func scheme(of text: String) -> String? {
    guard let colon = text.firstIndex(of: ":") else { return nil }
    let candidate = text[..<colon].unicodeScalars
    guard let first = candidate.first, first.isASCII, CharacterSet.letters.contains(first) else { return nil }
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "+-."))
    guard candidate.allSatisfy({ $0.isASCII && allowed.contains($0) }) else { return nil }
    return String(candidate).lowercased()
  }

  static func withForwardSlashes(_ text: String) -> String {
    let end = text.firstIndex { $0 == "?" || $0 == "#" } ?? text.endIndex
    return text[..<end].replacingOccurrences(of: "\\", with: "/") + text[end...]
  }

  static func hasOpaquePath(_ text: String, scheme: String) -> Bool {
    !isSpecial(scheme) && !text.dropFirst(scheme.count + 1).hasPrefix("/")
  }

  static func endsInNumber(_ host: String) -> Bool {
    var labels = host.split(separator: ".", omittingEmptySubsequences: false)
    if labels.last == "", labels.count > 1 { labels.removeLast() }
    guard let last = labels.last, !last.isEmpty else { return false }
    if last.allSatisfy({ $0.isASCII && $0.isNumber }) { return true }
    let lowered = last.lowercased()
    return lowered.hasPrefix("0x") && lowered.dropFirst(2).allSatisfy(\.isHexDigit)
  }

  static func ipv4Number(_ label: Substring) -> UInt64? {
    guard !label.isEmpty, label.count <= 32 else { return nil }
    let lowered = label.lowercased()
    if lowered.hasPrefix("0x") {
      let digits = lowered.dropFirst(2)
      return digits.isEmpty ? 0 : UInt64(digits, radix: 16)
    }
    if lowered.count > 1, lowered.hasPrefix("0") { return UInt64(lowered.dropFirst(), radix: 8) }
    return UInt64(lowered, radix: 10)
  }

  static func canonicalIPv4(_ host: String) -> String? {
    var labels = host.split(separator: ".", omittingEmptySubsequences: false)
    if labels.last == "", labels.count > 1 { labels.removeLast() }
    guard (1...4).contains(labels.count) else { return nil }
    var numbers: [UInt64] = []
    for label in labels {
      guard let number = ipv4Number(label) else { return nil }
      numbers.append(number)
    }
    guard numbers.dropLast().allSatisfy({ $0 <= 255 }), let last = numbers.last, last < (1 << (8 * (5 - UInt64(numbers.count)))) else { return nil }
    var address = last
    for (index, number) in numbers.dropLast().enumerated() { address += number << (8 * (3 - UInt64(index))) }
    return [24, 16, 8, 0].map { String((address >> UInt64($0)) & 0xff) }.joined(separator: ".")
  }

  static func isSingleDot(_ segment: Substring) -> Bool {
    let lowered = segment.lowercased()
    return lowered == "." || lowered == "%2e"
  }

  static func isDoubleDot(_ segment: Substring) -> Bool {
    ["..", ".%2e", "%2e.", "%2e%2e"].contains(segment.lowercased())
  }

  static func withoutDotSegments(_ path: String) -> String {
    guard path.hasPrefix("/") else { return path }
    let segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
    var kept: [Substring] = []
    for (index, segment) in segments.enumerated() {
      let isLast = index == segments.count - 1
      if isDoubleDot(segment) {
        if !kept.isEmpty { kept.removeLast() }
        if isLast { kept.append("") }
      } else if isSingleDot(segment) {
        if isLast { kept.append("") }
      } else {
        kept.append(segment)
      }
    }
    return "/" + kept.joined(separator: "/")
  }

  static func parse(_ input: String, base: String?) -> [String: Any]? {
    var text = cleaned(input)
    var baseText: String?
    var baseScheme: String?
    if let base {
      let cleanedBase = cleaned(base)
      guard let scheme = scheme(of: cleanedBase), parse(cleanedBase, base: nil) != nil else { return nil }
      baseText = isSpecial(scheme) ? withForwardSlashes(cleanedBase) : cleanedBase
      baseScheme = scheme
    }
    let ownScheme = scheme(of: text)
    if ownScheme == nil, let baseText, let baseScheme {
      if text.isEmpty {
        guard var fromBase = parse(baseText, base: nil) else { return nil }
        fromBase["hash"] = ""
        return fromBase
      }
      if hasOpaquePath(baseText, scheme: baseScheme), !text.hasPrefix("#") { return nil }
    }
    if let effective = ownScheme ?? baseScheme, isSpecial(effective) { text = withForwardSlashes(text) }
    let baseURL = baseText.flatMap { URL(string: $0) }
    guard let url = URL(string: text, relativeTo: baseURL)?.absoluteURL, let scheme = url.scheme?.lowercased(), !scheme.isEmpty,
      let parts = URLComponents(url: url, resolvingAgainstBaseURL: true)
    else { return nil }
    let special = isSpecial(scheme)
    let afterScheme = url.absoluteString.dropFirst(scheme.count + 1)
    let authority = afterScheme.hasPrefix("//")
    var hostname = parts.encodedHost ?? ""
    if special {
      hostname = hostname.lowercased()
      if scheme == "file" {
        if hostname == "localhost" { hostname = "" }
      } else {
        guard !hostname.isEmpty else { return nil }
        if endsInNumber(hostname) {
          guard let canonical = canonicalIPv4(hostname) else { return nil }
          hostname = canonical
        }
      }
    }
    if let number = parts.port, !(0...65535).contains(number) { return nil }
    var port = parts.port.map(String.init) ?? ""
    if let known = defaultPorts[scheme], parts.port == known { port = "" }
    var path = withoutDotSegments(parts.percentEncodedPath)
    if authority && path.isEmpty && special { path = "/" }
    return [
      "protocol": scheme + ":", "username": parts.percentEncodedUser ?? "", "password": parts.percentEncodedPassword ?? "",
      "hostname": hostname, "port": port, "pathname": path,
      "search": parts.percentEncodedQuery.map { $0.isEmpty ? "" : "?" + $0 } ?? "", "hash": parts.percentEncodedFragment.map { $0.isEmpty ? "" : "#" + $0 } ?? "",
      "authority": authority, "special": special,
    ]
  }
}
