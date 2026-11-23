import Foundation

enum VaultTotpURI {
  enum Found: Equatable, Sendable {
    case none
    case one(String)
    case many
  }

  static let longestLabel = 120
  static let shortestKey = 10
  static let keyCharacters = 16...128

  static func setupURI(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let secret = VaultTotpSecret(trimmed), secret.key.count >= shortestKey else { return nil }
    let lowered = trimmed.lowercased()
    if lowered.hasPrefix("steam://") {
      return built(path: "Steam", secret: String(trimmed.dropFirst("steam://".count)), extra: [
        URLQueryItem(name: "issuer", value: "Steam"), URLQueryItem(name: "encoder", value: "steam"),
        URLQueryItem(name: "digits", value: "\(VaultTotpSecret.steamDigits)"),
      ])
    }
    guard lowered.hasPrefix("otpauth://"), var components = VaultTotpSecret.components(trimmed) else { return nil }
    components.scheme = "otpauth"
    components.host = "totp"
    if !components.percentEncodedPath.hasPrefix("/") { components.percentEncodedPath = "/" + components.percentEncodedPath }
    guard let uri = components.string, VaultTotpSecret(uri) == secret else { return nil }
    return uri
  }

  static func found(inPayloads payloads: [String]) -> Found {
    var distinct: [String] = []
    for payload in payloads {
      guard let uri = setupURI(payload), let secret = VaultTotpSecret(uri) else { continue }
      if !distinct.contains(where: { VaultTotpSecret($0) == secret }) { distinct.append(uri) }
    }
    switch distinct.count {
    case 0: return .none
    case 1: return .one(distinct[0])
    default: return .many
    }
  }

  static func setupURI(inText text: String, origin: String, allowingBareKey: Bool = false) -> String? {
    guard text.count <= VaultTotpSecret.longestText else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if let direct = setupURI(trimmed) { return direct }
    if let range = text.range(of: #"(otpauth|steam)://[^\s"'<>]+"#, options: [.regularExpression, .caseInsensitive]) {
      return setupURI(String(text[range]))
    }
    if let named = keyURI(text, origin: origin) { return named }
    return allowingBareKey ? bareKeyURI(text) : nil
  }

  static func bareKeyURI(_ text: String) -> String? {
    let cleaned = VaultTotpSecret.cleanedKey(text)
    guard keyCharacters.contains(cleaned.count), let key = VaultTotpSecret.base32(cleaned), key.count >= shortestKey else { return nil }
    return built(path: "", secret: cleaned, extra: [])
  }

  static func keyURI(_ text: String, origin: String) -> String? {
    let cleaned = VaultTotpSecret.cleanedKey(text)
    guard keyCharacters.contains(cleaned.count), let key = VaultTotpSecret.base32(cleaned), key.count >= shortestKey,
      VaultOriginMatch.isSecure(origin), let site = VaultOriginMatch.siteName(of: origin)
    else { return nil }
    return built(path: site, secret: cleaned, extra: [URLQueryItem(name: "issuer", value: site)])
  }

  private static func built(path: String, secret: String, extra: [URLQueryItem]) -> String? {
    var components = URLComponents()
    components.scheme = "otpauth"
    components.host = "totp"
    components.path = "/" + path
    components.queryItems = [URLQueryItem(name: "secret", value: VaultTotpSecret.cleanedKey(secret))] + extra
    guard let uri = components.string, VaultTotpSecret(uri) != nil else { return nil }
    return uri
  }

  static func labels(_ uri: String) -> (issuer: String, account: String)? {
    guard VaultTotpSecret(uri) != nil, let components = VaultTotpSecret.components(uri) else { return nil }
    let path = components.path
    let label = path.hasPrefix("/") ? String(path.dropFirst()) : path
    let parts = label.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let named = VaultTotpSecret.query(components)["issuer"].flatMap { $0.isEmpty ? nil : $0 }
    let issuer = named ?? (parts.count == 2 ? parts[0] : "")
    var account = parts.count == 2 ? parts[1] : (parts.first ?? "")
    if parts.count == 1, let named, account.caseInsensitiveCompare(named) == .orderedSame { account = "" }
    return (clipped(issuer), clipped(account))
  }

  private static func clipped(_ text: String) -> String {
    let shown = String.UnicodeScalarView(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !CharacterSet.newlines.contains($0) })
    return String(String(shown).prefix(longestLabel))
  }
}
