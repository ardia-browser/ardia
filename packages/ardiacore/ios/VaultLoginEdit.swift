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

enum VaultLoginEditPlan {
  struct Command: Equatable, Sendable {
    var arguments: [String]
    var input: Data
  }

  static let onePasswordCodeFieldId = "ardia-one-time-password"

  static func isBitwardenId(_ id: String) -> Bool {
    id.count == 36 && id.allSatisfy { $0 == "-" || ($0.isASCII && $0.isHexDigit) }
  }

  static func isOnePasswordId(_ id: String) -> Bool {
    !id.isEmpty && id.count <= 64 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
  }

  static func bitwardenItem(_ item: [String: Any], _ change: VaultLoginChange) -> [String: Any]? {
    guard let change = change.validated(), !change.isEmpty, VaultJSON.int(item["type"]) == 1, var login = VaultJSON.dict(item["login"]) else {
      return nil
    }
    if let username = change.username { login["username"] = username.isEmpty ? NSNull() : username }
    if let password = change.password { login["password"] = password }
    if let url = change.url {
      var uris = login["uris"] as? [Any] ?? []
      if var first = uris.first as? [String: Any] {
        first["uri"] = url
        first["uriChecksum"] = nil
        uris[0] = first
      } else if uris.isEmpty {
        uris = [["uri": url, "match": NSNull()]]
      } else {
        uris[0] = ["uri": url, "match": NSNull()]
      }
      login["uris"] = uris
    }
    switch change.totp {
    case .set(let uri): login["totp"] = uri
    case .remove: login["totp"] = NSNull()
    case .unchanged: break
    }
    var edited = item
    edited["login"] = login
    return edited
  }

  static func bitwardenCommand(id: String, item: [String: Any], change: VaultLoginChange) -> Command? {
    guard isBitwardenId(id), VaultJSON.string(item["id"]) == id, let edited = bitwardenItem(item, change), let json = VaultJSON.data(edited) else {
      return nil
    }
    return Command(arguments: ["edit", "item", id, "--nointeraction"], input: Data(json.base64EncodedString().utf8))
  }

  static func bitwardenSecrets(_ item: [String: Any], _ change: VaultLoginChange) -> [String] {
    let login = VaultJSON.dict(item["login"]) ?? [:]
    return nonEmpty([VaultJSON.string(login["password"]), VaultJSON.string(login["totp"])] + newSecrets(change))
  }

  static func onePasswordItem(_ item: [String: Any], _ change: VaultLoginChange) -> [String: Any]? {
    guard let change = change.validated(), !change.isEmpty, (VaultJSON.string(item["category"]) ?? "LOGIN").uppercased() == "LOGIN" else {
      return nil
    }
    var fields = VaultJSON.dicts(item["fields"])
    if let username = change.username {
      set(&fields, purpose: "USERNAME", value: username, adding: ["id": "username", "type": "STRING", "purpose": "USERNAME", "label": "username"])
    }
    if let password = change.password {
      set(&fields, purpose: "PASSWORD", value: password, adding: ["id": "password", "type": "CONCEALED", "purpose": "PASSWORD", "label": "password"])
      if let at = fields.firstIndex(where: { VaultJSON.string($0["purpose"]) == "PASSWORD" }) {
        fields[at]["password_details"] = nil
        fields[at]["entropy"] = nil
      }
    }
    switch change.totp {
    case .set(let uri):
      if let at = fields.firstIndex(where: isOneTimeField) {
        fields[at]["value"] = uri
        fields[at]["totp"] = nil
      } else {
        fields.append(["id": onePasswordCodeFieldId, "type": "OTP", "label": "one-time password", "value": uri])
      }
    case .remove:
      fields.removeAll(where: isOneTimeField)
    case .unchanged:
      break
    }
    var edited = item
    edited["fields"] = fields
    if let url = change.url {
      var urls = VaultJSON.dicts(item["urls"])
      if let at = urls.firstIndex(where: { VaultJSON.bool($0["primary"]) == true }) ?? (urls.isEmpty ? nil : 0) {
        urls[at]["href"] = url
      } else {
        urls = [["href": url, "primary": true]]
      }
      edited["urls"] = urls
    }
    return edited
  }

  static func onePasswordCommand(id: String, item: [String: Any], change: VaultLoginChange, account: [String]) -> Command? {
    guard isOnePasswordId(id), VaultJSON.string(item["id"]) == id, let edited = onePasswordItem(item, change), let json = VaultJSON.data(edited) else {
      return nil
    }
    return Command(arguments: ["item", "edit", id, "--format=json"] + account, input: json)
  }

  static func onePasswordSecrets(_ item: [String: Any], _ change: VaultLoginChange) -> [String] {
    nonEmpty(VaultJSON.dicts(item["fields"]).compactMap { $0["value"] as? String }.filter { $0.count >= 4 } + newSecrets(change))
  }

  static func onePasswordHolds(_ item: [String: Any], _ change: VaultLoginChange, at now: Date = Date()) -> Bool {
    guard let change = change.validated() else { return false }
    let fields = VaultJSON.dicts(item["fields"])
    let value = { (purpose: String) in fields.first { VaultJSON.string($0["purpose"]) == purpose }?["value"] as? String }
    if let username = change.username, (value("USERNAME") ?? "") != username { return false }
    if let password = change.password, value("PASSWORD") != password { return false }
    if let url = change.url, !VaultJSON.dicts(item["urls"]).contains(where: { VaultJSON.string($0["href"]) == url }) { return false }
    switch change.totp {
    case .set(let uri):
      guard let wanted = VaultTotpSecret(uri) else { return false }
      return holdsCode(fields, wanted, at: now)
    case .remove:
      return !fields.contains(where: isOneTimeField)
    case .unchanged:
      return true
    }
  }

  static func holdsCode(_ fields: [[String: Any]], _ wanted: VaultTotpSecret, at now: Date = Date()) -> Bool {
    let codes = Set([-1.0, 0, 1].map { wanted.code(at: now.addingTimeInterval($0 * Double(wanted.period))) })
    return fields.filter(isOneTimeField).contains { field in
      if let value = field["value"] as? String, let held = VaultTotpSecret(value), held == wanted { return true }
      return (field["totp"] as? String).map { codes.contains($0) } ?? false
    }
  }

  static func isOneTimeField(_ field: [String: Any]) -> Bool { (VaultJSON.string(field["type"]) ?? "").uppercased() == "OTP" }

  private static func set(_ fields: inout [[String: Any]], purpose: String, value: String, adding template: [String: Any]) {
    if let at = fields.firstIndex(where: { VaultJSON.string($0["purpose"]) == purpose }) {
      fields[at]["value"] = value
    } else {
      var added = template
      added["value"] = value
      fields.append(added)
    }
  }

  private static func newSecrets(_ change: VaultLoginChange) -> [String?] {
    var secrets: [String?] = [change.password]
    for candidate in [change, change.validated()] {
      if case .set(let uri)? = candidate?.totp { secrets.append(uri) }
    }
    return secrets
  }

  private static func nonEmpty(_ values: [String?]) -> [String] { values.compactMap { $0 }.filter { !$0.isEmpty } }
}
