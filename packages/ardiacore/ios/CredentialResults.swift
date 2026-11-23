import Foundation

struct CredentialCodeMethod: Sendable, Equatable {
  var id: String
  var title: String
  var sendsCode: Bool
}

struct CredentialChoice: Sendable, Equatable {
  var id: String
  var title: String
}

enum CredentialSignInNeed: Sendable, Equatable {
  case code(methods: [CredentialCodeMethod]?, method: CredentialCodeMethod?)
  case field(String)
  case approval(String)
  case account([CredentialChoice])
}

enum CredentialFailureState: String, Sendable {
  case signedOut
  case locked
  case unavailable
}

enum CredentialSignInOutcome: Sendable, Equatable {
  case done(sessionHandle: String?)
  case needs(CredentialSignInNeed, problem: String?, detail: String?, state: CredentialFailureState?)
  case failed(problem: String, detail: String?, state: CredentialFailureState?, field: String?)
}

struct CredentialWireError: Sendable, Equatable {
  var code: String
  var problem: String?
  var detail: String?
  var state: CredentialFailureState?
  var field: String?
}

struct CredentialReportedState: Sendable, Equatable {
  var state: VaultState
  var account: String?
  var serverPreset: String?
  var serverURL: String?
  var detail: String?
  var problem: String?
}

struct CredentialPage: Sendable {
  var snapshot: String
  var list: VaultItemList
  var cursor: String?
}

struct CredentialPasskeyKey: Sendable, Equatable {
  var credentialId: String
  var rpId: String
  var privateKey: Data
  var userHandle: Data
  var counter: Int
}

enum CredentialResults {
  struct Invalid: Error {}

  static func cleanedDisplay(_ value: Any?, longest: Int) -> String? {
    guard let text = value as? String else { return nil }
    if text.utf8.count <= longest, !CredentialCatalogParser.hasControlOrDirection(text) { return text }
    let visible = String(String.UnicodeScalarView(text.unicodeScalars.filter { !CredentialCatalogParser.isControlOrDirection($0) }))
    return CredentialVerbOutput.capped(visible, bytes: longest)
  }

  static func identifier(_ value: Any?, longest: Int) throws -> String {
    guard let text = value as? String, !text.isEmpty, text.utf8.count <= longest, !CredentialCatalogParser.hasControlOrDirection(text) else { throw Invalid() }
    return text
  }

  static func optionalIdentifier(_ value: Any?, longest: Int) throws -> String? {
    guard let value, !(value is NSNull) else { return nil }
    return try identifier(value, longest: longest)
  }

  static func secretText(_ value: Any?, longest: Int) throws -> String? {
    guard let value, !(value is NSNull) else { return nil }
    guard let text = value as? String, text.utf8.count <= longest else { throw Invalid() }
    return text
  }

  static func bool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  static func number(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
    return number.doubleValue
  }

  static func record(_ value: Any?) throws -> [String: Any] {
    guard let table = value as? [String: Any] else { throw Invalid() }
    return table
  }

  static func failureState(_ value: Any?) throws -> CredentialFailureState? {
    guard let value, !(value is NSNull) else { return nil }
    guard let text = value as? String, let state = CredentialFailureState(rawValue: text) else { throw Invalid() }
    return state
  }

  static func problem(_ value: Any?) throws -> String? {
    guard let value, !(value is NSNull) else { return nil }
    guard let text = value as? String, CredentialWording.problems.contains(text) else { throw Invalid() }
    return text
  }

  static func wireError(_ value: Any?) throws -> CredentialWireError {
    let table = try record(value)
    guard let code = table["code"] as? String, ["locked", "signedOut", "notFound", "unsupported", "failed"].contains(code) else { throw Invalid() }
    return CredentialWireError(
      code: code, problem: try problem(table["problem"]), detail: cleanedDisplay(table["detail"], longest: CredentialLimits.detailLength), state: try failureState(table["state"]),
      field: try optionalIdentifier(table["field"], longest: 40))
  }

  static func state(_ value: Any?) throws -> CredentialReportedState {
    let table = try record(value)
    guard let name = table["state"] as? String, let state = VaultState(rawValue: name), state != .notInstalled else { throw Invalid() }
    var reported = CredentialReportedState(state: state)
    reported.account = cleanedDisplay(table["account"], longest: CredentialLimits.accountLength).flatMap { $0.isEmpty ? nil : $0 }
    if let server = table["server"], !(server is NSNull) {
      let ref = try record(server)
      if let preset = ref["preset"] { reported.serverPreset = try identifier(preset, longest: 40) } else if let url = ref["url"] {
        reported.serverURL = cleanedDisplay(url, longest: CredentialLimits.urlLength)
      } else {
        throw Invalid()
      }
    }
    reported.detail = cleanedDisplay(table["detail"], longest: CredentialLimits.detailLength)
    reported.problem = try problem(table["problem"])
    return reported
  }

  static func choices(_ value: Any?) throws -> [CredentialChoice] {
    guard let list = value as? [Any], !list.isEmpty, list.count <= CredentialLimits.choices else { throw Invalid() }
    return try list.map { entry in
      let table = try record(entry)
      guard let title = cleanedDisplay(table["title"], longest: CredentialLimits.choiceTitleLength * 4), !title.isEmpty else { throw Invalid() }
      return CredentialChoice(id: try identifier(table["id"], longest: 64), title: title)
    }
  }

  static func signIn(_ value: Any?) throws -> CredentialSignInOutcome {
    let table = try record(value)
    guard let ok = bool(table["ok"]) else { throw Invalid() }
    if ok {
      guard let session = table["session"], !(session is NSNull) else { return .done(sessionHandle: nil) }
      guard let id = CredentialVerbLaunch.handleId(session) else { throw Invalid() }
      return .done(sessionHandle: id)
    }
    let detail = cleanedDisplay(table["detail"], longest: CredentialLimits.detailLength)
    let state = try failureState(table["state"])
    let problem = try problem(table["problem"])
    if let raw = table["need"], !(raw is NSNull) {
      let need = try record(raw)
      switch need["kind"] as? String {
      case "code":
        var methods: [CredentialCodeMethod]?
        if let listed = need["methods"], !(listed is NSNull) {
          guard let list = listed as? [Any] else { throw Invalid() }
          methods = try list.map { entry in
            let method = try record(entry)
            let choice = try choices([method]).first!
            return CredentialCodeMethod(id: choice.id, title: choice.title, sendsCode: bool(method["sendsCode"]) ?? false)
          }
        }
        let id = try optionalIdentifier(need["method"], longest: 64)
        let method = id.map { id in methods?.first { $0.id == id } ?? CredentialCodeMethod(id: id, title: id, sendsCode: false) }
        return .needs(.code(methods: methods, method: method), problem: problem, detail: detail, state: state)
      case "field":
        return .needs(.field(try identifier(need["field"], longest: 40)), problem: problem, detail: detail, state: state)
      case "approval":
        guard let url = need["url"] as? String, url.utf8.count <= CredentialLimits.urlLength else { throw Invalid() }
        return .needs(.approval(url), problem: problem, detail: detail, state: state)
      case "account":
        return .needs(.account(try choices(need["choices"])), problem: problem, detail: detail, state: state)
      default:
        throw Invalid()
      }
    }
    guard let problem else { throw Invalid() }
    return .failed(problem: problem, detail: detail, state: state, field: try optionalIdentifier(table["field"], longest: 40))
  }

  static func item(_ value: Any?, provider: String) throws -> VaultItem {
    let table = try record(value)
    let id = try identifier(table["id"], longest: CredentialLimits.itemIdLength)
    let title = cleanedDisplay(table["title"], longest: CredentialLimits.itemTitleLength) ?? ""
    let username = cleanedDisplay(table["username"], longest: CredentialLimits.usernameLength) ?? ""
    var urls: [String] = []
    if let listed = table["urls"] {
      guard let list = listed as? [Any] else { throw Invalid() }
      urls = list.prefix(CredentialLimits.urlsPerItem).compactMap { cleanedDisplay($0, longest: CredentialLimits.urlLength) }.filter { !$0.isEmpty }
    }
    var item = VaultItem(provider: provider, id: id, title: title, username: username, urls: urls)
    if let matches = table["urlMatch"] as? [Any] {
      let kept = matches.prefix(urls.count).map { ($0 as? String).flatMap { ["", "host", "exact"].contains($0) ? $0 : nil } ?? "" }
      if kept.count == urls.count { item.urlMatch = kept }
    }
    item.hasTotp = bool(table["hasTotp"])
    if let period = number(table["totpPeriod"]), period >= 1, period <= 300 { item.totpPeriod = Int(period) }
    item.vault = cleanedDisplay(table["vault"], longest: CredentialLimits.vaultNameLength).flatMap { $0.isEmpty ? nil : $0 }
    item.favorite = bool(table["favorite"])
    if let updated = number(table["updatedAt"]), updated > 0 { item.updatedAt = updated }
    if let listed = table["passkeys"], !(listed is NSNull) {
      guard let list = listed as? [Any] else { throw Invalid() }
      item.passkeys = try list.prefix(CredentialLimits.passkeysPerItem).map(passkey)
    }
    return item
  }

  static func passkey(_ value: Any) throws -> VaultItemPasskey {
    let table = try record(value)
    guard let counter = number(table["counter"]), counter >= 0, counter == counter.rounded() else { throw Invalid() }
    return VaultItemPasskey(
      credentialId: try identifier(table["credentialId"], longest: 512), rpId: try identifier(table["rpId"], longest: 253),
      userName: cleanedDisplay(table["userName"], longest: CredentialLimits.passkeyNameLength) ?? "",
      displayName: cleanedDisplay(table["displayName"], longest: CredentialLimits.passkeyNameLength) ?? "", discoverable: bool(table["discoverable"]) ?? true,
      counter: Int(counter))
  }

  static func page(_ value: Any?, provider: String) throws -> CredentialPage {
    let table = try record(value)
    let snapshot = try identifier(table["snapshot"], longest: CredentialLimits.snapshotLength)
    guard snapshot.range(of: #"^[A-Za-z0-9_-]{1,64}$"#, options: .regularExpression) != nil, let listed = table["items"] as? [Any] else { throw Invalid() }
    var list = VaultItemList(items: [])
    var seen: Set<String> = []
    for entry in listed {
      let item = try item(entry, provider: provider)
      guard seen.insert(item.id).inserted else { continue }
      list.items.append(item)
      if let secrets = (entry as? [String: Any])?["secrets"] as? [String: Any] {
        if let password = try secretText(secrets["password"], longest: CredentialLimits.passwordLength), !password.isEmpty { list.passwords[item.id] = password }
        if let totp = try secretText(secrets["totp"], longest: 4096), !totp.isEmpty { list.totps[item.id] = totp }
      }
    }
    var cursor: String?
    if let raw = table["cursor"], !(raw is NSNull) { cursor = try identifier(raw, longest: CredentialLimits.pageCursorLength) }
    return CredentialPage(snapshot: snapshot, list: list, cursor: cursor)
  }

  struct Revealed: Sendable, Equatable {
    var username: String?
    var password: String?
    var totpURI: String?
    var totpCode: String?
    var totpPeriod: Int?
  }

  static func revealed(_ value: Any?) throws -> Revealed {
    let table = try record(value)
    var revealed = Revealed()
    revealed.username = cleanedDisplay(table["username"], longest: CredentialLimits.usernameLength)
    revealed.password = try secretText(table["password"], longest: CredentialLimits.passwordLength)
    if let raw = table["totp"], !(raw is NSNull) {
      let totp = try record(raw)
      if let uri = totp["uri"] {
        revealed.totpURI = try secretText(uri, longest: 4096)
      } else if let code = totp["code"] {
        revealed.totpCode = try secretText(code, longest: 16)
        if let period = number(totp["period"]), period >= 1, period <= 300 { revealed.totpPeriod = Int(period) }
      } else {
        throw Invalid()
      }
    }
    return revealed
  }

  static func passkeyKey(_ value: Any?) throws -> CredentialPasskeyKey? {
    guard let value, !(value is NSNull) else { return nil }
    let table = try record(value)
    let key = try record(table["privateKey"])
    guard key["format"] as? String == "pkcs8", let der = key["der"] as? String, let privateKey = VaultBase64URL.decode(der),
      let handleText = table["userHandle"] as? String, let userHandle = VaultBase64URL.decode(handleText), (1...64).contains(userHandle.count),
      let counter = number(table["counter"])
    else { throw Invalid() }
    return CredentialPasskeyKey(
      credentialId: try identifier(table["credentialId"], longest: 512), rpId: try identifier(table["rpId"], longest: 253), privateKey: privateKey,
      userHandle: userHandle, counter: Int(counter))
  }
}
