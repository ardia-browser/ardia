import Foundation

enum VaultKeyRead: Equatable, Sendable {
  case found(Data)
  case missing
  case failed
}

enum VaultStoreKeyPlan: Equatable, Sendable {
  case useSynced
  case useLocal
  case keepCurrent
  case wait
  case createSynced
  case createLocal

  static func choose(synced: VaultKeyRead, local: VaultKeyRead, hasCurrent: Bool, creating: Bool, mayCreateSynced: Bool) -> VaultStoreKeyPlan {
    if case .found = synced { return .useSynced }
    if case .found = local { return .useLocal }
    if hasCurrent { return .keepCurrent }
    guard synced != .failed, local != .failed, creating else { return .wait }
    return mayCreateSynced ? .createSynced : .createLocal
  }
}
