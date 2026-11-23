import CryptoKit
import Foundation

struct VaultPasskey: Codable, Equatable, Sendable {
  static let longestName = 256
  static let longestNameBytes = 1024

  var rpId: String
  var userHandle: String
  var userName: String
  var displayName: String
  var privateKey: String
  var createdAt: Double
  var origin: String?

  static func made(rpId: String, origin: String, userHandle: Data, userName: String, displayName: String, key: P256.Signing.PrivateKey,
                   at time: Double) -> VaultPasskey
  {
    VaultPasskey(rpId: rpId, userHandle: VaultBase64URL.encode(userHandle), userName: cleaned(userName), displayName: cleaned(displayName),
                 privateKey: key.rawRepresentation.base64EncodedString(), createdAt: time, origin: origin)
  }

  var signingKey: P256.Signing.PrivateKey? {
    guard let raw = Data(base64Encoded: privateKey), raw.count == 32 else { return nil }
    return try? P256.Signing.PrivateKey(rawRepresentation: raw)
  }

  var userHandleBytes: Data? { VaultBase64URL.decode(userHandle, longest: 64) }

  func encoded() -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) }
  }

  static func decoded(_ value: String?) -> VaultPasskey? {
    guard let value, value.utf8.count <= 16_384, let passkey = try? JSONDecoder().decode(VaultPasskey.self, from: Data(value.utf8)),
      VaultRelyingParty.isDomain(passkey.rpId) || passkey.rpId == "localhost", passkey.userHandleBytes?.isEmpty == false,
      passkey.signingKey != nil
    else { return nil }
    return passkey
  }

  static func isId(_ id: String) -> Bool {
    guard let raw = VaultBase64URL.decode(id, longest: VaultPasskeyRequest.longestCredentialId) else { return false }
    return !raw.isEmpty && VaultBase64URL.encode(raw) == id
  }

  static func decodedAll(_ raw: [String: String]) -> [String: VaultPasskey] {
    var all: [String: VaultPasskey] = [:]
    for (id, value) in raw where isId(id) {
      if let passkey = decoded(value) { all[id] = passkey }
    }
    return all
  }

  static func cleaned(_ text: String) -> String {
    let kept = text.unicodeScalars.filter {
      !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format && $0.properties.generalCategory != .lineSeparator
        && $0.properties.generalCategory != .paragraphSeparator
    }
    let trimmed = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespacesAndNewlines)
    var bytes = 0
    let fitting = String(trimmed.prefix(longestName)).unicodeScalars.prefix { scalar in
      bytes += UTF8.width(scalar)
      return bytes <= longestNameBytes
    }
    return String(String.UnicodeScalarView(fitting))
  }
}

struct VaultPasskeyRequest: Equatable, Sendable {
  static let longestChallenge = 4096
  static let longestUserId = 64
  static let longestCredentialId = 1023
  static let mostCredentials = 64
  static let shortestTimeout: Double = 10
  static let longestTimeout: Double = 600
  static let defaultTimeout: Double = 300

  enum Kind: Equatable, Sendable {
    case create
    case get
  }

  var kind: Kind
  var challenge: Data
  var rpId: String?
  var rpName: String
  var userId: Data
  var userName: String
  var displayName: String
  var credentials: [Data]
  var timeout: Double
  var conditional: Bool
  var credProps: Bool
  var appid: Bool
  var unsupported: Bool

  static func parse(_ message: [String: Any], kind: Kind) -> VaultPasskeyRequest? {
    guard let options = message["options"] as? [String: Any], let challengeText = options["challenge"] as? String,
      let challenge = VaultBase64URL.decode(challengeText, longest: longestChallenge), !challenge.isEmpty
    else { return nil }
    let mediation = message["mediation"] as? String
    var request = VaultPasskeyRequest(kind: kind, challenge: challenge, rpId: nil, rpName: "", userId: Data(), userName: "", displayName: "",
                                      credentials: [], timeout: defaultTimeout, conditional: false, credProps: false, appid: false,
                                      unsupported: false)
    switch (kind, mediation) {
    case (_, nil), (_, "optional"?), (_, "required"?): break
    case (.get, "conditional"?): request.conditional = true
    default: request.unsupported = true
    }
    if let timeout = options["timeout"] as? Double, timeout.isFinite, timeout > 0 {
      request.timeout = min(max(timeout / 1000, shortestTimeout), longestTimeout)
    }
    let hints = (options["hints"] as? [Any])?.compactMap { $0 as? String } ?? []
    if hints.first == "security-key" || hints.first == "hybrid" { request.unsupported = true }
    let extensions = options["extensions"] as? [String: Any] ?? [:]
    request.credProps = (extensions["credProps"] as? Bool) == true
    request.appid = extensions["appid"] is String
    let listName = kind == .create ? "excludeCredentials" : "allowCredentials"
    guard let credentials = credentialIds(options[listName]) else { return nil }
    request.credentials = credentials
    switch kind {
    case .create:
      guard let rp = options["rp"] as? [String: Any], let user = options["user"] as? [String: Any], let idText = user["id"] as? String,
        let userId = VaultBase64URL.decode(idText, longest: longestUserId), !userId.isEmpty, let name = user["name"] as? String
      else { return nil }
      request.rpId = rpIdValue(rp["id"])
      if present(rp["id"]), rp["id"] as? String == nil { return nil }
      request.rpName = VaultPasskey.cleaned(rp["name"] as? String ?? "")
      request.userId = userId
      request.userName = VaultPasskey.cleaned(name)
      request.displayName = VaultPasskey.cleaned(user["displayName"] as? String ?? "")
      if !offersES256(options["pubKeyCredParams"]) { request.unsupported = true }
      let selection = options["authenticatorSelection"] as? [String: Any] ?? [:]
      if selection["authenticatorAttachment"] as? String == "cross-platform" { request.unsupported = true }
      if options["attestation"] as? String == "enterprise" { request.unsupported = true }
    case .get:
      request.rpId = rpIdValue(options["rpId"])
      if present(options["rpId"]), options["rpId"] as? String == nil { return nil }
    }
    return request
  }

  private static func present(_ raw: Any?) -> Bool { raw != nil && !(raw is NSNull) }

  private static func rpIdValue(_ raw: Any?) -> String? {
    guard let text = raw as? String else { return nil }
    return text
  }

  private static func credentialIds(_ raw: Any?) -> [Data]? {
    guard let raw else { return [] }
    guard let list = raw as? [Any], list.count <= mostCredentials else { return nil }
    var ids: [Data] = []
    for case let entry as [String: Any] in list {
      guard entry["type"] as? String ?? "public-key" == "public-key" else { continue }
      guard let text = entry["id"] as? String, let id = VaultBase64URL.decode(text, longest: longestCredentialId), !id.isEmpty else { return nil }
      ids.append(id)
    }
    return ids
  }

  private static func offersES256(_ raw: Any?) -> Bool {
    guard let list = raw as? [Any], !list.isEmpty else { return true }
    return list.contains { entry in
      guard let entry = entry as? [String: Any] else { return false }
      return entry["type"] as? String == "public-key" && (entry["alg"] as? Double) == Double(VaultWebAuthn.es256)
    }
  }
}

struct VaultPasskeyCandidate: Sendable {
  var provider: String
  var credentialId: Data
  var item: String?
  var rpId: String
  var userName: String
  var displayName: String
  var discoverable: Bool

  var id: String { VaultBase64URL.encode(credentialId) }

  func metadata() -> [String: Any] {
    var object: [String: Any] = ["id": id, "provider": provider, "rpId": rpId, "userName": userName, "displayName": displayName]
    if let item { object["item"] = item }
    return object
  }
}

struct VaultPasskeySigner: Sendable {
  var key: P256.Signing.PrivateKey
  var userHandle: Data
}
