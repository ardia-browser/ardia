import Foundation

struct CredentialHostLive: CredentialHost {
  let sessions: VaultSessionStore
  let epochs: VaultLockEpochs

  init(sessions: VaultSessionStore = .shared, epochs: VaultLockEpochs = .shared) {
    self.sessions = sessions
    self.epochs = epochs
  }

  var touchID: Bool { sessions.touchID }
  var offline: Bool { VaultNetwork.isOffline }
  var testInstance: Bool { VaultSandbox.directory != nil }

  func testFolderBase(_ provider: String) -> String? { VaultCLI.testFolder(for: provider) }
  func ticket(_ provider: String) -> VaultLockEpoch.Ticket { epochs.ticket(provider) }
  func isCurrent(_ ticket: VaultLockEpoch.Ticket) -> Bool { epochs.isCurrent(ticket) }
  func session(_ provider: String) -> String? { sessions.session(provider) }

  func remember(_ provider: String, session: String, persistent: Bool, ticket: VaultLockEpoch.Ticket) -> Bool {
    let store = sessions
    return epochs.ifCurrent(ticket) { store.remember(provider, session: session, persistent: persistent) }
  }

  func hasStoredSession(_ provider: String) -> Bool { sessions.hasStoredSession(provider) }
  func storedSession(_ provider: String, reason: String) async -> String? { await sessions.storedSession(provider, reason: reason) }
  func dropStoredSession(_ provider: String) { sessions.dropStored(provider) }
  func scratch(_ provider: String) -> [String: String] { sessions.values(provider) }
  func setScratch(_ provider: String, _ key: String, _ value: String?) { sessions.setValue(provider, key, value) }
  func preferences(_ provider: String) -> [String: String] { sessions.preferences(provider) }
  func setPreference(_ provider: String, _ key: String, _ value: String?) { sessions.setPreference(provider, key, value) }
  func confirmOwner(_ provider: String, reason: String) async -> Bool { await sessions.confirmOwner(provider, reason: reason) }
  func program(_ name: String) -> CredentialProgram? { VaultBinaryLocator.program(name) }

  func environment(for program: CredentialProgram) -> [String: String] {
    VaultCLI.hostEnvironment(binaryDirectory: (program.path as NSString).deletingLastPathComponent)
  }

  func startSigningIn(_ provider: String, _ command: VaultCommand) -> VaultCommand? { sessions.setRunning(provider, command) }
  func finishedSigningIn(_ provider: String, _ command: VaultCommand) { sessions.finishedRunning(provider, command) }
  func cancelSigningIn(_ provider: String) { sessions.cancelRunning(provider) }
  func signInRun(_ provider: String) -> CredentialSignInRun { sessions.signInRun(provider) }
  func setSignInRun(_ provider: String, _ run: CredentialSignInRun) { sessions.setSignInRun(provider, run) }
  func announceChange(_ provider: String) { sessions.announceChange(provider) }
}
