struct VaultCapabilities: Codable, Equatable, Sendable {
  var totp: Bool
  var save: Bool
  var selfHosted: Bool
  var masterPassword: Bool
  var touchID: Bool
  var addTotp: Bool = false
  var edit: Bool = false
  var desktopApproval: Bool = false
  var passkeys: Bool = false
  var opensItems: Bool = false
  var passkeysVia: [VaultPasskeyDelegation]? = nil
}

struct VaultPasskeyDelegation: Codable, Equatable, Sendable {
  enum Via: String, Codable, Sendable {
    case system
    case browserExtension = "extension"
  }

  var via: Via
  var extensions: [String]? = nil
}
