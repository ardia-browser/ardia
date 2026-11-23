struct VaultMethod: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var sendsCode: Bool? = nil
}
