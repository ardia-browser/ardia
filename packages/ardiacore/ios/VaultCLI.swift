import Foundation

protocol VaultCLIHost: Sendable {
  var touchID: Bool { get }
  func session(_ provider: String) -> String?
  func remember(_ provider: String, session: String, persistent: Bool)
  func hasStoredSession(_ provider: String) -> Bool
  func storedSession(_ provider: String, reason: String) async -> String?
  func dropStored(_ provider: String)
  func value(_ provider: String, _ key: String) -> String?
  func setValue(_ provider: String, _ key: String, _ value: String?)
  func preference(_ provider: String, _ key: String) -> String?
  func setPreference(_ provider: String, _ key: String, _ value: String?)
  func setRunning(_ provider: String, _ command: VaultCommand) -> VaultCommand?
  func finishedRunning(_ provider: String, _ command: VaultCommand)
  func isRunning(_ provider: String) -> Bool
  @discardableResult func cancelRunning(_ provider: String) -> Bool
  func confirmOwner(_ provider: String, reason: String) async -> Bool
  func announceChange(_ provider: String)
}

struct VaultCLI: Sendable {
  static let defaultTimeout: TimeInterval = 30
  static let versionTimeout: TimeInterval = 10
  static let syncedAtKey = "syncedAt"

  let provider: String
  let path: String
  let environment: [String: String]
  let host: any VaultCLIHost
  let epochs: VaultLockEpochs
  let ticket: VaultLockEpoch.Ticket

  init(provider: String, path: String, environment: [String: String], host: any VaultCLIHost, epochs: VaultLockEpochs = .shared) {
    self.provider = provider
    self.path = path
    self.environment = environment
    self.host = host
    self.epochs = epochs
    ticket = epochs.ticket(provider)
  }

  func run(_ arguments: [String], input: Data? = nil, environment extra: [String: String] = [:],
           timeout: TimeInterval = VaultCLI.defaultTimeout, outputLimit: Int = VaultCommand.outputLimit) async -> VaultCommandResult {
    await makeCommand(arguments, input: input, environment: extra, timeout: timeout, outputLimit: outputLimit, onOutput: nil).run()
  }

  func runSigningIn(_ arguments: [String], environment extra: [String: String] = [:], timeout: TimeInterval) async -> VaultCommandResult {
    let command = makeCommand(arguments, input: nil, environment: extra, timeout: timeout, outputLimit: VaultCommand.outputLimit, onOutput: nil)
    host.setRunning(provider, command)?.cancel()
    defer { host.finishedRunning(provider, command) }
    return await command.run()
  }

  func start(_ arguments: [String], environment extra: [String: String] = [:], timeout: TimeInterval,
             onOutput: @escaping @Sendable (String) -> Void, completion: @escaping @Sendable (VaultCommandResult) -> Void) {
    let command = makeCommand(arguments, input: nil, environment: extra, timeout: timeout, outputLimit: VaultCommand.outputLimit,
                              onOutput: onOutput)
    let host = self.host
    let provider = self.provider
    host.setRunning(provider, command)?.cancel()
    command.start { result in
      host.finishedRunning(provider, command)
      completion(result)
    }
  }

  private func makeCommand(_ arguments: [String], input: Data?, environment extra: [String: String], timeout: TimeInterval,
                           outputLimit: Int, onOutput: (@Sendable (String) -> Void)?) -> VaultCommand {
    VaultCommand(executable: path, arguments: arguments, environment: environment.merging(extra) { _, chosen in chosen },
                 input: input, timeout: timeout, outputLimit: outputLimit, onOutput: onOutput)
  }

  func version() async -> String? {
    let result = await run(["--version"], timeout: Self.versionTimeout)
    guard result.succeeded else { return nil }
    return Self.versionNumber(in: result.trimmedOutput)
  }

  static func versionNumber(in text: String) -> String? {
    guard let line = text.split(whereSeparator: \.isNewline).first else { return nil }
    let words = line.split(separator: " ").map(String.init)
    let numbered = words.first { word in
      let parts = word.trimmingCharacters(in: CharacterSet(charactersIn: "v(),")).split(separator: ".")
      return parts.count >= 2 && parts.allSatisfy { !$0.isEmpty && $0.prefix(while: \.isNumber).count > 0 }
    }
    return (numbered ?? words.last)?.trimmingCharacters(in: CharacterSet(charactersIn: "v(),"))
  }

  var session: String? { host.session(provider) }
  var touchID: Bool { host.touchID }
  var isSigningIn: Bool { host.isRunning(provider) }
  var hasStoredSession: Bool { host.hasStoredSession(provider) }

  func remember(session: String, persistent: Bool = false) {
    let host = self.host
    let provider = self.provider
    epochs.ifCurrent(ticket) { host.remember(provider, session: session, persistent: persistent) }
  }
  func storedSession(_ reason: String) async -> String? { await host.storedSession(provider, reason: reason) }
  func dropStoredSession() { host.dropStored(provider) }
  func cancelSigningIn() { host.cancelRunning(provider) }
  func value(_ key: String) -> String? { host.value(provider, key) }
  func setValue(_ key: String, _ value: String?) { host.setValue(provider, key, value) }
  func preference(_ key: String) -> String? { host.preference(provider, key) }
  func setPreference(_ key: String, _ value: String?) { host.setPreference(provider, key, value) }
  func confirmOwner(_ reason: String) async -> Bool { await host.confirmOwner(provider, reason: reason) }
  func announceChange() { host.announceChange(provider) }
}
