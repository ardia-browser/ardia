import CryptoKit
import Foundation

enum BitwardenPasskeys {
  static func credentialId(_ text: String) -> Data? {
    if text.hasPrefix("b64.") { return VaultBase64URL.decode(String(text.dropFirst(4)), longest: VaultPasskeyRequest.longestCredentialId) }
    guard text.count == 36, let uuid = UUID(uuidString: text) else { return nil }
    return withUnsafeBytes(of: uuid.uuid) { Data($0) }
  }

  static func metadata(_ entry: [String: Any]) -> VaultItemPasskey? {
    guard VaultJSON.string(entry["keyType"]) ?? "public-key" == "public-key", VaultJSON.string(entry["keyAlgorithm"]) == "ECDSA",
      VaultJSON.string(entry["keyCurve"]) == "P-256", let rawId = VaultJSON.string(entry["credentialId"]), let id = credentialId(rawId),
      let rpId = VaultJSON.string(entry["rpId"])?.lowercased(), VaultRelyingParty.isDomain(rpId)
    else { return nil }
    let discoverable = (entry["discoverable"] as? String).map { $0 == "true" } ?? VaultJSON.bool(entry["discoverable"]) ?? false
    return VaultItemPasskey(credentialId: VaultBase64URL.encode(id), rpId: rpId, userName: VaultPasskey.cleaned(VaultJSON.string(entry["userName"]) ?? ""),
                            displayName: VaultPasskey.cleaned(VaultJSON.string(entry["userDisplayName"]) ?? ""), discoverable: discoverable,
                            counter: VaultJSON.int(entry["counter"]) ?? 0)
  }

  static func signer(_ entries: [[String: Any]], credential: Data) -> VaultPasskeySigner? {
    for entry in entries {
      guard let rawId = VaultJSON.string(entry["credentialId"]), credentialId(rawId) == credential, metadata(entry)?.counter == 0,
        let keyText = VaultJSON.string(entry["keyValue"]), let der = VaultBase64URL.decode(keyText, longest: 512),
        let key = try? P256.Signing.PrivateKey(derRepresentation: der), let handleText = VaultJSON.string(entry["userHandle"]),
        let handle = VaultBase64URL.decode(handleText, longest: VaultPasskeyRequest.longestUserId), !handle.isEmpty
      else { continue }
      return VaultPasskeySigner(key: key, userHandle: handle)
    }
    return nil
  }
}

extension BitwardenPasskeys {
  struct NewCredential: Sendable {
    var credentialId: UUID
    var key: P256.Signing.PrivateKey
    var rpId: String
    var rpName: String
    var userHandle: Data
    var userName: String
    var displayName: String
    var createdAt: Date

    var rawId: Data { withUnsafeBytes(of: credentialId.uuid) { Data($0) } }

    func json() -> [String: Any] {
      let date = ISO8601DateFormatter()
      date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return [
        "credentialId": credentialId.uuidString.lowercased(), "keyType": "public-key", "keyAlgorithm": "ECDSA", "keyCurve": "P-256",
        "keyValue": VaultBase64URL.encode(key.derRepresentation), "rpId": rpId, "rpName": rpName.isEmpty ? rpId : rpName,
        "userHandle": VaultBase64URL.encode(userHandle), "userName": userName, "userDisplayName": displayName, "counter": "0",
        "discoverable": "true", "creationDate": date.string(from: createdAt),
      ]
    }
  }

  static func attach(_ credential: NewCredential, to item: [String: Any]) -> [String: Any]? {
    guard var login = item["login"] as? [String: Any] else { return nil }
    let existing = login["fido2Credentials"] as? [Any] ?? []
    guard existing.isEmpty else { return nil }
    login["fido2Credentials"] = [credential.json()]
    var updated = item
    updated["login"] = login
    return updated
  }

  static func newItem(_ credential: NewCredential, title: String, url: String) -> [String: Any] {
    let login: [String: Any] = [
      "uris": [["uri": url, "match": NSNull()]], "username": credential.userName, "password": NSNull(), "totp": NSNull(),
      "fido2Credentials": [credential.json()],
    ]
    return [
      "type": 1, "name": title, "notes": NSNull(), "favorite": false, "folderId": NSNull(), "organizationId": NSNull(), "reprompt": 0,
      "fields": [Any](), "login": login,
    ]
  }
}
