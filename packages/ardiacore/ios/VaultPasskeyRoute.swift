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

enum VaultPasskeySource: Equatable, Sendable {
  case ask
  case ardia
  case chrome
  case extensionId(String)

  init(setting: String) {
    switch setting {
    case "ardia": self = .ardia
    case "chrome": self = .chrome
    default:
      if setting.hasPrefix("ext:"), VaultPasskeyExtension.isId(String(setting.dropFirst(4))) {
        self = .extensionId(String(setting.dropFirst(4)))
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
  case choose(ardia: Bool, extensions: [String])

  struct Input: Sendable {
    var source: VaultPasskeySource
    var creating: Bool
    var conditional: Bool
    var extensions: [String]
    var ardiaCan: Bool
    var ardiaHasPasskeys: Bool
  }

  static func decide(_ input: Input) -> VaultPasskeyRoute {
    let ardiaOffers = input.ardiaCan && (input.creating || input.ardiaHasPasskeys)
    guard !input.extensions.isEmpty else {
      if input.source == .chrome { return .chrome }
      return ardiaOffers ? .ardia : .asIfAbsent
    }
    var source = input.source
    if case .extensionId(let id) = source, !input.extensions.contains(id) { source = .ask }
    switch source {
    case .extensionId(let id):
      return .extensionId(id)
    case .chrome:
      return .chrome
    case .ardia, .ask:
      if input.conditional { return ardiaOffers ? .ardia : .asIfAbsent }
      if source == .ardia, ardiaOffers { return .ardia }
      return .choose(ardia: ardiaOffers, extensions: input.extensions)
    }
  }
}
