import AppKit

extension ArdiaWebView {
  func updateVaultPassword(provider: String, id: String, origin: String, _ completion: @escaping ([String: Any]) -> Void) {
    guard let login = takeVaultLogin(origin: origin), let password = login["password"], !password.isEmpty else {
      return completion(VaultEditResult.failure(.notFound).jsonObject())
    }
    let captured = login["username"] ?? ""
    Task { @MainActor in
      let result = await VaultPasswordUpdate.update(provider: provider, id: id, origin: origin, password: password,
                                                    profile: ArdiaHost.baseProfile(of: self.profile))
      if result.item != nil {
        self.discardVaultCapture(origin: origin)
        VaultGenerated.saved(password: password, origin: origin)
      } else {
        self.keepVaultLogin(username: captured, password: password, origin: origin)
      }
      completion(result.jsonObject())
    }
  }
}
