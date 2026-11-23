struct VaultProviderState: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var state: VaultState
  var account: String? = nil
  var server: String? = nil
  var cliPath: String? = nil
  var cliVersion: String? = nil
  var message: String? = nil
  var capabilities: VaultCapabilities
  var install: VaultInstall
  var setup: VaultSetup? = nil
  var touchUnlock = false
  var plugin: String? = nil
  var title: String? = nil
  var symbol: String? = nil
  var accent: String? = nil
  var signIn: VaultSignInDescriptor? = nil
  var needs: VaultProviderNeeds? = nil
  var problem: VaultProviderProblem? = nil
  var unavailable: VaultProviderUnavailable? = nil

  func jsonObject() -> [String: Any] { VaultJSON.object(self) }
}

struct VaultProviderProblem: Codable, Equatable, Sendable {
  var code: String
  var message: String
}

struct VaultProviderUnavailable: Codable, Equatable, Sendable {
  enum Reason: String, Codable, Sendable {
    case crashed
    case updating
    case damaged
    case off
  }

  var reason: Reason
  var canRestart: Bool
}

struct VaultSignInDescriptor: Codable, Equatable, Sendable {
  struct Field: Codable, Equatable, Sendable {
    var id: String
    var title: String
    var kind: String
    var optional: Bool? = nil
    var placeholder: String? = nil
    var hint: String? = nil
    var masked: Bool? = nil
    var prefill: String? = nil
  }

  struct Method: Codable, Equatable, Sendable {
    var id: String
    var title: String
    var kind: String
    var fields: [Field]
    var appURL: String? = nil
    var appTitle: String? = nil
    var twoStep: Bool? = nil
  }

  struct Server: Codable, Equatable, Sendable {
    var id: String
    var title: String
    var url: String? = nil
    var custom: Bool? = nil
    var placeholder: String? = nil
    var fieldTitle: String? = nil
  }

  var methods: [Method]
  var servers: [Server]? = nil
  var unlockField: String? = nil
}
