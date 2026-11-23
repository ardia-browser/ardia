import CryptoKit
import Foundation
import os

final class PluginVaultProvider: VaultPasskeyHolder, @unchecked Sendable {
  struct SignInAttempt: Sendable, Equatable {
    enum Kind: Sendable {
      case signIn
      case unlock
    }

    var kind: Kind
    var method: String
    var server: String?
    var values: [String: String] = [:]
    var secrets: [String: String] = [:]
    var step = "start"
    var code: String?
    var codeMethod: String?
    var account: String?
    var pendingField: String?
  }

  let contribution: CredentialContribution
  let host: any CredentialHost
  let wording: CredentialWording
  let stateLock = NSLock()
  private var endpoint: CredentialRunEndpoint?
  private var waiters: [CheckedContinuation<CredentialRunEndpoint?, Never>] = []
  var attempt: SignInAttempt?
  var pendingNeeds: VaultProviderNeeds?
  private var unavailable: VaultProviderUnavailable?
  private var unavailableMessage: String?
  private let wantRun: @Sendable (String) -> Void
  let openApproval: @Sendable (String, String) -> Void

  init(contribution: CredentialContribution, host: any CredentialHost, wantRun: @escaping @Sendable (String) -> Void,
       openApproval: @escaping @Sendable (String, String) -> Void) {
    self.contribution = contribution
    self.host = host
    self.wantRun = wantRun
    self.openApproval = openApproval
    wording = CredentialWording(title: contribution.title, program: contribution.cli.name, signIn: contribution.signIn)
  }

  var id: String { contribution.plugin }
  var name: String { contribution.title }
  var binaryName: String { contribution.cli.name }
  var readsOffline: Bool { contribution.readsOffline }
  var staysAuthorizedAfterUse: TimeInterval? { contribution.approvalLastsSeconds.map(TimeInterval.init) }
  var install: VaultInstall { VaultInstall(command: contribution.cli.install.command, url: contribution.cli.install.url, update: contribution.cli.install.update) }

  var capabilities: VaultCapabilities {
    let offers = contribution.offers
    return VaultCapabilities(
      totp: offers("totp"), save: offers("save"), selfHosted: offers("selfHosted"), masterPassword: offers("masterPassword"), touchID: offers("touchID"),
      addTotp: offers("addTotp"), edit: offers("edit"), desktopApproval: contribution.signIn.methods.first?.kind == .desktopApproval, passkeys: offers("passkeys"))
  }

  var setup: VaultSetup? {
    guard let first = contribution.signIn.methods.first else { return nil }
    switch first.kind {
    case .fields: return VaultSetup(kind: .credentials)
    case .desktopApproval: return VaultSetup(kind: .desktopIntegration, appURL: first.appURL)
    case .browserApproval: return VaultSetup(kind: .browserSignIn)
    }
  }

  var descriptor: VaultSignInDescriptor {
    VaultSignInDescriptor(
      methods: contribution.signIn.methods.map { method in
        VaultSignInDescriptor.Method(
          id: method.id, title: method.title, kind: method.kind == .fields ? "credentials" : method.kind.rawValue,
          fields: method.fields.map { field in
            VaultSignInDescriptor.Field(
              id: field.id, title: field.title, kind: field.type.rawValue, optional: field.optional ? true : nil, placeholder: field.placeholder, hint: field.hint,
              masked: field.type == .secret ? field.masked : nil, prefill: field.prefillsAccount ? "account" : nil)
          }, appURL: method.appURL, appTitle: method.appTitle, twoStep: method.twoStep ? true : nil)
      },
      servers: contribution.signIn.servers.isEmpty ? nil : contribution.signIn.servers.map { server in
        VaultSignInDescriptor.Server(id: server.id, title: server.title, custom: server.isCustom ? true : nil, placeholder: server.customPlaceholder,
                                     fieldTitle: server.customTitle)
      }, unlockField: contribution.signIn.unlockField)
  }

  func described(_ state: VaultProviderState) -> VaultProviderState {
    var described = state
    described.plugin = id
    described.title = contribution.title
    described.symbol = contribution.symbol
    described.accent = contribution.accent
    described.signIn = descriptor
    stateLock.withLock {
      described.needs = pendingNeeds
      if described.state == .unavailable || unavailable != nil {
        described.unavailable = unavailable
        if let unavailableMessage, unavailable != nil {
          described.state = .unavailable
          described.message = unavailableMessage
        }
      }
    }
    return described
  }

  var currentEndpoint: CredentialRunEndpoint? { stateLock.withLock { endpoint } }

  func attach(_ fresh: CredentialRunEndpoint) {
    let waiting = stateLock.withLock { () -> [CheckedContinuation<CredentialRunEndpoint?, Never>] in
      endpoint = fresh
      unavailable = nil
      unavailableMessage = nil
      defer { waiters = [] }
      return waiters
    }
    waiting.forEach { $0.resume(returning: fresh) }
  }

  func detach(_ ended: CredentialRunEndpoint, crashed: Bool) {
    stateLock.withLock {
      guard endpoint === ended else { return }
      endpoint = nil
      if crashed {
        unavailable = VaultProviderUnavailable(reason: .crashed, canRestart: true)
        unavailableMessage = wording.stopped
      }
    }
    if crashed { host.announceChange(id) }
  }

  func markUnavailable(_ reason: VaultProviderUnavailable.Reason, message: String, canRestart: Bool) {
    stateLock.withLock {
      unavailable = VaultProviderUnavailable(reason: reason, canRestart: canRestart)
      unavailableMessage = message
    }
  }

  func clearUnavailable() {
    stateLock.withLock {
      unavailable = nil
      unavailableMessage = nil
    }
  }

  private func readyEndpoint() async -> CredentialRunEndpoint? {
    if let current = currentEndpoint, !current.isFinished {
      if current.isReady { return current }
      if await current.waitUntilReady(timeout: CredentialLimits.runWait) { return current }
      if let problem = current.problem { markUnavailable(.damaged, message: problem, canRestart: false) }
      return nil
    }
    if stateLock.withLock({ unavailable?.reason == .damaged || unavailable?.reason == .off }) { return nil }
    wantRun(id)
    let waited = await withCheckedContinuation { (continuation: CheckedContinuation<CredentialRunEndpoint?, Never>) in
      let resumeNow = stateLock.withLock { () -> CredentialRunEndpoint?? in
        if let current = endpoint, !current.isFinished { return .some(current) }
        waiters.append(continuation)
        return .none
      }
      if case .some(let current) = resumeNow { return continuation.resume(returning: current) }
      DispatchQueue.global().asyncAfter(deadline: .now() + CredentialLimits.runWait) { [self] in
        let expired = stateLock.withLock { () -> [CheckedContinuation<CredentialRunEndpoint?, Never>] in
          defer { waiters = [] }
          return waiters
        }
        expired.forEach { $0.resume(returning: nil) }
      }
    }
    guard let waited else { return nil }
    return await waited.waitUntilReady(timeout: CredentialLimits.runWait) ? waited : nil
  }

  func call(_ handler: String, _ cli: VaultCLI, ticket: VaultLockEpoch.Ticket? = nil,
                    input: @escaping @Sendable (inout CredentialCallBuilder) -> [String: Any]) async -> CredentialCallAnswer {
    guard let endpoint = await readyEndpoint() else { return .host(.stopped) }
    return await endpoint.call(handler, ticket: ticket ?? cli.ticket, input: input)
  }

  func call(_ handler: String, _ cli: VaultCLI, ticket: VaultLockEpoch.Ticket? = nil, _ input: [String: Any]) async -> CredentialCallAnswer {
    let fixed = CredentialRequestId(json: input)
    return await call(handler, cli, ticket: ticket) { _ in fixed.json as? [String: Any] ?? [:] }
  }

  func handles(_ handler: String) async -> Bool {
    guard let endpoint = await readyEndpoint() else { return false }
    return endpoint.handlers.contains(handler)
  }

  func error(_ answer: CredentialCallAnswer, handler: String) -> VaultError {
    switch answer {
    case .result: return .failed(wording.unreadableResult)
    case .error(let wire):
      switch wire.code {
      case "locked": return .locked
      case "signedOut": return .signedOut
      case "notFound": return .notFound
      case "unsupported": return .unsupported
      default: return .failed(wording.sentence(wire.problem ?? "failed", field: wire.field, detail: wire.detail, handler: handler))
      }
    case .host(let outcome): return hostError(outcome)
    }
  }

  func hostError(_ outcome: CredentialHostOutcome) -> VaultError {
    switch outcome {
    case .stale: return .locked
    case .cancelled: return .failed(wording.hostCancelled)
    case .timedOut: return .failed(wording.didntAnswer)
    case .stopped: return .failed(currentEndpoint?.problem ?? stateLock.withLock { unavailableMessage } ?? wording.notRunning)
    case .invalid: return .failed(wording.unreadableResult)
    case .tooLarge: return .failed(wording.tooLarge)
    case .overloaded: return .failed(wording.overloaded)
    }
  }

  func value<T>(_ answer: CredentialCallAnswer, handler: String, _ decode: (Any) throws -> T) throws -> T {
    guard case .result(let raw, _) = answer else { throw error(answer, handler: handler) }
    do { return try decode(raw) } catch { throw VaultError.failed(wording.unreadableResult) }
  }

  func state(_ cli: VaultCLI) async -> VaultProviderState {
    let version = await versionOf(cli)
    if let minimum = contribution.cli.minimumVersion, let version, Self.isOlder(version, than: minimum) {
      var outdated = makeState(.unavailable, message: wording.update(to: minimum))
      outdated.problem = VaultProviderProblem(code: "cliTooOld", message: wording.update(to: minimum))
      return outdated
    }
    let answer = await call("state", cli, ["explicit": false])
    if case .host(let outcome) = answer {
      if outcome == .stale { return makeState(.locked) }
      let message: String
      if case .failed(let text) = hostError(outcome) { message = text } else { message = wording.notRunning }
      return makeState(.unavailable, message: message)
    }
    if case .error(let wire) = answer {
      switch wire.code {
      case "locked": return makeState(.locked)
      case "signedOut": return makeState(.signedOut)
      default: return makeState(.unavailable, message: wording.sentence(wire.problem ?? "failed", field: wire.field, detail: wire.detail, handler: "state"))
      }
    }
    guard let reported = try? value(answer, handler: "state", CredentialResults.state) else { return makeState(.unavailable, message: wording.unreadableResult) }
    var server: String?
    if let preset = reported.serverPreset { server = contribution.signIn.servers.first { $0.id == preset }?.title ?? preset }
    if let url = reported.serverURL { server = url }
    var message: String?
    if let problem = reported.problem { message = wording.sentence(problem, detail: reported.detail, handler: "state") } else if reported.state == .unavailable {
      message = reported.detail
    }
    var state = makeState(reported.state, account: reported.account, server: server, message: message)
    if let problem = reported.problem, let message { state.problem = VaultProviderProblem(code: problem, message: message) }
    if reported.state == .unlocked, host.session(id) == nil { state.state = .locked }
    return state
  }

  func versionOf(_ cli: VaultCLI) async -> String? {
    if let known = CredentialVersions.shared.known(contribution.cli.name) { return known }
    guard let program = host.program(contribution.cli.name) else { return nil }
    let command = VaultCommand(executable: program.executable, arguments: program.leadingArguments + ["--version"], environment: host.environment(for: program),
                               input: nil, timeout: VaultCLI.versionTimeout)
    let result = await command.run()
    let found = result.succeeded ? VaultCLI.versionNumber(in: result.trimmedOutput) : nil
    CredentialVersions.shared.note(contribution.cli.name, found)
    return found
  }

  static func isOlder(_ version: String, than minimum: String) -> Bool {
    let have = version.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
    let want = minimum.split(separator: ".").map { Int($0) ?? 0 }
    for index in 0..<max(have.count, want.count) {
      let left = index < have.count ? have[index] : 0
      let right = index < want.count ? want[index] : 0
      if left != right { return left < right }
    }
    return false
  }

  func lock(_ cli: VaultCLI, session: String) async {
    guard let onLock = contribution.cli.onLock, !(onLock.skipWithTouchID && host.touchID), let verb = contribution.cli.verb(onLock.verb),
      let program = host.program(contribution.cli.name)
    else { return }
    var params: [String: Any] = [:]
    let handle = "h1"
    for (slot, source) in onLock.params {
      switch source {
      case .session: if !CredentialMarker.isMarker(session) { params[slot] = [CredentialVerbLaunch.handleKey: handle] }
      case .preference(let key): if let value = host.preferences(id)[key] { params[slot] = value }
      case .literal(let value): params[slot] = value
      }
    }
    guard case .success(let launch) = CredentialVerbLaunch.build(
      cli: contribution.cli, verbId: verb.id, params: params, requestedTimeoutMs: Int(CredentialLimits.onLockDeadline * 1000),
      testFolderBase: host.testFolderBase(id), secret: { $0 == handle && !CredentialMarker.isMarker(session) ? session : nil })
    else { return }
    var environment = host.environment(for: program)
    for (name, value) in launch.env { environment[name] = value }
    let command = VaultCommand(executable: program.executable, arguments: program.leadingArguments + launch.argv, environment: environment, input: launch.stdin,
                               timeout: min(CredentialLimits.onLockDeadline, TimeInterval(launch.timeoutMs) / 1000), outputLimit: launch.outputLimitBytes)
    _ = await command.run()
  }

  func locked() {
    let running = stateLock.withLock { () -> CredentialRunEndpoint? in
      defer {
        endpoint = nil
        attempt = nil
        pendingNeeds = nil
      }
      return endpoint
    }
    host.cancelSigningIn(id)
    running?.lockNow()
  }

  func signOut(_ cli: VaultCLI) async {
    _ = await call("signOut", cli, ticket: host.ticket(id), [:])
    stateLock.withLock {
      attempt = nil
      pendingNeeds = nil
    }
  }

  func configure(_ cli: VaultCLI, server: String?) async -> String? {
    guard await handles("configure") else { return wording.noServerSetting }
    var ref: Any = NSNull()
    if let server {
      guard let checked = normalizedServer(server) else { return wording.sentence("badServer") }
      ref = checked
    }
    let answer = await call("configure", cli, ["server": ref])
    if case .result = answer { return nil }
    if case .failed(let message) = error(answer, handler: "configure") { return message }
    return wording.sentence("failed")
  }

  func items(_ cli: VaultCLI) async throws -> VaultItemList {
    let started = Date()
    var list = VaultItemList(items: [])
    var snapshot: String?
    var cursor: String?
    var restarted = false
    var pages = 0
    var seen: Set<String> = []
    while true {
      try Task.checkCancellation()
      guard Date().timeIntervalSince(started) < CredentialLimits.listingDeadline else { throw VaultError.failed(wording.sentence("tooSlow")) }
      let request: [String: Any] = ["snapshot": snapshot ?? NSNull(), "cursor": cursor ?? NSNull()]
      let answer = await call("list", cli, request)
      let page = try value(answer, handler: "list") { try CredentialResults.page($0, provider: id) }
      if let snapshot, page.snapshot != snapshot {
        guard !restarted else { throw VaultError.failed(wording.unreadableResult) }
        restarted = true
        list = VaultItemList(items: [])
        seen = []
        pages = 0
        cursor = nil
        continue
      }
      snapshot = page.snapshot
      pages += 1
      for item in page.list.items where seen.insert(item.id).inserted {
        list.items.append(item)
        if let password = page.list.passwords[item.id] { list.passwords[item.id] = password }
        if let totp = page.list.totps[item.id] { list.totps[item.id] = totp }
      }
      guard pages <= CredentialLimits.listPages, list.items.count <= CredentialLimits.listedItems else { throw VaultError.failed(wording.tooLarge) }
      guard let next = page.cursor else { return list }
      cursor = next
    }
  }

  func reveal(_ cli: VaultCLI, id item: String, fields: [String]) async throws -> CredentialResults.Revealed {
    let answer = await call("reveal", cli, ["id": item, "fields": fields])
    return try value(answer, handler: "reveal", CredentialResults.revealed)
  }

  func secret(_ cli: VaultCLI, id item: String, field: VaultField) async throws -> String {
    let revealed = try await reveal(cli, id: item, fields: [field.rawValue])
    let found: String? = switch field {
    case .username: revealed.username
    case .password: revealed.password
    case .totp: revealed.totpURI ?? revealed.totpCode
    }
    guard let found, !found.isEmpty else { throw VaultError.notFound }
    return found
  }

  func revealed(_ cli: VaultCLI, id item: String) async throws -> VaultRevealed {
    let revealed = try await reveal(cli, id: item, fields: ["password", "totp"])
    return VaultRevealed(password: revealed.password, totp: revealed.totpURI ?? revealed.totpCode)
  }

  private func itemCall(_ handler: String, _ cli: VaultCLI, _ input: [String: Any]) async throws -> VaultItem {
    let answer = await call(handler, cli, input)
    if case .result(let raw, _) = answer, raw is NSNull { throw VaultError.failed(wording.sentence("savedNotReturned", handler: handler)) }
    return try value(answer, handler: handler) { try CredentialResults.item($0, provider: id) }
  }

  func save(_ cli: VaultCLI, login: VaultNewLogin) async throws -> VaultItem {
    guard contribution.offers("save"), await handles("save") else { throw VaultError.unsupported }
    return try await itemCall("save", cli, ["login": ["title": login.title, "username": login.username, "password": login.password, "url": login.url]])
  }

  func addTotp(_ cli: VaultCLI, id item: String, uri: String) async throws -> VaultItem {
    guard contribution.offers("addTotp") else { throw VaultError.unsupported }
    if await handles("addTotp") { return try await itemCall("addTotp", cli, ["id": item, "uri": uri]) }
    guard await handles("edit") else { throw VaultError.unsupported }
    return try await itemCall("edit", cli, ["id": item, "change": ["totp": ["set": uri]]])
  }

  func edit(_ cli: VaultCLI, id item: String, change: VaultLoginChange) async throws -> VaultItem {
    guard contribution.offers("edit"), await handles("edit") else { throw VaultError.unsupported }
    var wire: [String: Any] = [:]
    if let username = change.username { wire["username"] = username }
    if let password = change.password { wire["password"] = password }
    if let url = change.url { wire["url"] = url }
    switch change.totp {
    case .unchanged: break
    case .set(let uri): wire["totp"] = ["set": uri]
    case .remove: wire["totp"] = "remove"
    }
    return try await itemCall("edit", cli, ["id": item, "change": wire])
  }

  func passkeySigner(_ cli: VaultCLI, item: String, credential: Data, rpId: String) async throws -> VaultPasskeySigner? {
    guard contribution.offers("passkeys") else { return nil }
    let wanted = VaultBase64URL.encode(credential)
    let answer = await call("passkeys.get", cli, ["item": item, "credentialId": wanted, "rpId": rpId])
    guard let key = try value(answer, handler: "passkeys.get", CredentialResults.passkeyKey) else { return nil }
    return Self.checkedSigner(key, credentialId: wanted, rpId: rpId)
  }

  static func checkedSigner(_ key: CredentialPasskeyKey, credentialId: String, rpId: String) -> VaultPasskeySigner? {
    guard key.credentialId == credentialId, key.rpId == rpId, key.counter == 0, (1...64).contains(key.userHandle.count),
      let privateKey = try? P256.Signing.PrivateKey(derRepresentation: key.privateKey)
    else { return nil }
    return VaultPasskeySigner(key: privateKey, userHandle: key.userHandle)
  }

  func savePasskey(_ cli: VaultCLI, credential: VaultNewPasskey, attachTo item: String?, title: String, url: String) async throws -> String {
    guard contribution.offers("passkeys") else { throw VaultError.unsupported }
    let credentialId = VaultBase64URL.encode(credential.rawId)
    let wire: [String: Any] = [
      "credentialId": credentialId, "credentialUuid": credential.credentialId.uuidString.lowercased(),
      "privateKey": ["format": "pkcs8", "der": VaultBase64URL.encode(credential.key.derRepresentation)],
      "publicKey": VaultBase64URL.encode(credential.key.publicKey.x963Representation), "rpId": credential.rpId, "rpName": credential.rpName,
      "userHandle": VaultBase64URL.encode(credential.userHandle), "userName": credential.userName, "displayName": credential.displayName,
      "createdAt": Int(credential.createdAt.timeIntervalSince1970 * 1000),
    ]
    let answer = await call("passkeys.save", cli, ["credential": wire, "attachTo": item ?? NSNull(), "title": title, "url": url])
    let saved = try value(answer, handler: "passkeys.save") { raw -> String in
      try CredentialResults.identifier(try CredentialResults.record(raw)["item"], longest: CredentialLimits.itemIdLength)
    }
    let readBack = await call("passkeys.get", cli, ["item": saved, "credentialId": credentialId, "rpId": credential.rpId])
    guard let key = try? value(readBack, handler: "passkeys.get", CredentialResults.passkeyKey),
      let signer = Self.checkedSigner(key, credentialId: credentialId, rpId: credential.rpId),
      signer.key.publicKey.x963Representation == credential.key.publicKey.x963Representation
    else { throw VaultError.failed(wording.keptPasskeyMismatch) }
    return saved
  }
}
