import Foundation

extension CredentialCatalogParser {
  mutating func readCli(_ object: [String: Any]) -> CredentialCliSpec? {
    let P = "\(Self.root).cli"
    unknownKeys(object, allowed: Self.cliKeys) { "\(P).\($0) isn't a key of \(P)" }
    var name: String?
    if let given = object["name"] as? String, Self.matches(Self.programPattern, given), !given.contains("/") { name = given } else { problem("\(P).name must be a program name, like bw") }
    var install: CredentialCliSpec.Install?
    if let given = object["install"] as? [String: Any] {
      unknownKeys(given, allowed: ["command", "update", "url"]) { "\(P).install.\($0) isn't a key of \(P).install" }
      let command = text(given["command"], "\(P).install.command", most: 200)
      let update = text(given["update"], "\(P).install.update", most: 200, required: false)
      var url: String?
      if let text = given["url"] as? String, Self.isHttpsURL(text, longest: 2048) { url = text } else { problem("\(P).install.url must be an https address") }
      if let command, let url { install = CredentialCliSpec.Install(command: command, update: update, url: url) }
    } else {
      problem("\(P).install must be an object")
    }
    var minimumVersion: String?
    if let given = object["minimumVersion"] {
      if let text = given as? String, Self.matches(Self.versionPattern, text) { minimumVersion = text } else { problem("\(P).minimumVersion must be a version, like 2024.6.0") }
    }
    var patterns: [String: String] = [:]
    if let given = object["patterns"] {
      if let table = given as? [String: Any], table.count <= 8 {
        for key in table.keys.sorted() {
          guard Self.isKey(key) else {
            problem("\(P).patterns: \(key) isn't a pattern name, like guid")
            continue
          }
          if let text = table[key] as? String, Self.isSafePattern(text) { patterns[key] = text } else {
            problem("\(P).patterns.\(key) must be a regular expression of 1 to 200 characters that starts with ^ and ends with $")
          }
        }
      } else {
        problem("\(P).patterns must be an object of at most 8 patterns")
      }
    }
    var envNames: [String] = []
    let env = readEnv(object["env"], "\(P).env", slots: nil, names: &envNames)
    var verbs: [String: CredentialVerb] = [:]
    var order: [String] = []
    if let table = object["verbs"] as? [String: Any], (1...48).contains(table.count) {
      for id in table.keys.sorted() {
        guard Self.matches(Self.verbIdPattern, id), id.count <= 48 else {
          problem("\(P).verbs: \(id) isn't a verb id, like list.items")
          continue
        }
        guard let raw = table[id] as? [String: Any] else {
          problem("\(P).verbs.\(id) must be an object")
          continue
        }
        var names = envNames
        if let verb = readVerb(raw, id: id, program: name ?? "", patterns: patterns, names: &names) {
          verbs[id] = verb
          order.append(id)
        }
      }
    } else {
      problem("\(P).verbs must be an object of 1 to 48 verbs")
    }
    let onLock = readOnLock(object["onLock"], verbs: verbs)
    guard let name, let install else { return nil }
    return CredentialCliSpec(name: name, install: install, minimumVersion: minimumVersion, patterns: patterns, env: env, onLock: onLock, verbs: verbs, verbOrder: order)
  }

  static func isHttpsURL(_ text: String, longest: Int) -> Bool {
    guard text.utf8.count <= longest, !text.contains(where: \.isWhitespace), let components = URLComponents(string: text), components.scheme == "https",
      let host = components.host, !host.isEmpty, components.user == nil, components.password == nil
    else { return false }
    return true
  }

  static func isSafePattern(_ text: String) -> Bool {
    guard (1...200).contains(text.count), text.hasPrefix("^"), text.hasSuffix("$") else { return false }
    for banned in ["(?=", "(?!", "(?<=", "(?<!", "\\k<", "(?>", "(?#", "(?i", "(?m", "(?s", "(?x", "(?u", "(?w"] where text.contains(banned) { return false }
    if text.range(of: #"\\[1-9]"#, options: .regularExpression) != nil { return false }
    return (try? NSRegularExpression(pattern: text)) != nil
  }

  mutating func readEnv(_ value: Any?, _ path: String, slots: [String: CredentialVerb.Slot]?, names: inout [String]) -> [CredentialEnvEntry] {
    guard let value else { return [] }
    guard let list = value as? [Any], list.count <= 16 else {
      problem("\(path) must be a list of at most 16")
      return []
    }
    var entries: [CredentialEnvEntry] = []
    for (index, raw) in list.enumerated() {
      let at = "\(path)[\(index)]"
      guard let object = raw as? [String: Any], let name = object["name"] as? String else {
        problem("\(at) needs a name and exactly one of literal, secretSlot, testFolder or testLiteral")
        continue
      }
      let sources = ["literal", "secretSlot", "testFolder", "testLiteral"].filter { object[$0] != nil }
      guard sources.count == 1, object.count == 2 else {
        problem("\(at) needs a name and exactly one of literal, secretSlot, testFolder or testLiteral")
        continue
      }
      guard Self.matches(Self.envNamePattern, name) else {
        problem("\(at).name must be an environment variable name, like BW_NOINTERACTION")
        continue
      }
      if CredentialLimits.hostEnv.contains(name) {
        problem("\(at).name: \(name) is set by Ardia")
        continue
      }
      let kind = sources[0]
      if kind != "testFolder", let pattern = CredentialLimits.isDeniedEnvName(name) {
        problem("\(at).name: \(name) matches \(pattern), which Ardia never passes")
        continue
      }
      if names.contains(name) {
        problem("\(path) has \(name) twice")
        continue
      }
      let source: CredentialEnvEntry.Source
      switch kind {
      case "literal", "testLiteral":
        guard let text = object[kind] as? String, text.utf16.count <= 256, !Self.hasControlOrDirection(text) else {
          problem("\(at).\(kind) must be text of at most 256 characters with no control characters")
          continue
        }
        source = kind == "literal" ? .literal(text) : .testLiteral(text)
        if kind == "testLiteral", slots != nil {
          problem("\(at).testLiteral: only \(Self.root).cli.env takes a test literal")
          continue
        }
      case "secretSlot":
        guard let slots else {
          problem("\(at).secretSlot: only a verb's env can name a slot")
          continue
        }
        guard let slot = object[kind] as? String, slots[slot]?.type == .secret else {
          problem("\(at).secretSlot: \(object[kind] as? String ?? "it") isn't a secret slot of this verb")
          continue
        }
        source = .secretSlot(slot)
      default:
        guard slots == nil else {
          problem("\(at).testFolder: only \(Self.root).cli.env takes a test folder")
          continue
        }
        guard let folder = object[kind] as? String, Self.isTestFolder(folder) else {
          problem("\(at).testFolder must be empty or a plain folder name")
          continue
        }
        source = .testFolder(folder)
      }
      names.append(name)
      entries.append(CredentialEnvEntry(name: name, source: source))
    }
    return entries
  }

  static func isTestFolder(_ text: String) -> Bool {
    if text.isEmpty { return true }
    guard text.utf8.count <= 64, !text.hasPrefix("/"), !hasControlOrDirection(text) else { return false }
    return text.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  mutating func readVerb(_ object: [String: Any], id: String, program: String, patterns: [String: String], names: inout [String]) -> CredentialVerb? {
    let path = "\(Self.root).cli.verbs.\(id)"
    unknownKeys(object, allowed: Self.verbKeys) { "\(path).\($0) isn't a key of a verb" }
    let slots = readSlots(object["slots"], path, patterns: patterns)
    var used: Set<String> = []
    var argv: [CredentialVerb.Element] = []
    if let list = object["argv"] as? [Any], (1...32).contains(list.count) {
      for (index, raw) in list.enumerated() {
        let at = "\(path).argv[\(index)]"
        if let token = raw as? String {
          guard Self.isPlainToken(token) else {
            problem("\(at) must be a plain token: no spaces, newlines, NUL or a lone --")
            continue
          }
          argv.append(.token(token))
          continue
        }
        if index == 0 {
          problem("\(at) must be a plain token, the subcommand")
          continue
        }
        guard let element = raw as? [String: Any] else {
          problem("\(at) must be a plain token: no spaces, newlines, NUL or a lone --")
          continue
        }
        let flag = element["flag"] as? String
        if element["flag"] != nil, flag.map({ Self.matches(Self.flagPattern, $0) }) != true {
          problem("\(at).flag must be a long option, like --method")
          continue
        }
        if element["slot"] != nil, element["when"] != nil {
          problem("\(at) takes a slot or a when, not both")
          continue
        }
        if let when = element["when"] as? String {
          guard let flag, slots[when]?.type == .flag else {
            problem(flag == nil ? "\(at).flag must be a long option, like --method" : "\(at).when: \(when) isn't a flag slot of this verb")
            continue
          }
          used.insert(when)
          argv.append(.flagWhen(flag: flag, slot: when))
          continue
        }
        guard let slot = element["slot"] as? String else {
          problem("\(at) must be a plain token: no spaces, newlines, NUL or a lone --")
          continue
        }
        guard let kind = slots[slot]?.type else {
          problem("\(at).slot: \(slot) isn't one of this verb's slots")
          continue
        }
        switch kind {
        case .secret:
          problem("\(at): a secret slot can't go in argv, where other programs see it")
          continue
        case .json:
          problem("\(at): a json slot only goes in stdin")
          continue
        case .flag:
          problem("\(at): a flag slot goes in a when")
          continue
        default: break
        }
        used.insert(slot)
        argv.append(flag.map { .flagSlot(flag: $0, slot: slot) } ?? .slot(slot))
      }
    } else {
      problem("\(path).argv must be a list of 1 to 32 tokens and slots")
    }
    let env = readEnv(object["env"], "\(path).env", slots: slots, names: &names)
    for entry in env { if case .secretSlot(let slot) = entry.source { used.insert(slot) } }
    var stdin: CredentialVerb.Stdin?
    if let given = object["stdin"] {
      if let table = given as? [String: Any] {
        let slot = table["slot"] as? String
        let encoding = table["encoding"] as? String ?? "utf8"
        if let slot, let kind = slots[slot]?.type, kind == .json || kind == .secret {
          if encoding == "utf8" || encoding == "base64" {
            stdin = CredentialVerb.Stdin(slot: slot, base64: encoding == "base64")
            used.insert(slot)
          } else {
            problem("\(path).stdin.encoding must be utf8 or base64")
          }
        } else {
          problem("\(path).stdin.slot: \(slot ?? "it") must be a json or secret slot of this verb")
        }
      } else {
        problem("\(path).stdin must be an object")
      }
    }
    for name in slots.keys.sorted() where !used.contains(name) { problem("\(path).slots.\(name) isn't used in argv, env or stdin") }
    let timeoutMs = whole(object["timeoutMs"], "\(path).timeoutMs", least: CredentialLimits.verbTimeout.least, most: CredentialLimits.verbTimeout.most)
      ?? CredentialLimits.verbTimeout.standard
    let outputLimit = whole(object["outputLimitBytes"], "\(path).outputLimitBytes", least: CredentialLimits.leastOutputBytes, most: CredentialLimits.mostOutputBytes)
      ?? CredentialLimits.defaultOutputBytes
    var output = CredentialVerb.Output.lines
    if let table = object["output"] as? [String: Any] {
      let mode = table["mode"] as? String
      switch mode {
      case "json":
        if let items = table["items"] {
          if let text = items as? String, text == "$" || Self.isKey(text) { output = .json(items: text) } else {
            problem("\(path).output.items must be $ or a key")
            output = .json(items: nil)
          }
        } else {
          output = .json(items: nil)
        }
      case "lines": output = .lines
      case "lastLineSecret": output = .lastLineSecret
      case "stream": output = .stream
      default: problem("\(path).output.mode must be json, lines, lastLineSecret or stream")
      }
      if mode != "json", table["items"] != nil { problem("\(path).output.items only goes with mode json") }
    } else if object["output"] != nil {
      problem("\(path).output.mode must be json, lines, lastLineSecret or stream")
    }
    let signIn = flag(object["signIn"], "\(path).signIn", otherwise: false)
    var unlocks = CredentialVerb.Unlocks.no
    if let given = object["unlocks"] {
      if let number = given as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
        unlocks = number.boolValue ? .yes : .no
      } else if let table = given as? [String: Any], table.count == 1, let persistent = table["persistent"] as? NSNumber, CFGetTypeID(persistent) == CFBooleanGetTypeID() {
        if output != .lastLineSecret { problem("\(path).unlocks.persistent only goes with mode lastLineSecret") }
        unlocks = persistent.boolValue ? .persistent : .yes
      } else {
        problem("\(path).unlocks must be true, false or { persistent: true }")
      }
      if unlocks != .no, !signIn { problem("\(path).unlocks needs signIn: true") }
    }
    if output == .lastLineSecret, unlocks == .no { problem("\(path): a lastLineSecret verb must unlock, since its secret goes nowhere else") }
    let outlives = flag(object["outlivesCall"], "\(path).outlivesCall", otherwise: false)
    if outlives, !signIn || output != .stream { problem("\(path).outlivesCall needs signIn: true and mode stream") }
    var hints: [String: [String]] = [:]
    var hintOrder: [String] = []
    if let given = object["hints"] {
      if let table = given as? [String: Any], table.count <= 16 {
        for key in table.keys.sorted() {
          guard Self.isKey(key) else {
            problem("\(path).hints: \(key) isn't a hint id, like wrongCode")
            continue
          }
          if let list = table[key] as? [Any], (1...16).contains(list.count),
            let texts = list as? [String], texts.allSatisfy({ (1...120).contains($0.utf16.count) })
          {
            hints[key] = texts
            hintOrder.append(key)
          } else {
            problem("\(path).hints.\(key) must be a list of 1 to 16 texts of 1 to 120 characters")
          }
        }
      } else {
        problem("\(path).hints must be an object of at most 16 hints")
      }
    }
    if let denied = Self.literalDenial(program: program, argv: argv, slots: slots) {
      problem("\(path): \(program) \(denied.parseName) is never allowed, since \(denied.why)")
    }
    return CredentialVerb(
      id: id, argv: argv, slots: slots, env: env, stdin: stdin, timeoutMs: timeoutMs, outputLimitBytes: outputLimit, output: output, signIn: signIn,
      unlocks: unlocks, outlivesCall: outlives, hints: hints, hintOrder: hintOrder)
  }

  static func literalDenial(program: String, argv: [CredentialVerb.Element], slots: [String: CredentialVerb.Slot]) -> CredentialLimits.DeniedMatch? {
    let placeholder = "\u{0}"
    func rendered(choosing chosen: (slot: String, value: String)?) -> [String] {
      argv.map { element in
        switch element {
        case .token(let token): return token
        case .slot(let slot): return chosen?.slot == slot ? chosen!.value : placeholder
        case .flagSlot(let flag, _): return flag + "=" + placeholder
        case .flagWhen(let flag, _): return flag
        }
      }
    }
    if let denied = CredentialVerbLaunch.deniedCommand(program: program, argv: rendered(choosing: nil)) { return denied }
    for case .slot(let slot) in argv {
      guard case .choice(let values)? = slots[slot]?.type else { continue }
      for value in values {
        if let denied = CredentialVerbLaunch.deniedCommand(program: program, argv: rendered(choosing: (slot, value))) { return denied }
      }
    }
    return nil
  }

  static func isPlainToken(_ token: String) -> Bool {
    guard (1...256).contains(token.utf8.count), token != "--" else { return false }
    return !token.unicodeScalars.contains { $0.properties.isWhitespace || $0.value == 0 || isControlOrDirection($0) }
  }

  mutating func readSlots(_ value: Any?, _ path: String, patterns: [String: String]) -> [String: CredentialVerb.Slot] {
    guard let value else { return [:] }
    guard let table = value as? [String: Any], table.count <= 16 else {
      problem("\(path).slots must be an object of at most 16 slots")
      return [:]
    }
    var slots: [String: CredentialVerb.Slot] = [:]
    for name in table.keys.sorted() {
      let at = "\(path).slots.\(name)"
      guard Self.isKey(name) else {
        problem("\(path).slots: \(name) isn't a slot name, like email")
        continue
      }
      guard let object = table[name] as? [String: Any] else {
        problem("\(at) must be an object")
        continue
      }
      unknownKeys(object, allowed: Self.slotKeys) { "\(at).\($0) isn't a key of a slot" }
      let optional = flag(object["optional"], "\(at).optional", otherwise: false)
      let type: CredentialVerb.SlotType?
      switch object["type"] as? String {
      case "id":
        if let pattern = object["pattern"] as? String, patterns[pattern] != nil { type = .id(pattern: pattern) } else {
          problem("\(at).pattern must name one of \(Self.root).cli.patterns")
          type = nil
        }
      case "enum":
        if let list = object["values"] as? [String], (1...16).contains(list.count),
          list.allSatisfy({ (1...64).contains($0.utf8.count) && !$0.hasPrefix("-") && Self.isPlainToken($0) }), Set(list).count == list.count
        {
          type = .choice(list)
        } else {
          problem("\(at).values must be a list of 1 to 16 tokens")
          type = nil
        }
      case "flag": type = .flag
      case "url":
        let local = flag(object["allowLocalHttp"], "\(at).allowLocalHttp", otherwise: false)
        type = .url(allowLocalHttp: local)
      case "email": type = .email
      case "code": type = .code
      case "secret": type = .secret
      case "json": type = .json
      default:
        problem("\(at).type must be one of id, enum, flag, url, email, code, secret or json")
        type = nil
      }
      if object["allowLocalHttp"] != nil, object["type"] as? String != "url" { problem("\(at).allowLocalHttp only goes with type url") }
      if object["pattern"] != nil, object["type"] as? String != "id" { problem("\(at).pattern only goes with type id") }
      if object["values"] != nil, object["type"] as? String != "enum" { problem("\(at).values only goes with type enum") }
      if let type { slots[name] = CredentialVerb.Slot(type: type, optional: optional) }
    }
    return slots
  }

  mutating func readOnLock(_ value: Any?, verbs: [String: CredentialVerb]) -> CredentialCliSpec.OnLock? {
    let path = "\(Self.root).cli.onLock"
    guard let value else { return nil }
    guard let object = value as? [String: Any] else {
      problem("\(path) must be an object")
      return nil
    }
    unknownKeys(object, allowed: ["verb", "params", "skipWithTouchID"]) { "\(path).\($0) isn't a key of \(path)" }
    guard let id = object["verb"] as? String, let verb = verbs[id] else {
      problem("\(path).verb: \(object["verb"] as? String ?? "it") isn't one of \(Self.root).cli.verbs")
      return nil
    }
    var params: [String: CredentialCliSpec.OnLock.Source] = [:]
    for (slot, raw) in (object["params"] as? [String: Any] ?? [:]).sorted(by: { $0.key < $1.key }) {
      let source = raw as? [String: Any] ?? [:]
      if source.count == 1, source["from"] as? String == "session", verb.slots[slot]?.type == .secret {
        params[slot] = .session
      } else if source.count == 2, source["from"] as? String == "preference", let key = source["key"] as? String, Self.isKey(key), verb.slots[slot] != nil {
        params[slot] = .preference(key)
      } else if source.count == 1, let literal = source["literal"] as? String, verb.slots[slot] != nil, verb.slots[slot]?.type != .secret {
        params[slot] = .literal(literal)
      } else {
        problem("\(path).params.\(slot) must be { from: session }, { from: preference, key } or { literal }")
      }
    }
    let skip = flag(object["skipWithTouchID"], "\(path).skipWithTouchID", otherwise: false)
    return CredentialCliSpec.OnLock(verb: id, params: params, skipWithTouchID: skip)
  }
}
