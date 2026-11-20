import Foundation

enum ArdiaVault {
  static let id = "ardia"
  static let name = "Ardia"
  static let capabilities = VaultCapabilities(totp: true, save: true, selfHosted: false, masterPassword: false, touchID: false, addTotp: true)
  static let install = VaultInstall(command: "", url: "")

  static func state(on: Bool) -> VaultProviderState {
    VaultProviderState(id: id, name: name, state: on ? .unlocked : .unavailable, message: on ? nil : "Off", capabilities: capabilities,
                       install: install)
  }

  static func originOfRealm(_ realm: String) -> String {
    var origin = realm
    while origin.hasSuffix("/") { origin.removeLast() }
    return origin
  }

  static func itemId(_ login: ArdiaVaultLogin) -> String { ArdiaLoginKey.make(login) }

  static func login(ofItem id: String) -> ArdiaVaultLogin? {
    guard let login = ArdiaLoginKey.parse(id), VaultOriginMatch.isWebOrigin(login.origin) else { return nil }
    return login
  }

  static func item(_ login: ArdiaVaultLogin, hasTotp: Bool) -> VaultItem {
    VaultItem(provider: id, id: itemId(login), title: VaultOriginMatch.siteName(of: login.origin) ?? login.origin, username: login.username,
              urls: [login.origin], hasTotp: hasTotp, profile: login.profile)
  }
}
