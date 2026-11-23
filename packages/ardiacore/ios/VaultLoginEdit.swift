import Foundation

enum VaultTotpChange: Sendable, Equatable {
  case unchanged
  case set(String)
  case remove
}

struct VaultLoginChange: Sendable, Equatable {
  static let longestUsername = 1024
  static let longestPassword = 4096
  static let longestURL = 2048

  var username: String?
  var password: String?
  var url: String?
  var totp: VaultTotpChange = .unchanged

  var isEmpty: Bool { username == nil && password == nil && url == nil && totp == .unchanged }

  var changesPassword: Bool { password != nil }

  func validated() -> VaultLoginChange? {
    var clean = VaultLoginChange()
    if let username {
      let trimmed = username.trimmingCharacters(in: .whitespacesAndNewlines)
      guard trimmed.count <= Self.longestUsername, !trimmed.contains(where: Self.isBreak) else { return nil }
      clean.username = trimmed
    }
    if let password {
      guard !password.isEmpty, password.count <= Self.longestPassword, !password.contains(where: Self.isBreak) else { return nil }
      clean.password = password
    }
    if let url {
      let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
      guard trimmed.count <= Self.longestURL, !trimmed.contains(where: { $0.isWhitespace || Self.isBreak($0) }),
        VaultOriginMatch.isWebOrigin(trimmed)
      else { return nil }
      clean.url = trimmed
    }
    switch totp {
    case .set(let uri):
      guard let normalized = VaultTotpURI.setupURI(uri) else { return nil }
      clean.totp = .set(normalized)
    case .remove, .unchanged:
      clean.totp = totp
    }
    return clean
  }

  private static func isBreak(_ character: Character) -> Bool { character.isNewline || character == "\u{0}" }
}

enum VaultEditError: String, Error, Sendable {
  case locked
  case notFound
  case unsupported
  case invalid
  case declined
  case failed
}

struct VaultEditResult: Sendable {
  var item: VaultItem?
  var error: VaultEditError?
  var message: String?

  static func failure(_ error: VaultEditError, _ message: String? = nil) -> VaultEditResult {
    VaultEditResult(item: nil, error: error, message: message)
  }

  func jsonObject() -> [String: Any] {
    var object: [String: Any] = ["edited": item != nil]
    if let item { object["item"] = item.jsonObject() }
    if let error { object["error"] = error.rawValue }
    if let message { object["message"] = message }
    return object
  }
}
