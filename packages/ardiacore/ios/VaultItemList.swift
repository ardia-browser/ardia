struct VaultRevealed: Sendable {
  var password: String?
  var totp: String?
}

struct VaultItemList: Sendable {
  var items: [VaultItem]
  var passwords: [String: String] = [:]
  var totps: [String: String] = [:]
}
