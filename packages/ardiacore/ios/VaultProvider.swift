import Foundation

protocol VaultProvider: Sendable {
  var id: String { get }
  var name: String { get }
  var binaryName: String { get }
  var capabilities: VaultCapabilities { get }
  var install: VaultInstall { get }
  var setup: VaultSetup? { get }
  var readsOffline: Bool { get }
  var staysAuthorizedAfterUse: TimeInterval? { get }

  func locked()
  func described(_ state: VaultProviderState) -> VaultProviderState
  func state(_ cli: VaultCLI) async -> VaultProviderState
  func signIn(_ cli: VaultCLI, fields: VaultSignInFields) async -> VaultSignInResult
  func unlock(_ cli: VaultCLI, password: String?) async -> VaultSignInResult
  func lock(_ cli: VaultCLI, session: String) async
  func signOut(_ cli: VaultCLI) async
  func configure(_ cli: VaultCLI, server: String?) async -> String?
  func items(_ cli: VaultCLI) async throws -> VaultItemList
  func secret(_ cli: VaultCLI, id: String, field: VaultField) async throws -> String
  func revealed(_ cli: VaultCLI, id: String) async throws -> VaultRevealed
  func save(_ cli: VaultCLI, login: VaultNewLogin) async throws -> VaultItem
  func addTotp(_ cli: VaultCLI, id: String, uri: String) async throws -> VaultItem
  func edit(_ cli: VaultCLI, id: String, change: VaultLoginChange) async throws -> VaultItem
}

extension VaultProvider {
  func revealed(_ cli: VaultCLI, id: String) async throws -> VaultRevealed {
    do {
      return VaultRevealed(password: try await secret(cli, id: id, field: .password))
    } catch VaultError.notFound {
      return VaultRevealed()
    }
  }
  var setup: VaultSetup? { nil }
  var readsOffline: Bool { true }
  var staysAuthorizedAfterUse: TimeInterval? { nil }

  func locked() {}
  func described(_ state: VaultProviderState) -> VaultProviderState { state }
  func lock(_ cli: VaultCLI, session: String) async {}
  func configure(_ cli: VaultCLI, server: String?) async -> String? { "\(name) has no server setting." }
  func save(_ cli: VaultCLI, login: VaultNewLogin) async throws -> VaultItem { throw VaultError.unsupported }
  func addTotp(_ cli: VaultCLI, id: String, uri: String) async throws -> VaultItem { throw VaultError.unsupported }
  func edit(_ cli: VaultCLI, id: String, change: VaultLoginChange) async throws -> VaultItem { throw VaultError.unsupported }

  func makeState(_ state: VaultState, account: String? = nil, server: String? = nil, message: String? = nil) -> VaultProviderState {
    described(VaultProviderState(id: id, name: name, state: state, account: account, server: server, message: message, capabilities: capabilities,
                                 install: install, setup: setup))
  }

  func signedIn() -> VaultSignInResult { VaultSignInResult(ok: true, state: makeState(.unlocked)) }

  func needs(_ need: VaultSignInNeed, _ message: String? = nil, methods: [VaultMethod]? = nil, approvalURL: String? = nil,
             state: VaultState = .locked) -> VaultSignInResult {
    VaultSignInResult(ok: false, state: makeState(state), needs: need, methods: methods, error: message, approvalURL: approvalURL)
  }

  func staysQuiet(lastAuthorized: Date?, now: Date = Date()) -> Bool {
    guard let window = staysAuthorizedAfterUse else { return true }
    return now.timeIntervalSince(lastAuthorized ?? .distantPast) < window
  }

  func typedPasswordExpired(_ state: VaultProviderState?) -> VaultSignInResult {
    VaultSignInResult(ok: false, state: state ?? makeState(.locked), needs: .password, error: "Type your \(name) master password again.",
                      entryExpired: true)
  }

  func stopped(state: VaultState) -> VaultSignInResult { failed("Signing in to \(name) was cancelled.", state: state) }

  func failed(_ message: String, state: VaultState = .locked) -> VaultSignInResult {
    VaultSignInResult(ok: false, state: makeState(state), error: message)
  }

  func checked(_ result: VaultCommandResult, tool: String, locked: [String], signedOut: [String], missing: [String],
               redacting secrets: [String] = []) throws {
    guard !result.succeeded else { return }
    if VaultMessages.mentions(result, locked) { throw VaultError.locked }
    if VaultMessages.mentions(result, signedOut) { throw VaultError.signedOut }
    if VaultMessages.mentions(result, missing) { throw VaultError.notFound }
    throw VaultError.failed(VaultMessages.failure(result, tool: tool, redacting: secrets))
  }
}
