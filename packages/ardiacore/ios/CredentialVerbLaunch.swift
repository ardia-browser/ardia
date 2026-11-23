import Foundation

struct CredentialRefusal: Error, Equatable, Sendable {
  enum Code: String, Sendable {
    case refused
    case badRequest = "bad_request"
    case failed
    case overloaded
    case stale
    case expired
    case denied
    case closed
  }

  let code: Code
  let message: String

  init(_ code: Code, _ message: String) {
    self.code = code
    self.message = message
  }

  var wire: [String: Any] { ["code": code.rawValue, "message": message] }
}

struct CredentialSecretUse: Sendable, Equatable {
  let handle: String
  let value: String
}

struct CredentialVerbLaunch: Sendable, Equatable {
  var verb: String
  var argv: [String]
  var env: [(String, String)]
  var stdin: Data?
  var timeoutMs: Int
  var outputLimitBytes: Int
  var signIn: Bool
  var secrets: [CredentialSecretUse]
  var stdinTexts: [String]
  var testFolders: [String]

  static func == (left: CredentialVerbLaunch, right: CredentialVerbLaunch) -> Bool {
    left.verb == right.verb && left.argv == right.argv && left.env.map { "\($0.0)=\($0.1)" } == right.env.map { "\($0.0)=\($0.1)" }
      && left.stdin == right.stdin && left.timeoutMs == right.timeoutMs && left.outputLimitBytes == right.outputLimitBytes && left.signIn == right.signIn
      && left.secrets == right.secrets && left.stdinTexts == right.stdinTexts && left.testFolders == right.testFolders
  }

  var environment: [String: String] { Dictionary(env, uniquingKeysWith: { _, later in later }) }
  var secretValues: [String] { secrets.map(\.value) }
  var handles: [String] { secrets.map(\.handle) }

  static let handleKey = "$secret"
  static let handlePattern = #"^h[1-9][0-9]{0,15}$"#

  static func handleId(_ value: Any?) -> String? {
    guard let table = value as? [String: Any], table.count == 1, let id = table[handleKey] as? String,
      id.range(of: handlePattern, options: .regularExpression) != nil
    else { return nil }
    return id
  }

  static func containsHandle(_ value: Any?) -> Bool {
    if let table = value as? [String: Any] { return table[handleKey] != nil || table.values.contains(where: containsHandle) }
    if let list = value as? [Any] { return list.contains(where: containsHandle) }
    return false
  }

  static func build(
    cli: CredentialCliSpec, verbId: String, params: [String: Any], requestedTimeoutMs: Int?, testFolderBase: String?,
    secret: (String) -> String?
  ) -> Result<CredentialVerbLaunch, CredentialRefusal> {
    guard let verb = cli.verb(verbId) else { return .failure(CredentialRefusal(.refused, "\(cli.name) has no verb \(verbId).")) }
    if params.count > CredentialLimits.verbParams { return .failure(CredentialRefusal(.badRequest, "\(verbId) takes at most \(CredentialLimits.verbParams) params.")) }
    for name in params.keys.sorted() where verb.slots[name] == nil {
      return .failure(CredentialRefusal(.badRequest, "\(verbId) has no slot named \(name)."))
    }
    var texts: [String: String] = [:]
    var flags: [String: Bool] = [:]
    var secrets: [String: CredentialSecretUse] = [:]
    var json: [String: Any] = [:]
    for name in verb.slots.keys.sorted() {
      let slot = verb.slots[name]!
      let raw = params[name]
      if raw == nil || raw is NSNull {
        if slot.optional { continue }
        return .failure(CredentialRefusal(.badRequest, "\(name) is required for \(verbId)."))
      }
      if slot.type != .secret, slot.type != .json, handleId(raw) != nil {
        return .failure(CredentialRefusal(.badRequest, "a handle only goes in a secret slot."))
      }
      switch slot.type {
      case .secret:
        guard let id = handleId(raw) else { return .failure(CredentialRefusal(.badRequest, "\(name) for \(verbId) must be a secret handle.")) }
        guard let value = secret(id) else { return .failure(CredentialRefusal(.expired, "\(id) was used or has ended.")) }
        guard value.utf8.count <= CredentialLimits.secretBytes else { return .failure(CredentialRefusal(.badRequest, "\(name) for \(verbId) is longer than Ardia passes.")) }
        secrets[name] = CredentialSecretUse(handle: id, value: value)
      case .json:
        if containsHandle(raw) { return .failure(CredentialRefusal(.badRequest, "a handle only goes in a secret slot.")) }
        guard let value = raw, depth(of: value) <= CredentialLimits.stdinJsonDepth, JSONSerialization.isValidJSONObject([value]) else {
          return .failure(CredentialRefusal(.badRequest, "\(name) for \(verbId) must be JSON of at most 4 MB and 32 levels."))
        }
        json[name] = value
      case .flag:
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
          return .failure(CredentialRefusal(.badRequest, "\(name) for \(verbId) must be true or false."))
        }
        flags[name] = number.boolValue
      default:
        guard let text = raw as? String else { return .failure(CredentialRefusal(.badRequest, "\(name) for \(verbId) must be \(describe(slot.type)).")) }
        if let problem = textProblem(text, slot.type, patterns: cli.patterns) {
          return .failure(CredentialRefusal(.badRequest, "\(name) for \(verbId) must be \(problem)."))
        }
        texts[name] = text
      }
    }
    var argv: [String] = []
    for element in verb.argv {
      switch element {
      case .token(let token): argv.append(token)
      case .slot(let slot):
        guard let value = texts[slot] else { continue }
        if value.hasPrefix("-") { return .failure(CredentialRefusal(.badRequest, "\(slot) for \(verbId) can't start with -, since \(cli.name) would read it as an option.")) }
        argv.append(value)
      case .flagSlot(let flag, let slot):
        guard let value = texts[slot] else { continue }
        argv.append("\(flag)=\(value)")
      case .flagWhen(let flag, let slot):
        if flags[slot] == true { argv.append(flag) }
      }
    }
    if let unsafe = argv.first(where: { $0 == "--" || $0.contains("\0") || $0.contains("\n") || $0.contains("\r") }) {
      return .failure(CredentialRefusal(.denied, unsafe == "--" ? "a lone -- is never allowed, since it passes arguments through." : "an argument with NUL or a newline is never allowed."))
    }
    if let denied = deniedCommand(program: cli.name, argv: argv) {
      return .failure(CredentialRefusal(.denied, "\(cli.name) \(denied.runName) is never allowed."))
    }
    var env: [(String, String)] = []
    var folders: [String] = []
    for entry in cli.env {
      switch entry.source {
      case .literal(let value): env.append((entry.name, value))
      case .testLiteral(let value): if testFolderBase != nil { env.append((entry.name, value)) }
      case .testFolder(let sub):
        guard let base = testFolderBase else { continue }
        let folder = sub.isEmpty ? base : (base as NSString).appendingPathComponent(sub)
        folders.append(folder)
        env.append((entry.name, folder))
      case .secretSlot: continue
      }
    }
    var used: [CredentialSecretUse] = []
    for entry in verb.env {
      switch entry.source {
      case .literal(let value): env.append((entry.name, value))
      case .secretSlot(let slot):
        guard let use = secrets[slot] else { continue }
        env.append((entry.name, use.value))
        if !used.contains(use) { used.append(use) }
      case .testLiteral, .testFolder: continue
      }
    }
    var stdin: Data?
    var stdinTexts: [String] = []
    if let spec = verb.stdin {
      var plain: Data?
      if let use = secrets[spec.slot] {
        plain = Data(use.value.utf8)
        if !used.contains(use) { used.append(use) }
      } else if let value = json[spec.slot] {
        guard let encoded = encodedJSON(value), encoded.count <= CredentialLimits.stdinBytes else {
          return .failure(CredentialRefusal(.badRequest, "\(spec.slot) for \(verbId) must be JSON of at most 4 MB and 32 levels."))
        }
        plain = encoded
        stdinTexts = strings(in: value).filter { $0.count >= CredentialLimits.stdinRedactedShortest }
      }
      if let plain { stdin = spec.base64 ? Data(plain.base64EncodedString().utf8) : plain }
    }
    let timeout = min(max(requestedTimeoutMs ?? verb.timeoutMs, CredentialLimits.verbTimeout.least), verb.timeoutMs)
    return .success(
      CredentialVerbLaunch(
        verb: verbId, argv: argv, env: env, stdin: stdin, timeoutMs: timeout, outputLimitBytes: verb.outputLimitBytes, signIn: verb.signIn, secrets: used,
        stdinTexts: stdinTexts, testFolders: folders))
  }

  static func describe(_ type: CredentialVerb.SlotType) -> String {
    switch type {
    case .id: return "an id that matches its pattern, at most 512 characters"
    case .choice(let values): return "one of \(values.joined(separator: ", "))"
    case .flag: return "true or false"
    case .url(let local): return local ? "an https address, or http to this Mac" : "an https address"
    case .email: return "an email address"
    case .code: return "1 to 64 letters and digits"
    case .secret: return "a secret handle"
    case .json: return "JSON of at most 4 MB and 32 levels"
    }
  }

  static func textProblem(_ text: String, _ type: CredentialVerb.SlotType, patterns: [String: String]) -> String? {
    switch type {
    case .id(let name):
      guard let pattern = patterns[name], text.utf8.count <= CredentialLimits.idSlotLength, !text.isEmpty,
        wholeMatch(pattern, text)
      else { return describe(type) }
      return nil
    case .choice(let values): return values.contains(text) ? nil : describe(type)
    case .url(let local): return isAllowedURL(text, allowLocalHttp: local) ? nil : describe(type)
    case .email:
      guard text.contains("@"), !text.hasPrefix("-"), text.utf8.count <= CredentialLimits.emailSlotLength,
        !text.unicodeScalars.contains(where: { $0.properties.isWhitespace || CredentialCatalogParser.isControlOrDirection($0) })
      else { return describe(type) }
      return nil
    case .code: return wholeMatch(#"^[A-Za-z0-9]{1,64}$"#, text) ? nil : describe(type)
    case .flag, .secret, .json: return describe(type)
    }
  }

  static func wholeMatch(_ pattern: String, _ text: String) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
    let whole = NSRange(text.startIndex..., in: text)
    return regex.firstMatch(in: text, options: [.anchored], range: whole)?.range == whole
  }

  static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]

  static func isAllowedURL(_ text: String, allowLocalHttp: Bool) -> Bool {
    guard text.utf8.count <= CredentialLimits.urlSlotLength, !text.hasPrefix("-"),
      !text.unicodeScalars.contains(where: { $0.properties.isWhitespace || CredentialCatalogParser.isControlOrDirection($0) }),
      let components = URLComponents(string: text), let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(), !host.isEmpty,
      components.user == nil, components.password == nil
    else { return false }
    if scheme == "https" { return true }
    return allowLocalHttp && scheme == "http" && loopbackHosts.contains(host)
  }

  static func depth(of value: Any) -> Int {
    if let table = value as? [String: Any] { return 1 + (table.values.map(depth).max() ?? 0) }
    if let list = value as? [Any] { return 1 + (list.map(depth).max() ?? 0) }
    return 0
  }

  static func encodedJSON(_ value: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject([value]) else { return nil }
    return try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed])
  }

  static func strings(in value: Any) -> [String] {
    if let text = value as? String { return [text] }
    if let table = value as? [String: Any] { return table.keys.sorted().flatMap { strings(in: table[$0]!) } }
    if let list = value as? [Any] { return list.flatMap(strings) }
    return []
  }

  static func deniedCommand(program: String, argv: [String]) -> CredentialLimits.DeniedMatch? {
    guard let denied = CredentialLimits.deniedCommands[program] else { return nil }
    let global = CredentialLimits.globalFlags[program] ?? []
    let valued = CredentialLimits.globalFlagsTakingValues[program] ?? []
    var index = 0
    while index < argv.count {
      let token = argv[index]
      let flag = token.split(separator: "=", maxSplits: 1).first.map(String.init) ?? token
      guard global.contains(flag) else { break }
      index += !token.contains("=") && valued.contains(flag) ? 2 : 1
    }
    let rest = Array(argv[min(index, argv.count)...])
    if let first = rest.first, first.hasPrefix("-") {
      return CredentialLimits.DeniedMatch(argv: [first.split(separator: "=", maxSplits: 1).first.map(String.init) ?? first], flag: nil, why: CredentialLimits.unknownLeadingOption)
    }
    let words = rest.filter { !$0.hasPrefix("-") }
    for command in denied where rest.starts(with: command.argv) || words.starts(with: command.argv) {
      if command.withFlags.isEmpty { return CredentialLimits.DeniedMatch(argv: command.argv, flag: nil, why: command.why) }
      if let flag = command.withFlags.first(where: { flag in rest.contains { Self.spells($0, flag) } }) {
        return CredentialLimits.DeniedMatch(argv: command.argv, flag: flag, why: command.why)
      }
    }
    return nil
  }

  static func spells(_ token: String, _ flag: String) -> Bool {
    if token == flag || token.hasPrefix(flag + "=") { return true }
    return !flag.hasPrefix("--") && flag.count == 2 && token.hasPrefix(flag)
  }
}
