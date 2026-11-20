import Foundation

enum VaultPasswordUpdate {
  static func update(provider: String, id: String, origin: String, password: String, profile: String) async -> VaultEditResult {
    guard VaultLoginChange(password: password).validated() != nil else { return .failure(.invalid) }
    if provider == ArdiaVault.id { return await ardia(id: id, origin: origin, password: password, profile: profile) }
    return await VaultBroker.shared.updatePassword(provider: provider, id: id, origin: origin, password: password)
  }

  private static func ardia(id: String, origin: String, password: String, profile: String) async -> VaultEditResult {
    guard VaultOriginMatch.isSecure(origin) else { return .failure(.invalid) }
    guard let login = ArdiaVault.login(ofItem: id) else { return .failure(.notFound) }
    let base = await ArdiaVaultStore.baseProfile(profile)
    guard login.profile == base, VaultOriginMatch.matches(ArdiaVault.item(login, hasTotp: false), origin: origin) else { return .failure(.notFound) }
    guard await ArdiaVaultStore.offers(base) else { return .failure(.locked) }
    guard await VaultOwnerCheck.confirm("change your password") else { return .failure(.declined) }
    guard await ArdiaVaultStore.update(login, password: password) else { return .failure(.failed) }
    await ArdiaVaultBackup.shared.noteChange()
    let codes = await ArdiaVaultBackup.shared.codes()
    return VaultEditResult(item: ArdiaVault.item(login, hasTotp: codes[id] != nil))
  }
}
