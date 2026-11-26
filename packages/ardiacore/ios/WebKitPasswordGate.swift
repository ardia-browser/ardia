import Foundation

enum WebKitPasswordGate {
  enum Use: Sendable {
    case fill
    case offerToSave
  }

  enum Verdict: Equatable, Sendable {
    case ardia
    case applePasswords
    case offerToSaveOff
    case leftToManager
    case privateProfile
  }

  static func verdict(_ use: Use, passwordsOn: Bool, systemProvider: Bool, applePasswords: Bool = false, privateProfile: Bool) -> Verdict {
    if systemProvider { return .leftToManager }
    if applePasswords { return use == .offerToSave && privateProfile ? .privateProfile : .applePasswords }
    guard use == .offerToSave else { return .ardia }
    if !passwordsOn { return .offerToSaveOff }
    if privateProfile { return .privateProfile }
    return .ardia
  }
}
