import Foundation

struct VaultPasskeyExtension: Equatable, Sendable {
  static let mostClaimed = 8

  var id: String
  var name: String
  var known = false

  static func eligible(_ claimed: [String], installed: [VaultPasskeyExtension], wraps: (String) -> Bool) -> [String] {
    let asked = Set(claimed.prefix(64).filter(isId))
    return Array(installed.filter { asked.contains($0.id) && ($0.known || wraps($0.id)) }.map(\.id).prefix(mostClaimed))
  }

  static func isId(_ id: String) -> Bool { id.count == 32 && id.utf8.allSatisfy { $0 >= 0x61 && $0 <= 0x70 } }
}

enum VaultPasskeyHandler: Equatable, Sendable {
  case system
  case browserExtension(String)
}

enum VaultPasskeyUse: Equatable, Sendable {
  case sign
  case handOff(String)
  case refuse

  static func of(_ candidate: VaultPasskeyCandidate, handler: VaultPasskeyHandler?) -> VaultPasskeyUse {
    guard candidate.delegated else { return .sign }
    if case .browserExtension(let id) = handler { return .handOff(id) }
    return .refuse
  }

  static func delegated(holdsKeys: Bool, listsDelegated: Bool) -> Bool? {
    if holdsKeys { return false }
    return listsDelegated ? true : nil
  }
}

struct VaultPasskeyDelegate: Equatable, Sendable {
  var provider: String
  var name: String
  var routes: [VaultPasskeyDelegation]

  func handler(systemAvailable: Bool, contenders: [String]) -> VaultPasskeyHandler? {
    for route in routes {
      switch route.via {
      case .system:
        if systemAvailable { return .system }
      case .browserExtension:
        if let id = (route.extensions ?? []).first(where: contenders.contains) { return .browserExtension(id) }
      }
    }
    return nil
  }

  static func handlers(_ delegates: [VaultPasskeyDelegate], systemAvailable: Bool, contenders: [String]) -> [String: VaultPasskeyHandler] {
    var found: [String: VaultPasskeyHandler] = [:]
    for delegate in delegates {
      if let handler = delegate.handler(systemAvailable: systemAvailable, contenders: contenders) { found[delegate.provider] = handler }
    }
    return found
  }
}

enum VaultPasskeySource: Equatable, Sendable {
  case ask
  case ardia
  case chrome
  case extensionId(String)
  case provider(String)

  static let providerPattern = #"^[a-z0-9][a-z0-9._-]{0,63}$"#

  init(setting: String) {
    switch setting {
    case "ardia": self = .ardia
    case "chrome": self = .chrome
    default:
      if setting.hasPrefix("ext:"), VaultPasskeyExtension.isId(String(setting.dropFirst(4))) {
        self = .extensionId(String(setting.dropFirst(4)))
      } else if setting.hasPrefix("provider:"), case let id = String(setting.dropFirst(9)), id.range(of: Self.providerPattern, options: .regularExpression) != nil {
        self = .provider(id)
      } else {
        self = .ask
      }
    }
  }
}

enum VaultPasskeyRoute: Equatable, Sendable {
  case ardia
  case chrome
  case asIfAbsent
  case extensionId(String)
  case system(String)
  case choose(ardia: Bool, extensions: [String])
  case hold

  struct Input: Sendable {
    var source: VaultPasskeySource
    var creating: Bool
    var conditional: Bool
    var extensions: [String]
    var ardiaCan: Bool
    var ardiaHasPasskeys: Bool
    var systemProviders: [String] = []
    var delegatedExtensions: [String] = []
  }

  static func decide(_ input: Input) -> VaultPasskeyRoute {
    let ardiaOffers = input.ardiaCan && (input.creating || input.ardiaHasPasskeys)
    let systemRows = input.ardiaCan ? input.systemProviders : []
    let sheetOffers = ardiaOffers || !systemRows.isEmpty
    let open = input.extensions.filter { !input.delegatedExtensions.contains($0) }
    var source = input.source
    if case .extensionId(let id) = source, !input.extensions.contains(id) { source = .ask }
    if input.conditional { return decideConditional(source: source, sheetOffers: sheetOffers, open: open, delegated: input.delegatedExtensions) }
    if case .provider(let id) = source {
      if systemRows.contains(id) { return .system(id) }
      source = .ask
    }
    if case .extensionId(let id) = source { return .extensionId(id) }
    guard !open.isEmpty else {
      if source == .chrome { return .chrome }
      return sheetOffers ? .ardia : .asIfAbsent
    }
    if source == .chrome { return .chrome }
    if source == .ardia, sheetOffers { return .ardia }
    return .choose(ardia: sheetOffers, extensions: open)
  }

  private static func decideConditional(source: VaultPasskeySource, sheetOffers: Bool, open: [String], delegated: [String]) -> VaultPasskeyRoute {
    switch source {
    case .chrome:
      return .hold
    case .extensionId(let id) where !delegated.contains(id):
      return .extensionId(id)
    default:
      if sheetOffers { return .ardia }
      return open.isEmpty ? .hold : .asIfAbsent
    }
  }
}
