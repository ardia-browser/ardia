import AppKit

extension ArdiaWebView: PageTab {
  func startPage() {}

  func closePage() { closeBrowser() }

  func downloadFavicon(_ url: String, completion: @escaping ([String: Any]?) -> Void) {
    downloadFavicon(url, name: nil, completion: completion)
  }

  func fillFromVault(frameId: String, origin: String, provider: String, id: String, fields: [String], userChose: Bool, submit: Bool,
                     contextMenu: Bool, _ completion: @escaping ([String: Any]) -> Void) {
    if !contextMenu, provider == VaultGenerated.provider {
      return fillKeptGenerated(frameId: frameId, origin: origin, id: id, fields: fields, userChose: userChose, submit: submit, completion)
    }
    guard let frameOrigin = vaultOrigin(ofFrame: frameId), frameOrigin == origin else {
      return completion(["filled": [String](), "error": VaultFillError.originMismatch.rawValue])
    }
    Task { @MainActor in
      let profile = ArdiaHost.baseProfile(of: self.profile)
      let result = await VaultOwnerCheck.$fillTab.withValue(self.vaultTabId) {
        await VaultBroker.shared.fillValues(provider: provider, id: id, fields: fields, origin: frameOrigin, userChose: contextMenu || userChose,
                                            profile: profile)
      }
      switch result {
      case .failure(let error):
        completion(["filled": [String](), "error": error.rawValue])
      case .success(let fill):
        self.fillVault(frame: frameId, origin: frameOrigin, values: fill.values, submit: submit && fill.touched, contextMenu: contextMenu) { filled in
          completion(["filled": filled])
        }
      }
    }
  }

  func fillGeneratedPassword(frameId: String, origin: String, style: String, maxLength: Int?, contextMenu: Bool,
                             _ completion: @escaping ([String: Any]) -> Void) {
    guard let frameOrigin = vaultOrigin(ofFrame: frameId), frameOrigin == origin else {
      return completion(["filled": [String]()])
    }
    let password = VaultPasswordGenerator.generate(style: VaultPasswordStyle(named: style), maxLength: maxLength)
    let previous = generatedVaultPassword(origin: frameOrigin)
    fillVault(frame: frameId, origin: frameOrigin, values: ["newPassword": password], submit: false, contextMenu: contextMenu) { filled in
      if filled.contains("newPassword") {
        self.keepGeneratedVaultPassword(password, origin: frameOrigin)
        self.keepGeneratedForLater(password, origin: frameOrigin, replacing: previous)
      }
      completion(["filled": filled])
    }
  }

  func saveToVault(provider: String, origin: String, title: String?, username: String?, _ completion: @escaping ([String: Any]) -> Void) {
    guard let login = takeVaultLogin(origin: origin), let password = login["password"], !password.isEmpty else {
      return completion(["saved": false, "error": VaultFillError.notFound.rawValue])
    }
    let captured = login["username"] ?? ""
    let override = VaultNewLogin.cleanedUsername(username)
    let chosen = override.isEmpty ? captured : override
    Task { @MainActor in
      let result = await VaultBroker.shared.save(provider: provider, origin: origin, username: chosen, password: password, title: title,
                                                 profile: ArdiaHost.baseProfile(of: self.profile))
      switch result {
      case .success(let item):
        self.discardVaultCapture(origin: origin)
        VaultGenerated.saved(password: password, origin: origin)
        completion(["saved": true, "item": item.jsonObject()])
      case .failure(let error):
        self.keepVaultLogin(username: captured, password: password, origin: origin)
        completion(["saved": false, "error": error.rawValue])
      }
    }
  }
}
