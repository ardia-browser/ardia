import Foundation

enum VaultCreateLoginError: String, Error, Sendable {
  case exists
  case invalid
  case needsPassword
  case expired
  case declined
  case failed
}

struct VaultCreateLoginResult: Sendable {
  var item: VaultItem?
  var error: VaultCreateLoginError?
  var codeAdded = false

  static func failure(_ error: VaultCreateLoginError) -> VaultCreateLoginResult { VaultCreateLoginResult(item: nil, error: error) }

  func jsonObject() -> [String: Any] {
    var object: [String: Any] = ["saved": item != nil, "codeAdded": codeAdded]
    if let item { object["item"] = item.jsonObject() }
    if let error { object["error"] = error.rawValue }
    return object
  }
}

enum VaultArdiaLogins {
  static func create(website: String, username: String, password: String?, profile: String, codeURI: String?) async -> VaultCreateLoginResult {
    guard let origin = ArdiaStandaloneCode.websiteOrigin(website) else { return .failure(.invalid) }
    guard let password, !password.isEmpty, password.count <= VaultLoginChange.longestPassword else { return .failure(.needsPassword) }
    let name = VaultNewLogin.cleanedUsername(username)
    let base = await ArdiaVaultStore.baseProfile(profile)
    let login = ArdiaVaultLogin(profile: base, origin: origin, username: name)
    if await exists(login) { return .failure(.exists) }
    if codeURI != nil, !(await VaultOwnerCheck.confirm("add a verification code")) { return .failure(.declined) }
    guard await ArdiaVaultStore.save(login, password: password) else { return .failure(.failed) }
    let id = ArdiaVault.itemId(login)
    await ArdiaVaultIndex.shared.noteSaved(profile: base, origin: origin, username: name)
    var codeAdded = false
    if let codeURI { codeAdded = await ArdiaVaultIndex.shared.editCodes { $0[id] = codeURI } }
    await ArdiaVaultBackup.shared.noteChange()
    NSLog("[vaults] ardia saved a login made in Settings")
    return VaultCreateLoginResult(item: ArdiaVault.item(login, hasTotp: codeAdded), codeAdded: codeAdded)
  }

  static func edit(id: String, change asked: VaultLoginChange, profile: String) async -> VaultEditResult {
    guard let login = ArdiaVault.login(ofItem: id) else { return .failure(.notFound) }
    let base = await ArdiaVaultStore.baseProfile(profile)
    guard login.profile == base else { return .failure(.notFound) }
    guard !asked.isEmpty, var change = asked.validated() else { return .failure(.invalid) }
    var target = login
    if let url = change.url {
      guard let origin = ArdiaStandaloneCode.websiteOrigin(url) else { return .failure(.invalid) }
      target.origin = origin
      change.url = origin
    }
    if let username = change.username { target.username = VaultNewLogin.cleanedUsername(username) }
    let moved = target != login
    if moved, await exists(target) { return .failure(.invalid, "There's already a password for this username on that website.") }
    let codes = await ArdiaVaultBackup.shared.codes()
    let codeChanges: Bool
    switch change.totp {
    case .unchanged: codeChanges = false
    case .remove: codeChanges = codes[id] != nil
    case .set(let uri): codeChanges = codes[id].map { VaultTotpSecret($0) != VaultTotpSecret(uri) } ?? true
    }
    if change.password != nil || codeChanges {
      let reason = change.password != nil ? "change your password" : "change a verification code"
      guard await VaultOwnerCheck.confirm(reason) else { return .failure(.declined) }
    }
    if target.origin != login.origin {
      let stored = change.password == nil ? await ArdiaVaultStore.password(login) : nil
      guard let password = change.password ?? stored, !password.isEmpty else { return .failure(.failed) }
      guard await ArdiaVaultStore.save(target, password: password) else { return .failure(.failed) }
      guard await ArdiaVaultStore.remove(login) else {
        _ = await ArdiaVaultStore.remove(target)
        return .failure(.failed)
      }
    } else if moved || change.password != nil {
      let renamed = target.username != login.username ? target.username : nil
      guard await ArdiaVaultStore.update(login, newUsername: renamed, password: change.password) else { return .failure(.failed) }
    }
    let targetId = ArdiaVault.itemId(target)
    let wanted = change.totp
    let saved = await ArdiaVaultIndex.shared.editCodes { codes in
      let held = codes.removeValue(forKey: id)
      switch wanted {
      case .unchanged: codes[targetId] = held
      case .remove: codes[targetId] = nil
      case .set(let uri): codes[targetId] = uri
      }
    }
    if moved {
      await ArdiaVaultIndex.shared.noteRemoved(profile: base, origin: login.origin, username: login.username)
      await ArdiaVaultIndex.shared.noteSaved(profile: base, origin: target.origin, username: target.username)
    }
    await ArdiaVaultBackup.shared.noteChange()
    NSLog("[vaults] ardia edited a login in Settings")
    let hasCode = await ArdiaVaultBackup.shared.codes()[targetId] != nil
    guard saved else { return VaultEditResult(item: ArdiaVault.item(target, hasTotp: hasCode), error: nil, message: "The verification code didn't change.") }
    return VaultEditResult(item: ArdiaVault.item(target, hasTotp: hasCode))
  }

  private static func exists(_ login: ArdiaVaultLogin) async -> Bool {
    let realm = ArdiaVault.originOfRealm(login.origin).lowercased()
    return await ArdiaVaultStore.logins(login.profile).contains {
      ArdiaVault.originOfRealm($0.origin).lowercased() == realm && $0.username == login.username
    }
  }
}
