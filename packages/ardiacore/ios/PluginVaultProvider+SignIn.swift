import Foundation

extension PluginVaultProvider {
  func signIn(_ cli: VaultCLI, fields: VaultSignInFields) async -> VaultSignInResult {
    if let answer = fields.answer { return await continueAttempt(cli, answer) }
    let method = fields.method.flatMap { contribution.signIn.method($0)?.id } ?? contribution.signIn.methods.first?.id ?? ""
    let fresh = SignInAttempt(kind: .signIn, method: method, server: fields.server, values: fields.values, secrets: fields.secrets)
    stateLock.withLock {
      attempt = fresh
      pendingNeeds = nil
    }
    return await run(cli, fresh)
  }

  func unlock(_ cli: VaultCLI, password: String?) async -> VaultSignInResult {
    stateLock.withLock { pendingNeeds = nil }
    return await unlockCall(cli, password: password, attempt: SignInAttempt(kind: .unlock, method: contribution.signIn.methods.first?.id ?? ""))
  }

  func unlockCall(_ cli: VaultCLI, password: String?, attempt: SignInAttempt) async -> VaultSignInResult {
    let answer = await call("unlock", cli) { builder in
      ["password": password.flatMap { builder.handle($0) } ?? NSNull()]
    }
    return await outcome(answer, cli, attempt: attempt, handler: "unlock")
  }

  func normalizedServer(_ text: String) -> [String: Any]? {
    if let preset = contribution.signIn.servers.first(where: { $0.id == text }) { return preset.isCustom ? nil : ["preset": preset.id] }
    var url = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !url.contains("://") { url = "https://" + url }
    let local = contribution.cli.verbs.values.contains { verb in verb.slots.values.contains { $0.type == .url(allowLocalHttp: true) } }
    guard CredentialVerbLaunch.isAllowedURL(url, allowLocalHttp: local) else { return nil }
    return ["url": url]
  }

  func run(_ cli: VaultCLI, _ attempt: SignInAttempt) async -> VaultSignInResult {
    var server: [String: Any]?
    if let given = attempt.server {
      guard let checked = normalizedServer(given) else {
        var result = failed(wording.sentence("badServer"), state: .signedOut)
        result.field = "server"
        return result
      }
      server = checked
    }
    var resolved: [String: String] = [:]
    for (field, token) in attempt.secrets {
      guard let value = VaultSecretEntries.value(token) else { return typedPasswordExpired(nil) }
      resolved[field] = value
    }
    let plainValues = attempt.values.filter { contribution.signIn.field($0.key)?.type != .secret }
    let input = CredentialRequestId(json: [
      "method": attempt.method, "step": attempt.step, "values": plainValues, "server": server ?? NSNull(), "code": attempt.code ?? NSNull(),
      "codeMethod": attempt.codeMethod ?? NSNull(), "account": attempt.account ?? NSNull(),
    ] as [String: Any])
    let secrets = resolved
    let answer = await call("signIn", cli) { builder in
      let base = input.json as? [String: Any] ?? [:]
      var fields: [String: Any] = base["values"] as? [String: String] ?? [:]
      for (field, value) in secrets.sorted(by: { $0.key < $1.key }) { fields[field] = builder.handle(value) ?? NSNull() }
      var request: [String: Any] = ["method": base["method"] ?? "", "step": base["step"] ?? "start", "fields": fields]
      for key in ["server", "code", "codeMethod", "account"] where !(base[key] is NSNull) { request[key] = base[key] }
      return request
    }
    return await outcome(answer, cli, attempt: attempt, handler: "signIn")
  }

  func continueAttempt(_ cli: VaultCLI, _ answer: VaultSignInAnswer) async -> VaultSignInResult {
    guard var current = stateLock.withLock({ attempt }) else { return failed("Start signing in to \(name) again.", state: .signedOut) }
    switch answer.need {
    case "code":
      if let method = answer.methodId {
        current.codeMethod = method
        current.code = nil
      }
      if let code = answer.value { current.code = code.replacingOccurrences(of: " ", with: "") }
      current.step = "code"
    case "account":
      guard let account = answer.accountId else { return failed(wording.prompt(.account([])), state: .signedOut) }
      current.account = account
      current.step = "account"
    default:
      guard let field = current.pendingField ?? (answer.need == "password" ? contribution.signIn.unlockField : nil) else {
        return failed("Start signing in to \(name) again.", state: .signedOut)
      }
      if let token = answer.entryToken {
        current.secrets[field] = token
      } else if let value = answer.value {
        if contribution.signIn.field(field)?.type == .secret { return failed(wording.prompt(.field(field)), state: .signedOut) }
        current.values[field] = value
      }
      current.pendingField = nil
      current.step = "start"
    }
    stateLock.withLock {
      attempt = current
      pendingNeeds = nil
    }
    if current.kind == .unlock {
      guard let field = contribution.signIn.unlockField, let token = current.secrets[field] else { return await unlockCall(cli, password: nil, attempt: current) }
      guard let password = VaultSecretEntries.value(token) else { return typedPasswordExpired(nil) }
      return await unlockCall(cli, password: password, attempt: current)
    }
    return await run(cli, current)
  }

  func isDeclaredApproval(_ text: String) -> Bool {
    guard let components = URLComponents(string: text), components.scheme == "https", components.user == nil, components.password == nil,
      let host = components.host?.lowercased(), !host.isEmpty, text.utf8.count <= CredentialLimits.urlLength
    else { return false }
    return contribution.signIn.approvalHosts.contains { host == $0 || host.hasSuffix("." + $0) }
  }

  func outcome(_ answer: CredentialCallAnswer, _ cli: VaultCLI, attempt current: SignInAttempt, handler: String) async -> VaultSignInResult {
    let decoded: CredentialSignInOutcome
    switch answer {
    case .host(let outcome):
      if outcome == .cancelled { return stopped(state: current.kind == .unlock ? .locked : .signedOut) }
      if outcome == .stale { return stopped(state: .locked) }
      guard case .failed(let message) = hostError(outcome) else { return failed(wording.notRunning) }
      return failed(message, state: current.kind == .unlock ? .locked : .signedOut)
    case .error(let wire):
      let state: VaultState = wire.code == "signedOut" ? .signedOut : .locked
      return failed(wording.sentence(wire.problem ?? "failed", field: wire.field, detail: wire.detail, handler: handler), state: state)
    case .result(let raw, let session):
      guard let parsed = try? CredentialResults.signIn(raw) else { return failed(wording.unreadableResult) }
      decoded = parsed
      if case .done = parsed {
        if let session {
          host.remember(id, session: session, persistent: false, ticket: cli.ticket)
        } else if host.session(id) == nil {
          host.remember(id, session: host.marker(id), persistent: false, ticket: cli.ticket)
        }
      }
    }
    switch decoded {
    case .done:
      stateLock.withLock {
        attempt = nil
        pendingNeeds = nil
      }
      return signedIn()
    case .failed(let problem, let detail, let state, let field):
      let message = wording.sentence(problem, field: field, detail: detail, handler: handler)
      var result = failed(message, state: VaultState(rawValue: (state ?? (current.kind == .unlock ? .locked : .signedOut)).rawValue) ?? .locked)
      result.field = field
      return result
    case .needs(let need, let problem, let detail, let state):
      let vaultState = VaultState(rawValue: (state ?? .locked).rawValue) ?? .locked
      let message = problem.map { wording.sentence($0, field: nil, detail: detail, handler: handler) } ?? wording.prompt(need)
      var next = current
      var shown: VaultProviderNeeds
      var result: VaultSignInResult
      switch need {
      case .approval(let url):
        guard isDeclaredApproval(url) else { return failed(wording.undeclaredApproval, state: vaultState) }
        openApproval(id, url)
        shown = VaultProviderNeeds(kind: .approval, approvalOpened: true, message: message)
        result = needs(.approval, message, approvalURL: url, state: vaultState)
      case .code(let methods, let method):
        let choices = methods?.map { VaultChoice(id: $0.id, title: $0.title, sendsCode: $0.sendsCode ? true : nil) }
        if let method { next.codeMethod = method.id }
        shown = VaultProviderNeeds(kind: .code, methods: choices, message: message)
        result = needs(.code, message, methods: methods?.map { VaultMethod(id: $0.id, name: $0.title, sendsCode: $0.sendsCode ? true : nil) }, state: vaultState)
      case .field(let field):
        next.pendingField = field
        let kind: VaultSignInNeed = switch contribution.signIn.field(field)?.type {
        case .secret?: .password
        case .email?: .email
        default: .field
        }
        shown = VaultProviderNeeds(kind: kind, field: field, message: message)
        result = needs(kind, message, state: vaultState)
        result.field = field
      case .account(let choices):
        let listed = choices.map { VaultChoice(id: $0.id, title: $0.title) }
        shown = VaultProviderNeeds(kind: .account, accounts: listed, message: message)
        result = needs(.account, message, state: vaultState)
        result.accounts = listed
      }
      stateLock.withLock {
        attempt = next
        pendingNeeds = shown
      }
      result.state = makeState(vaultState)
      return result
    }
  }
}
