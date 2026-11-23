import Foundation
import os

public protocol CredentialPluginLink: AnyObject, Sendable {
  func send(_ line: String)
  func sendPaced(_ lines: [String], then: @escaping @Sendable (Bool) -> Void)
  func forward(_ line: String)
  func stopRun()
}

enum CredentialHostOutcome: String, Sendable {
  case cancelled
  case timedOut
  case stopped
  case invalid
  case tooLarge
  case overloaded
  case stale
}

enum CredentialCallAnswer: @unchecked Sendable {
  case result(Any, session: String?)
  case error(CredentialWireError)
  case host(CredentialHostOutcome)
}

struct CredentialRequestId: @unchecked Sendable {
  let json: Any
}

struct CredentialCallBuilder {
  fileprivate var mint: (String, CredentialHandles.Kind) -> String?

  mutating func handle(_ value: String, kind: CredentialHandles.Kind = .typed) -> [String: Any]? {
    mint(value, kind).map { [CredentialVerbLaunch.handleKey: $0] }
  }
}

public final class CredentialRunEndpoint: @unchecked Sendable {
  static let refusedMethodMessage = "A password manager plugin can only use hello, ready, result and credentials requests."
  private static let callCounter = OSAllocatedUnfairLock(initialState: 0)

  public let plugin: String
  public let run: Int
  public let approved: String
  public let attachment: Int
  let contribution: CredentialContribution
  let wording: CredentialWording
  let host: any CredentialHost
  private let link: any CredentialPluginLink
  private let queue: DispatchQueue
  private let appVersion: String

  private struct OpenCall {
    let id: String
    let handler: String
    let ticket: VaultLockEpoch.Ticket
    let epoch: String
    var continuation: CheckedContinuation<CredentialCallAnswer, Never>?
    var deadline: DispatchWorkItem?
    var verbs: Set<Int> = []
    var owner = false
  }

  private struct RunningVerb {
    let requestId: Int
    let call: String
    let verb: CredentialVerb
    let launch: CredentialVerbLaunch
    let command: VaultCommand
    let ticket: VaultLockEpoch.Ticket
    var lines: [String] = []
    var droppedLines = 0
    var windowStart = Date()
    var windowCount = 0
  }

  private var calls: [String: OpenCall] = [:]
  private var verbs: [Int: RunningVerb] = [:]
  private var handles = CredentialHandles()
  private var remembered: [String] = []
  private var greeted = false
  private var readyHandlers: [String]?
  private(set) var refusal: String?
  private var finished = false
  private var readyWaiters: [CheckedContinuation<Bool, Never>] = []
  private(set) var droppedLines = 0
  var onReady: (@Sendable (CredentialRunEndpoint) -> Void)?
  var onEnded: (@Sendable (CredentialRunEndpoint, Bool) -> Void)?

  init(plugin: String, run: Int, approved: String, attachment: Int, contribution: CredentialContribution, host: any CredentialHost, link: any CredentialPluginLink,
       appVersion: String) {
    self.plugin = plugin
    self.run = run
    self.approved = approved
    self.attachment = attachment
    self.contribution = contribution
    self.wording = CredentialWording(title: contribution.title, program: contribution.cli.name, signIn: contribution.signIn)
    self.host = host
    self.link = link
    self.appVersion = appVersion
    queue = DispatchQueue(label: "dev.ardia.credentials.\(plugin).\(run)")
  }

  var isReady: Bool { queue.sync { readyHandlers != nil && refusal == nil && !finished } }
  var isFinished: Bool { queue.sync { finished } }
  var problem: String? { queue.sync { refusal } }
  var handlers: [String] { queue.sync { readyHandlers ?? [] } }
  var openCalls: Int { queue.sync { calls.count } }
  var runningVerbs: Int { queue.sync { verbs.count } }

  func waitUntilReady(timeout: TimeInterval) async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      queue.async { [self] in
        if finished || refusal != nil { return continuation.resume(returning: false) }
        if readyHandlers != nil { return continuation.resume(returning: true) }
        readyWaiters.append(continuation)
        queue.asyncAfter(deadline: .now() + timeout) { [self] in
          guard !readyWaiters.isEmpty else { return }
          let waiting = readyWaiters
          readyWaiters = []
          waiting.forEach { $0.resume(returning: readyHandlers != nil && refusal == nil && !finished) }
        }
      }
    }
  }

  private func settleReadyWaiters() {
    let waiting = readyWaiters
    readyWaiters = []
    let ready = readyHandlers != nil && refusal == nil && !finished
    waiting.forEach { $0.resume(returning: ready) }
  }

  public func redact(_ text: String) -> String {
    let secrets = queue.sync { handles.allValues + remembered }
    return CredentialVerbOutput.redact(text, CredentialVerbOutput.redactor(secrets))
  }

  public func receive(_ line: String) {
    let size = line.utf8.count
    queue.async { [self] in take(line, size: size) }
  }

  public func ended(crashed: Bool) {
    queue.async { [self] in finish(stopped: true, crashed: crashed) }
  }

  func lockNow() {
    queue.sync { finish(stopped: false, crashed: false) }
    link.stopRun()
  }

  private func finish(stopped: Bool, crashed: Bool) {
    guard !finished else { return }
    finished = true
    for id in Array(calls.keys) { answer(id, .host(stopped ? .stopped : .stale)) }
    for verb in verbs.values { verb.command.cancel() }
    verbs.removeAll()
    handles.endAll()
    settleReadyWaiters()
    onEnded?(self, crashed)
  }

  private static func object(_ line: String) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
  }

  private func reply(_ id: CredentialRequestId, result: Any) {
    send(["id": id.json, "result": result])
  }

  private func reply(_ id: CredentialRequestId, refusal: CredentialRefusal) {
    send(["id": id.json, "error": refusal.wire])
  }

  private func send(_ message: [String: Any]) {
    guard let data = CredentialVerbOutput.encoded(message) else { return }
    link.send(String(decoding: data, as: UTF8.self))
  }

  private func take(_ line: String, size: Int) {
    guard let message = Self.object(line) else {
      droppedLines += 1
      return
    }
    let method = message["method"] as? String
    let rawId = message["id"]
    let validId = (rawId as? NSNumber).map { CFGetTypeID($0) != CFBooleanGetTypeID() } == true || rawId is String
    if method == "ready" {
      return ready(message, id: validId ? rawId : nil)
    }
    guard !finished else {
      if validId, let rawId { reply(CredentialRequestId(json: rawId), refusal: CredentialRefusal(.closed, "This run of \(contribution.title) has ended.")) }
      return
    }
    guard let method, validId, let raw = rawId else {
      droppedLines += 1
      return
    }
    let id = CredentialRequestId(json: raw)
    let params = message["params"] as? [String: Any] ?? [:]
    switch method {
    case "hello": hello(id: id, params: params)
    case "result": result(id: id, params: params, size: size)
    case "credentials.verb": verb(id: id, params: params)
    case "credentials.verb.cancel": verbCancel(id: id, params: params)
    case "credentials.signIn.cancel": signInCancel(id: id, params: params)
    case "credentials.session.takeStored": takeStored(id: id, params: params)
    case "credentials.session.dropStored": dropStored(id: id, params: params)
    case "credentials.values.set": setValue(id: id, params: params)
    case "credentials.owner.confirm": confirmOwner(id: id, params: params)
    default: reply(id, refusal: CredentialRefusal(.refused, Self.refusedMethodMessage))
    }
  }

  private func hello(id: CredentialRequestId, params: [String: Any]) {
    let spoken = (params["credentials"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() ? 0 : $0.intValue } ?? 0
    guard CredentialLimits.supportedProtocols.contains(spoken) else {
      refusal = wording.protocolSkew(spoken)
      reply(id, refusal: CredentialRefusal(.refused, refusal!))
      settleReadyWaiters()
      return
    }
    greeted = true
    reply(id, result: [
      "app": "Ardia", "version": appVersion, "protocol": CredentialLimits.pluginProtocol, "plugin": plugin, "values": [String: Any](),
      "credentials": ["protocol": CredentialLimits.protocolVersion, "supported": CredentialLimits.supportedProtocols, "provider": plugin] as [String: Any],
    ])
  }

  static func handlerProblem(_ handlers: [String], contribution: CredentialContribution, wording: CredentialWording) -> String? {
    if let missing = CredentialLimits.requiredHandlers.first(where: { !handlers.contains($0) }) { return wording.missingHandler(missing) }
    for capability in contribution.capabilities {
      guard let options = CredentialLimits.capabilityHandlers[capability] else { continue }
      if !options.contains(where: { option in option.allSatisfy(handlers.contains) }) { return wording.unhandledCapability(capability) }
    }
    return nil
  }

  private func ready(_ message: [String: Any], id: Any?) {
    guard !finished, let id else { return }
    let params = message["params"] as? [String: Any] ?? [:]
    let declared = ((params["credentialProvider"] as? [String: Any])?["handlers"] as? [Any])?.compactMap { $0 as? String } ?? []
    let known = declared.filter { CredentialLimits.handlers.contains($0) }
    if !greeted, refusal == nil { refusal = wording.protocolSkew(0) }
    if refusal == nil { refusal = Self.handlerProblem(known, contribution: contribution, wording: wording) }
    readyHandlers = known
    let forwarded: [String: Any] = [
      "id": id, "method": "ready", "params": ["commands": [Any](), "tools": [Any](), "views": [Any](), "omnibox": false, "decide": [Any](), "events": [Any]()],
    ]
    if let data = CredentialVerbOutput.encoded(forwarded) { link.forward(String(decoding: data, as: UTF8.self)) }
    settleReadyWaiters()
    if refusal == nil { onReady?(self) }
  }

  private func epochText(_ ticket: VaultLockEpoch.Ticket) -> String { "e\(ticket.everyone)\(String(format: "%06d", ticket.own % 1_000_000))" }

  func call(_ handler: String, ticket: VaultLockEpoch.Ticket, input build: @escaping @Sendable (inout CredentialCallBuilder) -> [String: Any]) async
    -> CredentialCallAnswer
  {
    let callId = Self.callCounter.withLock { count -> String in
      count += 1
      return "v\(count)"
    }
    let cancelled = OSAllocatedUnfairLock(initialState: false)
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<CredentialCallAnswer, Never>) in
        queue.async { [self] in
          guard !finished, refusal == nil, readyHandlers != nil else { return continuation.resume(returning: .host(.stopped)) }
          guard host.isCurrent(ticket) else { return continuation.resume(returning: .host(.stale)) }
          guard calls.count < CredentialLimits.waitingCalls else { return continuation.resume(returning: .host(.overloaded)) }
          if cancelled.withLock({ $0 }) { return continuation.resume(returning: .host(.cancelled)) }
          let epoch = epochText(ticket)
          var builder = CredentialCallBuilder { [self] value, kind in handles.mint(value, kind: kind, call: callId, epoch: epoch) }
          let input = build(&builder)
          let deadlineSeconds = CredentialLimits.deadline(handler)
          var open = OpenCall(id: callId, handler: handler, ticket: ticket, epoch: epoch, continuation: continuation)
          let expiry = DispatchWorkItem { [self] in expire(callId) }
          open.deadline = expiry
          calls[callId] = open
          queue.asyncAfter(deadline: .now() + deadlineSeconds, execute: expiry)
          send([
            "call": callId, "kind": CredentialLimits.callKind, "name": handler, "input": input, "deadline": Int(deadlineSeconds * 1000),
            "context": context(callId: callId, epoch: epoch),
          ])
        }
      }
    } onCancel: {
      cancelled.withLock { $0 = true }
      queue.async { [self] in
        guard calls[callId] != nil else { return }
        send(["call": callId, "cancel": true])
        answer(callId, .host(.cancelled))
      }
    }
  }

  private func context(callId: String, epoch: String) -> [String: Any] {
    var session: Any = NSNull()
    if let current = host.session(plugin) {
      if current.hasPrefix(CredentialMarker.prefix) {
        session = ["key": NSNull()]
      } else if let handle = handles.mint(current, kind: .session, call: callId, epoch: epoch) {
        session = ["key": [CredentialVerbLaunch.handleKey: handle]]
      }
    }
    var cli: [String: Any] = ["name": contribution.cli.name, "version": NSNull()]
    if let version = CredentialVersions.shared.known(contribution.cli.name) { cli["version"] = version }
    return [
      "epoch": epoch, "provider": plugin, "touchID": host.touchID, "offline": host.offline, "session": session, "hasStored": host.hasStoredSession(plugin),
      "signInRun": host.signInRun(plugin).wire, "scratch": host.scratch(plugin), "preferences": host.preferences(plugin), "cli": cli,
    ]
  }

  private func expire(_ callId: String) {
    guard calls[callId] != nil else { return }
    send(["call": callId, "cancel": true])
    answer(callId, .host(.timedOut))
  }

  private func answer(_ callId: String, _ outcome: CredentialCallAnswer) {
    guard var open = calls.removeValue(forKey: callId) else { return }
    open.deadline?.cancel()
    for requestId in open.verbs {
      guard let running = verbs[requestId], !running.verb.outlivesCall else { continue }
      running.command.cancel()
    }
    remembered = Array((remembered + handles.values(in: callId)).suffix(64))
    handles.endCall(callId)
    open.continuation?.resume(returning: outcome)
    open.continuation = nil
  }

  private func openCall(_ params: [String: Any], id: CredentialRequestId) -> OpenCall? {
    guard let callId = params["call"] as? String, let open = calls[callId] else {
      reply(id, refusal: CredentialRefusal(.closed, "The call \(params["call"] as? String ?? "(none)") has ended."))
      return nil
    }
    guard host.isCurrent(open.ticket) else {
      reply(id, refusal: CredentialRefusal(.stale, "\(contribution.title) locked, so this call ended."))
      return nil
    }
    return open
  }

  private func result(id: CredentialRequestId, params: [String: Any], size: Int) {
    guard let callId = params["call"] as? String, let open = calls[callId] else {
      reply(id, refusal: CredentialRefusal(.badRequest, "There's no call \(params["call"] as? String ?? "(none)") waiting."))
      return
    }
    reply(id, result: ["ok": true])
    if size > CredentialLimits.resultBytes { return answer(callId, .host(.tooLarge)) }
    if let error = params["error"], !(error is NSNull) {
      guard let wire = try? CredentialResults.wireError(error) else { return answer(callId, .host(.invalid)) }
      return answer(callId, .error(wire))
    }
    let value = params["result"] ?? NSNull()
    var scanned = value
    var session: String?
    if open.handler == "signIn" || open.handler == "unlock", var table = value as? [String: Any], let raw = table["session"], !(raw is NSNull) {
      guard let handle = CredentialVerbLaunch.handleId(raw), let held = handles.live(handle, call: callId, epoch: open.epoch), held.kind != .typed else {
        return answer(callId, .host(.invalid))
      }
      session = held.value
      table["session"] = nil
      scanned = table
    }
    if CredentialVerbLaunch.containsHandle(scanned) { return answer(callId, .host(.invalid)) }
    answer(callId, .result(value, session: session))
  }

  private func verbCancel(id: CredentialRequestId, params: [String: Any]) {
    guard let open = openCall(params, id: id) else { return }
    if let requestId = (params["verbOf"] as? NSNumber)?.intValue, open.verbs.contains(requestId) { verbs[requestId]?.command.cancel() }
    reply(id, result: ["ok": true])
  }

  private func signInCancel(id: CredentialRequestId, params: [String: Any]) {
    guard openCall(params, id: id) != nil else { return }
    host.cancelSigningIn(plugin)
    reply(id, result: ["ok": true])
  }

  private func reason(_ params: [String: Any], id: CredentialRequestId) -> String? {
    guard let text = params["reason"] as? String, (1...CredentialLimits.ownerReasonLength).contains(text.count), !CredentialCatalogParser.hasControlOrDirection(text) else {
      reply(id, refusal: CredentialRefusal(.badRequest, "reason must be text of 1 to \(CredentialLimits.ownerReasonLength) characters."))
      return nil
    }
    return text
  }

  private func takeStored(id: CredentialRequestId, params: [String: Any]) {
    guard let open = openCall(params, id: id), let reason = reason(params, id: id) else { return }
    let provider = plugin
    let host = self.host
    let callId = open.id
    let epoch = open.epoch
    Task {
      let value = await host.storedSession(provider, reason: reason)
      queue.async { [self] in
        guard let current = calls[callId], host.isCurrent(current.ticket) else {
          return reply(id, refusal: CredentialRefusal(.closed, "The call \(callId) has ended."))
        }
        guard let value, let handle = handles.mint(value, kind: .stored, call: callId, epoch: epoch) else {
          return reply(id, result: ["handle": NSNull()])
        }
        reply(id, result: ["handle": [CredentialVerbLaunch.handleKey: handle]])
      }
    }
  }

  private func dropStored(id: CredentialRequestId, params: [String: Any]) {
    guard openCall(params, id: id) != nil else { return }
    host.dropStoredSession(plugin)
    reply(id, result: ["ok": true])
  }

  private func setValue(id: CredentialRequestId, params: [String: Any]) {
    guard openCall(params, id: id) != nil else { return }
    guard let store = params["store"] as? String, store == "scratch" || store == "preferences" else {
      return reply(id, refusal: CredentialRefusal(.badRequest, "store must be scratch or preferences."))
    }
    guard let key = params["key"] as? String, key.range(of: CredentialCatalogParser.keyPattern, options: .regularExpression) != nil else {
      return reply(id, refusal: CredentialRefusal(.badRequest, "key must be 1 to 40 letters, digits, - and _."))
    }
    let raw = params["value"]
    let value = raw as? String
    if !(raw is NSNull), raw != nil, value == nil { return reply(id, refusal: CredentialRefusal(.badRequest, "value must be text or null.")) }
    if let value, value.utf8.count > CredentialLimits.valueBytes { return reply(id, refusal: CredentialRefusal(.badRequest, "value is longer than 1024 bytes.")) }
    let current = store == "scratch" ? host.scratch(plugin) : host.preferences(plugin)
    if value != nil, current[key] == nil, current.count >= CredentialLimits.valueKeys {
      return reply(id, refusal: CredentialRefusal(.badRequest, "\(store) holds at most \(CredentialLimits.valueKeys) keys."))
    }
    if store == "scratch" { host.setScratch(plugin, key, value) } else { host.setPreference(plugin, key, value) }
    reply(id, result: ["ok": true])
  }

  private func confirmOwner(id: CredentialRequestId, params: [String: Any]) {
    guard let open = openCall(params, id: id), let reason = reason(params, id: id) else { return }
    guard !calls.values.contains(where: \.owner) else {
      return reply(id, refusal: CredentialRefusal(.overloaded, "\(contribution.title) is already asking you to confirm."))
    }
    calls[open.id]?.owner = true
    let provider = plugin
    let host = self.host
    let callId = open.id
    Task {
      let confirmed = await host.confirmOwner(provider, reason: reason)
      queue.async { [self] in
        calls[callId]?.owner = false
        reply(id, result: ["confirmed": confirmed])
      }
    }
  }

  private func verb(id: CredentialRequestId, params: [String: Any]) {
    guard let requestId = (id.json as? NSNumber)?.intValue else { return reply(id, refusal: CredentialRefusal(.badRequest, "A verb request needs a number id.")) }
    guard let open = openCall(params, id: id) else { return }
    guard let verbId = params["verb"] as? String else { return reply(id, refusal: CredentialRefusal(.badRequest, "A verb request names its verb.")) }
    let given = params["params"] as? [String: Any] ?? [:]
    if params["params"] != nil, !(params["params"] is [String: Any]) { return reply(id, refusal: CredentialRefusal(.badRequest, "params must be an object.")) }
    let timeout = (params["timeoutMs"] as? NSNumber).flatMap { $0.doubleValue.isFinite ? Int($0.doubleValue) : nil }
    let built = CredentialVerbLaunch.build(
      cli: contribution.cli, verbId: verbId, params: given, requestedTimeoutMs: timeout, testFolderBase: host.testFolderBase(plugin),
      secret: { [self] handle in handles.value(handle, call: open.id, epoch: open.epoch) })
    let launch: CredentialVerbLaunch
    switch built {
    case .failure(let refusal): return reply(id, refusal: refusal)
    case .success(let made): launch = made
    }
    guard verbs.count < CredentialLimits.runningVerbs else {
      return reply(id, refusal: CredentialRefusal(.overloaded, "\(contribution.title) has \(CredentialLimits.runningVerbs) commands running."))
    }
    guard let verb = contribution.cli.verb(verbId) else { return }
    guard let program = host.program(contribution.cli.name) else {
      return reply(id, result: notLaunched(verb))
    }
    for folder in launch.testFolders {
      try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    var environment = host.environment(for: program)
    for (name, value) in launch.env { environment[name] = value }
    let secrets = launch.secretValues
    let streams = verb.output == .stream
    var lineSink: (@Sendable (Bool, String) -> Void)?
    if streams {
      lineSink = { [weak self] fromErrors, text in self?.streamed(requestId, fromErrors: fromErrors, text: text, secrets: secrets) }
    }
    let command = VaultCommand(
      executable: program.executable, arguments: program.leadingArguments + launch.argv, environment: environment, input: launch.stdin,
      timeout: TimeInterval(launch.timeoutMs) / 1000, outputLimit: launch.outputLimitBytes, lineLimit: CredentialLimits.streamLineBytes, onLine: lineSink)
    handles.launched(launch.handles)
    verbs[requestId] = RunningVerb(requestId: requestId, call: open.id, verb: verb, launch: launch, command: command, ticket: open.ticket)
    calls[open.id]?.verbs.insert(requestId)
    if verb.signIn { host.startSigningIn(plugin, command)?.cancel() }
    if verb.outlivesCall { host.setSignInRun(plugin, CredentialSignInRun(state: .running)) }
    command.start { [weak self] result in self?.queue.async { self?.verbExited(requestId, id: id, result: result) } }
  }

  private func notLaunched(_ verb: CredentialVerb) -> [String: Any] {
    [
      "verb": verb.id, "status": -1, "launched": false, "timedOut": false, "cancelled": false, "overflowed": false, "succeeded": false, "stderr": "",
      "hints": [String](), "json": NSNull(), "parts": 0, "lines": [String](), "items": 0, "unlocked": false, "droppedLines": 0,
      "signInRun": host.signInRun(plugin).wire,
    ]
  }

  private func streamed(_ requestId: Int, fromErrors: Bool, text: String, secrets: [String]) {
    queue.async { [self] in
      guard var running = verbs[requestId], calls[running.call] != nil else { return }
      let now = Date()
      if now.timeIntervalSince(running.windowStart) >= 1 {
        running.windowStart = now
        running.windowCount = 0
      }
      running.windowCount += 1
      if running.windowCount > CredentialLimits.streamLinesPerSecond {
        running.droppedLines += 1
        verbs[requestId] = running
        return
      }
      verbs[requestId] = running
      link.send(CredentialVerbOutput.streamLine(text, stream: fromErrors ? "stderr" : "stdout", verbOf: requestId, secrets: secrets))
    }
  }

  private func verbExited(_ requestId: Int, id: CredentialRequestId, result: VaultCommandResult) {
    guard let running = verbs.removeValue(forKey: requestId) else { return }
    host.finishedSigningIn(plugin, running.command)
    handles.exited(running.launch.handles, succeeded: result.succeeded)
    let open = calls[running.call]
    var report = CredentialVerbOutput.report(result, verb: running.verb, launch: running.launch, verbOf: requestId, streamed: running.droppedLines)
    let ticket = running.ticket
    var unlocked = false
    if report.succeeded, running.verb.unlocks != .no, open != nil || running.verb.outlivesCall {
      if running.verb.output == .lastLineSecret {
        if let key = report.capturedKey {
          unlocked = host.remember(plugin, session: key, persistent: running.verb.unlocks == .persistent, ticket: ticket)
          remembered = Array((remembered + [key]).suffix(64))
        }
      } else {
        unlocked = host.remember(plugin, session: host.marker(plugin), persistent: false, ticket: ticket)
      }
    }
    report.capturedKey = nil
    if running.verb.outlivesCall {
      let hints = CredentialVerbOutput.hints(result.stderr, of: running.verb)
      let detail = report.succeeded ? nil : CredentialWording.cleanedDetail(result.stderr, secrets: running.launch.secretValues)
      host.setSignInRun(plugin, CredentialSignInRun(state: report.succeeded ? .succeeded : .failed, hints: hints, detail: detail, timedOut: result.timedOut))
      if open == nil { host.announceChange(plugin) }
    }
    guard let open else { return }
    calls[open.id]?.verbs.remove(requestId)
    report.reply["unlocked"] = unlocked
    report.reply["signInRun"] = host.signInRun(plugin).wire
    guard let data = CredentialVerbOutput.encoded(["id": id.json, "result": report.reply]) else { return }
    let lines = report.notifications + [String(decoding: data, as: UTF8.self)]
    if lines.count == 1 {
      link.send(lines[0])
    } else {
      link.sendPaced(lines) { _ in }
    }
  }
}

final class CredentialVersions: @unchecked Sendable {
  static let shared = CredentialVersions()

  private let lock = NSLock()
  private var versions: [String: String] = [:]

  func known(_ program: String) -> String? { lock.withLock { versions[program] } }

  func note(_ program: String, _ version: String?) { lock.withLock { versions[program] = version } }
}
