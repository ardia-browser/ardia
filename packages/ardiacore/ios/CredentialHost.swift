import Foundation

struct CredentialProgram: Sendable, Equatable {
  var executable: String
  var leadingArguments: [String]
  var path: String
}

struct CredentialSignInRun: Sendable, Equatable {
  enum State: String, Sendable {
    case none
    case running
    case succeeded
    case failed
  }

  var state: State = .none
  var hints: [String] = []
  var detail: String?
  var timedOut: Bool?

  var wire: [String: Any] {
    var object: [String: Any] = ["state": state.rawValue, "hints": hints]
    if let detail { object["detail"] = detail }
    if let timedOut { object["timedOut"] = timedOut }
    return object
  }
}

protocol CredentialHost: Sendable {
  var touchID: Bool { get }
  var offline: Bool { get }
  var testInstance: Bool { get }
  func testFolderBase(_ provider: String) -> String?
  func ticket(_ provider: String) -> VaultLockEpoch.Ticket
  func isCurrent(_ ticket: VaultLockEpoch.Ticket) -> Bool
  func session(_ provider: String) -> String?
  @discardableResult func remember(_ provider: String, session: String, persistent: Bool, ticket: VaultLockEpoch.Ticket) -> Bool
  func hasStoredSession(_ provider: String) -> Bool
  func storedSession(_ provider: String, reason: String) async -> String?
  func dropStoredSession(_ provider: String)
  func scratch(_ provider: String) -> [String: String]
  func setScratch(_ provider: String, _ key: String, _ value: String?)
  func preferences(_ provider: String) -> [String: String]
  func setPreference(_ provider: String, _ key: String, _ value: String?)
  func confirmOwner(_ provider: String, reason: String) async -> Bool
  func program(_ name: String) -> CredentialProgram?
  func environment(for program: CredentialProgram) -> [String: String]
  func startSigningIn(_ provider: String, _ command: VaultCommand) -> VaultCommand?
  func finishedSigningIn(_ provider: String, _ command: VaultCommand)
  func cancelSigningIn(_ provider: String)
  func signInRun(_ provider: String) -> CredentialSignInRun
  func setSignInRun(_ provider: String, _ run: CredentialSignInRun)
  func announceChange(_ provider: String)
}

enum CredentialMarker {
  static let prefix = "\u{0}marker:"

  static func of(_ provider: String) -> String { prefix + provider }

  static func isMarker(_ session: String) -> Bool { session.hasPrefix(prefix) }
}

extension CredentialHost {
  func marker(_ provider: String) -> String { CredentialMarker.of(provider) }

  func sessionKey(_ provider: String) -> String? {
    guard let session = session(provider), !CredentialMarker.isMarker(session) else { return nil }
    return session
  }
}
