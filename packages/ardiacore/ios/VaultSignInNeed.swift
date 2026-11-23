enum VaultSignInNeed: String, Codable, Sendable {
  case code
  case password
  case email
  case approval
  case account
  case field
}

struct VaultProviderNeeds: Codable, Equatable, Sendable {
  var kind: VaultSignInNeed
  var field: String? = nil
  var methods: [VaultChoice]? = nil
  var accounts: [VaultChoice]? = nil
  var approvalOpened: Bool? = nil
  var message: String? = nil
}

struct VaultChoice: Codable, Equatable, Sendable {
  var id: String
  var title: String
  var sendsCode: Bool? = nil
}
