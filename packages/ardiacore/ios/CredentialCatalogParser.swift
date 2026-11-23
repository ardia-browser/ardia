import Foundation

struct CredentialCatalogParser {
  static let root = "contributes.credentialProvider"
  static let keyPattern = #"^[A-Za-z0-9_-]{1,40}$"#
  static let symbolPattern = #"^[a-z0-9]+(\.[a-z0-9]+){0,7}$"#
  static let accentPattern = #"^#[0-9A-Fa-f]{6}$"#
  static let programPattern = #"^[a-z][a-z0-9._-]{0,31}$"#
  static let versionPattern = #"^\d{1,6}(\.\d{1,6}){1,3}$"#
  static let appURLPattern = #"^[a-z][a-z0-9+.-]{1,30}://$"#
  static let hostPattern = #"^[a-z0-9.-]{1,253}$"#
  static let envNamePattern = #"^[A-Z][A-Z0-9_]{0,63}$"#
  static let verbIdPattern = #"^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){0,3}$"#
  static let flagPattern = #"^--[a-z][a-z0-9-]{0,40}$"#
  static let contributionKeys: Set<String> = ["title", "symbol", "icon", "accent", "readsOffline", "approvalLastsSeconds", "capabilities", "signIn", "cli"]
  static let signInKeys: Set<String> = ["methods", "servers", "unlock", "approvalHosts"]
  static let methodKeys: Set<String> = ["id", "title", "kind", "fields", "twoStep", "appURL", "appTitle"]
  static let fieldKeys: Set<String> = ["id", "title", "type", "placeholder", "hint", "optional", "prefill", "masked"]
  static let serverKeys: Set<String> = ["id", "title", "custom"]
  static let cliKeys: Set<String> = ["name", "install", "minimumVersion", "patterns", "env", "onLock", "verbs"]
  static let verbKeys: Set<String> = ["argv", "slots", "env", "stdin", "timeoutMs", "outputLimitBytes", "output", "signIn", "unlocks", "outlivesCall", "hints"]
  static let slotKeys: Set<String> = ["type", "pattern", "values", "optional", "allowLocalHttp"]

  enum Outcome: Sendable {
    case accepted(CredentialContribution)
    case refused([String])
  }

  private(set) var problems: [String] = []

  static func parse(manifest data: Data) -> Outcome {
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return .refused(["plugin.json isn't a JSON object"]) }
    return parse(manifest: object)
  }

  static func parse(manifest: [String: Any]) -> Outcome {
    var parser = CredentialCatalogParser()
    let contribution = parser.read(manifest)
    if let contribution, parser.problems.isEmpty { return .accepted(contribution) }
    return .refused(parser.problems.isEmpty ? ["\(root) isn't readable"] : parser.problems)
  }

  static func declaresProvider(manifest data: Data) -> Bool {
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
    return (object["contributes"] as? [String: Any])?["credentialProvider"] != nil
  }

  mutating func problem(_ text: String) { problems.append(text) }

  static func matches(_ pattern: String, _ text: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }

  static func textLength(_ text: String) -> Int { text.utf16.count }

  static func hasControlOrDirection(_ text: String) -> Bool {
    text.unicodeScalars.contains(where: isControlOrDirection)
  }

  static func isControlOrDirection(_ scalar: Unicode.Scalar) -> Bool {
    if scalar.properties.generalCategory == .control { return true }
    switch scalar.value {
    case 0x061C, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069, 0x2028, 0x2029: return true
    default: return false
    }
  }

  mutating func text(_ value: Any?, _ path: String, most: Int, least: Int = 1, required: Bool = true) -> String? {
    guard let value else {
      if required { problem("\(path) must be text of \(least) to \(most) characters") }
      return nil
    }
    guard let text = value as? String, Self.textLength(text) >= least, Self.textLength(text) <= most else {
      problem("\(path) must be text of \(least) to \(most) characters")
      return nil
    }
    if Self.hasControlOrDirection(text) {
      problem("\(path) has control or direction characters")
      return nil
    }
    return text
  }

  mutating func flag(_ value: Any?, _ path: String, otherwise fallback: Bool) -> Bool {
    guard let value else { return fallback }
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
      problem("\(path) must be true or false")
      return fallback
    }
    return number.boolValue
  }

  mutating func whole(_ value: Any?, _ path: String, least: Int, most: Int) -> Int? {
    guard let value else { return nil }
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
      number.doubleValue == number.doubleValue.rounded(), number.doubleValue >= Double(least), number.doubleValue <= Double(most)
    else {
      problem("\(path) must be a whole number from \(least) to \(most)")
      return nil
    }
    return number.intValue
  }

  mutating func unknownKeys(_ object: [String: Any], allowed: Set<String>, _ describe: (String) -> String) {
    for key in object.keys.sorted() where !allowed.contains(key) { problem(describe(key)) }
  }

  static func isKey(_ text: String) -> Bool { matches(keyPattern, text) }

  mutating func read(_ manifest: [String: Any]) -> CredentialContribution? {
    let P = Self.root
    let contributes = manifest["contributes"] as? [String: Any] ?? [:]
    guard let raw = contributes["credentialProvider"] else {
      problem("\(P) is missing")
      return nil
    }
    let name = manifest["name"] as? String ?? ""
    if (manifest["main"] as? String)?.isEmpty != false { problem("\(P) needs a main") }
    if manifest["sidecar"] != nil { problem("\(P) runs in main, not a sidecar") }
    for key in contributes.keys.sorted() where key != "credentialProvider" { problem("contributes.\(key): a credential provider contributes nothing else") }
    if let permissions = manifest["permissions"] {
      let empty = (permissions as? [String: Any])?.isEmpty == true || (permissions as? [Any])?.isEmpty == true
      if !empty { problem("permissions: a credential provider asks for no permissions") }
    }
    if manifest["activationEvents"] != nil {
      problem("activationEvents: a credential provider starts when Ardia asks it, so it takes no activation events")
    }
    var memoryMB = CredentialLimits.memoryMB.standard
    if let given = manifest["memoryMB"] {
      if let number = given as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue == number.doubleValue.rounded(),
        number.intValue >= CredentialLimits.memoryMB.least, number.intValue <= CredentialLimits.memoryMB.most
      {
        memoryMB = number.intValue
      } else {
        problem("memoryMB must be a whole number from \(CredentialLimits.memoryMB.least) to \(CredentialLimits.memoryMB.most)")
      }
    }
    if (manifest["official"] as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue }) != true { problem("\(P) needs official: true") }
    guard let object = raw as? [String: Any] else {
      problem("\(P) must be an object")
      return nil
    }
    unknownKeys(object, allowed: Self.contributionKeys) { "\(P).\($0) isn't a key of \(P)" }
    let title = text(object["title"], "\(P).title", most: 40)
    var symbol: String?
    if let given = object["symbol"] {
      if let text = given as? String, Self.matches(Self.symbolPattern, text), text.count <= 64 { symbol = text } else { problem("\(P).symbol must be an SF Symbol name") }
    }
    var icon: String?
    if let given = object["icon"] {
      if let text = given as? String, Self.isPluginPng(text) { icon = text } else { problem("\(P).icon must be a .png file inside the plugin's folder, like icon.png") }
    }
    if object["symbol"] != nil, object["icon"] != nil { problem("\(P) takes a symbol or an icon, not both") }
    var accent: String?
    if let given = object["accent"] {
      if let text = given as? String, Self.matches(Self.accentPattern, text) { accent = text } else { problem("\(P).accent must be a color like #175DDC") }
    }
    let readsOffline = flag(object["readsOffline"], "\(P).readsOffline", otherwise: true)
    let approvalLasts = whole(object["approvalLastsSeconds"], "\(P).approvalLastsSeconds", least: 1, most: 86400)
    let capabilities = readCapabilities(object["capabilities"])
    var signIn: CredentialSignInSpec?
    if let given = object["signIn"] as? [String: Any] { signIn = readSignIn(given) } else { problem("\(P).signIn must be an object") }
    var cli: CredentialCliSpec?
    if let given = object["cli"] as? [String: Any] { cli = readCli(given) } else { problem("\(P).cli must be an object") }
    if let signIn {
      if capabilities.contains("selfHosted"), !signIn.servers.contains(where: \.isCustom) {
        problem("\(P).capabilities: selfHosted needs a custom server in \(P).signIn.servers")
      }
      if capabilities.contains("masterPassword"), signIn.unlockField == nil { problem("\(P).capabilities: masterPassword needs \(P).signIn.unlock") }
    }
    guard let title, let signIn, let cli else { return nil }
    return CredentialContribution(
      plugin: name, title: title, symbol: icon == nil ? (symbol ?? "key.fill") : nil, icon: icon, accent: accent, readsOffline: readsOffline,
      approvalLastsSeconds: approvalLasts, capabilities: capabilities, signIn: signIn, cli: cli, memoryMB: memoryMB)
  }

  static func isPluginPng(_ text: String) -> Bool {
    guard text.hasSuffix(".png"), !text.hasPrefix("/"), text.utf8.count <= 256, !text.contains("\\") else { return false }
    let parts = text.split(separator: "/", omittingEmptySubsequences: false)
    return parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." } && !hasControlOrDirection(text)
  }

  mutating func readCapabilities(_ value: Any?) -> [String] {
    let P = Self.root
    guard let value else { return [] }
    guard let list = value as? [Any], list.count <= 8 else {
      problem("\(P).capabilities must be a list of at most 8")
      return []
    }
    var seen: [String] = []
    for (index, entry) in list.enumerated() {
      guard let text = entry as? String, CredentialLimits.capabilities.contains(text) else {
        problem("\(P).capabilities[\(index)] must be one of \(CredentialLimits.capabilities.joined(separator: ", "))")
        continue
      }
      if seen.contains(text) {
        problem("\(P).capabilities has \(text) twice")
        continue
      }
      seen.append(text)
    }
    return seen
  }

  mutating func readSignIn(_ object: [String: Any]) -> CredentialSignInSpec? {
    let P = "\(Self.root).signIn"
    unknownKeys(object, allowed: Self.signInKeys) { "\(P).\($0) isn't a key of \(P)" }
    var hosts: [String] = []
    if let given = object["approvalHosts"] {
      if let list = given as? [Any], (1...8).contains(list.count) {
        for (index, entry) in list.enumerated() {
          if let host = entry as? String, Self.matches(Self.hostPattern, host), !host.hasPrefix("."), !host.hasSuffix("."), !host.contains("..") {
            hosts.append(host)
          } else {
            problem("\(P).approvalHosts[\(index)] must be a host name, like proton.me")
          }
        }
      } else {
        problem("\(P).approvalHosts must be a list of 1 to 8")
      }
    }
    var methods: [CredentialSignInSpec.Method] = []
    if let list = object["methods"] as? [Any], (1...4).contains(list.count) {
      for (index, entry) in list.enumerated() {
        guard let method = readMethod(entry, "\(P).methods[\(index)]", hasHosts: object["approvalHosts"] != nil) else { continue }
        if methods.contains(where: { $0.id == method.id }) {
          problem("\(P).methods has two methods named \(method.id)")
          continue
        }
        methods.append(method)
      }
    } else {
      problem("\(P).methods must be a list of 1 to 4")
    }
    var types: [String: CredentialSignInSpec.Field.FieldType] = [:]
    var reported: Set<String> = []
    for method in methods {
      for field in method.fields {
        if let known = types[field.id], known != field.type, !reported.contains(field.id) {
          reported.insert(field.id)
          let (first, second) = known == .secret ? (known, field.type) : (field.type, known)
          problem("\(P) has a field \(field.id) that is \(first.rawValue) in one method and \(second.rawValue) in another")
        }
        types[field.id] = types[field.id] ?? field.type
      }
    }
    var servers: [CredentialSignInSpec.Server] = []
    if let given = object["servers"] {
      if let list = given as? [Any], list.count <= 6 {
        for (index, entry) in list.enumerated() {
          guard let server = readServer(entry, "\(P).servers[\(index)]") else { continue }
          if servers.contains(where: { $0.id == server.id }) {
            problem("\(P).servers has two servers named \(server.id)")
            continue
          }
          if server.isCustom, servers.contains(where: \.isCustom) {
            problem("\(P).servers has two custom servers")
            continue
          }
          servers.append(server)
        }
      } else {
        problem("\(P).servers must be a list of at most 6")
      }
    }
    var unlockField: String?
    if let given = object["unlock"] {
      let field = (given as? [String: Any])?["field"] as? String
      if let field, (given as? [String: Any])?.count == 1, types[field] == .secret {
        unlockField = field
      } else {
        problem("\(P).unlock.field must name a secret field of \(P).methods")
      }
    }
    return CredentialSignInSpec(methods: methods, servers: servers, unlockField: unlockField, approvalHosts: hosts)
  }

  mutating func readMethod(_ value: Any, _ path: String, hasHosts: Bool) -> CredentialSignInSpec.Method? {
    guard let object = value as? [String: Any] else {
      problem("\(path) must be an object")
      return nil
    }
    unknownKeys(object, allowed: Self.methodKeys) { "\(path).\($0) isn't a key of a method" }
    var id: String?
    if let given = object["id"] as? String, Self.isKey(given) { id = given } else { problem("\(path).id must be 1 to 40 letters, digits, - and _") }
    let title = text(object["title"], "\(path).title", most: 40)
    var kind = CredentialSignInSpec.Kind.fields
    if let given = object["kind"] {
      if let text = given as? String, let parsed = CredentialSignInSpec.Kind(rawValue: text) {
        kind = parsed
      } else {
        problem("\(path).kind must be fields, desktopApproval or browserApproval")
      }
    }
    var fields: [CredentialSignInSpec.Field] = []
    let rawFields = object["fields"]
    if let list = rawFields as? [Any], list.count <= 6, kind != .fields || !list.isEmpty {
      for (index, entry) in list.enumerated() {
        if let field = readField(entry, "\(path).fields[\(index)]") { fields.append(field) }
      }
    } else if rawFields != nil || kind == .fields {
      problem(kind == .fields ? "\(path).fields must be a list of 1 to 6" : "\(path).fields must be a list of at most 6")
    }
    var seenFields: Set<String> = []
    for field in fields where !seenFields.insert(field.id).inserted { problem("\(path).fields has two fields named \(field.id)") }
    let twoStep = flag(object["twoStep"], "\(path).twoStep", otherwise: false)
    if object["twoStep"] != nil, kind != .fields { problem("\(path).twoStep only goes with kind fields") }
    var appURL: String?
    var appTitle: String?
    if kind == .desktopApproval {
      if let given = object["appURL"] as? String, Self.matches(Self.appURLPattern, given) {
        appURL = given
      } else {
        problem("\(path).appURL must be an app's address, like onepassword://")
      }
      appTitle = text(object["appTitle"], "\(path).appTitle", most: 40)
    } else {
      if object["appURL"] != nil { problem("\(path).appURL must be an app's address, like onepassword://") }
      if object["appTitle"] != nil { problem("\(path).appTitle must be text of 1 to 40 characters") }
    }
    if kind == .browserApproval, !hasHosts { problem("\(path) needs \(Self.root).signIn.approvalHosts") }
    guard let id, let title else { return nil }
    return CredentialSignInSpec.Method(id: id, title: title, kind: kind, fields: fields, twoStep: twoStep, appURL: appURL, appTitle: appTitle)
  }

  mutating func readField(_ value: Any, _ path: String) -> CredentialSignInSpec.Field? {
    guard let object = value as? [String: Any] else {
      problem("\(path) must be an object")
      return nil
    }
    unknownKeys(object, allowed: Self.fieldKeys) { "\(path).\($0) isn't a key of a field" }
    var id: String?
    if let given = object["id"] as? String, Self.isKey(given) { id = given } else { problem("\(path).id must be 1 to 40 letters, digits, - and _") }
    let title = text(object["title"], "\(path).title", most: 40)
    var type: CredentialSignInSpec.Field.FieldType?
    if let given = object["type"] as? String, let parsed = CredentialSignInSpec.Field.FieldType(rawValue: given) {
      type = parsed
    } else {
      problem("\(path).type must be text, email or secret")
    }
    let placeholder = text(object["placeholder"], "\(path).placeholder", most: 60, required: false)
    let hint = text(object["hint"], "\(path).hint", most: 120, required: false)
    let optional = flag(object["optional"], "\(path).optional", otherwise: false)
    var prefills = false
    if let given = object["prefill"] {
      if given as? String == "account" { prefills = true } else { problem("\(path).prefill must be account") }
    }
    let masked = flag(object["masked"], "\(path).masked", otherwise: true)
    if object["masked"] != nil, type != .secret { problem("\(path).masked only goes with type secret") }
    guard let id, let title, let type else { return nil }
    return CredentialSignInSpec.Field(
      id: id, title: title, type: type, placeholder: placeholder, hint: hint, optional: optional, prefillsAccount: prefills, masked: type == .secret && masked)
  }

  mutating func readServer(_ value: Any, _ path: String) -> CredentialSignInSpec.Server? {
    guard let object = value as? [String: Any] else {
      problem("\(path) must be an object")
      return nil
    }
    unknownKeys(object, allowed: Self.serverKeys) { "\(path).\($0) isn't a key of a server" }
    var id: String?
    if let given = object["id"] as? String, Self.isKey(given) { id = given } else { problem("\(path).id must be 1 to 40 letters, digits, - and _") }
    let title = text(object["title"], "\(path).title", most: 40)
    var customTitle: String?
    var customPlaceholder: String?
    if let given = object["custom"] {
      if let custom = given as? [String: Any] {
        unknownKeys(custom, allowed: ["title", "placeholder"]) { "\(path).custom.\($0) isn't a key of a custom server" }
        customTitle = text(custom["title"], "\(path).custom.title", most: 40)
        customPlaceholder = text(custom["placeholder"], "\(path).custom.placeholder", most: 60, required: false)
      } else {
        problem("\(path).custom must be an object")
      }
    }
    guard let id, let title else { return nil }
    if object["custom"] != nil, customTitle == nil { return nil }
    return CredentialSignInSpec.Server(id: id, title: title, customTitle: customTitle, customPlaceholder: customPlaceholder)
  }
}
