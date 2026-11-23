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
}
