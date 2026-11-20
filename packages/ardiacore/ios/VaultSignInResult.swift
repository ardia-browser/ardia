struct VaultSignInResult: Codable, Equatable, Sendable {
  var ok: Bool
  var state: VaultProviderState
  var needs: VaultSignInNeed? = nil
  var methods: [VaultMethod]? = nil
  var error: String? = nil
  var approvalURL: String? = nil
  var entryExpired: Bool? = nil

  func jsonObject() -> [String: Any] { VaultJSON.object(self) }
}
