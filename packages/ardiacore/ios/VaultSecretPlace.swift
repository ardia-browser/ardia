import Foundation

enum VaultSecretPlace: Equatable, Sendable {
  case memory
  case sandboxFile(URL)
  case developmentFile(URL)
  case dataProtection(group: String)
  case loginKeychain

  static func choose(background: Bool, hasDataDirectory: Bool, accessGroup: String?, teamSigned: Bool, managersDirectory: URL?)
    -> VaultSecretPlace
  {
    if background {
      guard hasDataDirectory, let managersDirectory else { return .memory }
      return .sandboxFile(managersDirectory)
    }
    if let accessGroup, !accessGroup.isEmpty { return .dataProtection(group: accessGroup) }
    if teamSigned { return .loginKeychain }
    guard let managersDirectory else { return .memory }
    return .developmentFile(managersDirectory)
  }

  var trusted: Bool {
    switch self {
    case .dataProtection, .sandboxFile: true
    case .memory, .developmentFile, .loginKeychain: false
    }
  }

  var touchesLoginKeychain: Bool { self == .loginKeychain }

  var label: String {
    switch self {
    case .memory: "memory"
    case .sandboxFile: "sandboxFile"
    case .developmentFile: "developmentFile"
    case .dataProtection: "dataProtection"
    case .loginKeychain: "loginKeychain"
    }
  }
}
