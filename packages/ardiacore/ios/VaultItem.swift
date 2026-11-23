struct VaultItemPasskey: Codable, Equatable, Sendable {
  var credentialId: String
  var rpId: String
  var userName: String
  var displayName: String
  var discoverable: Bool
  var counter: Int
}

struct VaultItem: Codable, Equatable, Sendable {
  var provider: String
  var id: String
  var title: String
  var username: String
  var urls: [String]
  var urlMatch: [String]? = nil
  var hasTotp: Bool? = nil
  var vault: String? = nil
  var favorite: Bool? = nil
  var updatedAt: Double? = nil
  var totpPeriod: Int? = nil
  var profile: String? = nil
  var passkeys: [VaultItemPasskey]? = nil

  enum CodingKeys: String, CodingKey {
    case provider, id, title, username, urls, urlMatch, hasTotp, vault, favorite, updatedAt, profile, passkeys
  }

  func jsonObject() -> [String: Any] {
    var object: [String: Any] = ["provider": provider, "id": id, "title": title, "username": username, "urls": urls]
    if let urlMatch { object["urlMatch"] = urlMatch }
    if let hasTotp { object["hasTotp"] = hasTotp }
    if let vault { object["vault"] = vault }
    if let favorite { object["favorite"] = favorite }
    if let updatedAt, updatedAt.isFinite { object["updatedAt"] = updatedAt }
    if let profile { object["profile"] = profile }
    return object
  }
}
