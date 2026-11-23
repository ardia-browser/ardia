import AppKit
import CryptoKit
import Foundation

@MainActor
final class VaultPasskeys {
  static let shared = VaultPasskeys()
  nonisolated static let longestPageId = 64
  static let mostDismissals = 2
  static let dismissalMemory: TimeInterval = 60

  enum Outcome: String {
    case created
    case used
    case fallback
    case refused
    case cancelled
    case timedOut
    case failed
    case handedOff = "extension"
    case handingOff
  }

  struct Intake: Sendable {
    var pageId: String
    var claimed: [String] = []
    var conditional = false
    var outcome: String?
    var request: VaultPasskeyRequest?
    var site: VaultRelyingParty.Site?
  }

  struct Notice: Sendable, Equatable {
    var kind: String
    var provider: String
  }

  final class Pending {
    let id: String
    weak var view: ArdiaWebView?
    let tabId: String
    let frameId: String
    let pageId: String
    let origin: String
    let site: VaultRelyingParty.Site
    let request: VaultPasskeyRequest
    var candidates: [VaultPasskeyCandidate] = []
    var existing: [String] = []
    var busy = false
    var ready = false
    var choosing = false
    var extensions: [String] = []
    var system = false
    var systemFor: String?
    var handlers: [String: VaultPasskeyHandler] = [:]
    var handingOff: (provider: String, extensionId: String)?
    var notice: Notice?
    var timer: DispatchWorkItem?
    let stamp = ArdiaConsentStamp.begin()

    init(id: String, view: ArdiaWebView, tabId: String, frameId: String, pageId: String, origin: String, site: VaultRelyingParty.Site,
         request: VaultPasskeyRequest)
    {
      self.id = id
      self.view = view
      self.tabId = tabId
      self.frameId = frameId
      self.pageId = pageId
      self.origin = origin
      self.site = site
      self.request = request
    }
  }

  private(set) var enabled = false
  private var source = VaultPasskeySource.ask
  private var installed: [VaultPasskeyExtension] = []
  private var scanned: [String: Bool] = [:]

  func configure(source setting: String, extensions: [VaultPasskeyExtension]) {
    source = VaultPasskeySource(setting: setting)
    installed = extensions
    scanned = [:]
    let unknown = extensions.filter { !$0.known }.map(\.id)
    let directory = ArdiaHost.dataDirectory
    Task.detached(priority: .utility) {
      var found: [String: Bool] = [:]
      for id in unknown { found[id] = VaultPasskeyExtensionScan.wrapsWebAuthn(id: id, userDataDirectory: directory) }
      let result = found
      await MainActor.run { self.scanned.merge(result) { $1 } }
    }
  }

  private func claimedExtensions(_ claimed: [String]) -> [String] {
    VaultPasskeyExtension.eligible(claimed, installed: installed) { self.scanned[$0] == true }
  }

  private func extensionMetadata(_ ids: [String]) -> [[String: Any]] {
    ids.compactMap { id in installed.first { $0.id == id }.map { ["id": $0.id, "name": $0.name] } }
  }
  var pending: [String: Pending] = [:]
  private var intake: Task<Void, Never>?
  private var dismissals: [String: (count: Int, at: Date)] = [:]

  static func install() {
    ArdiaWebView.setPasskeyMessageHandler { view, kind, json, frame, main, origin in
      MainActor.assumeIsolated { shared.receive(view: view, kind: kind, json: json, frame: frame, main: main, origin: origin) }
    }
  }

  func providersChanged(anyMenu on: Bool) {
    if enabled != on {
      enabled = on
      ArdiaWebView.setPasskeysInPageScript(on)
    }
    for request in Array(pending.values) where !(on && Self.servesProfile(of: request.view)) {
      finish(request, answer: ["fallback": true], outcome: nil)
    }
  }

  private static func servesProfile(of view: ArdiaWebView?) -> Bool {
    guard let view else { return false }
    return PasswordsModule.fillsFromMenu(view.profile)
  }

  func receive(view: ArdiaWebView, kind: String, json: String, frame: String, main: Bool, origin: String?) {
    let previous = intake
    intake = Task { [weak view] in
      await previous?.value
      guard let view else { return }
      if kind == "@document" { return self.documentChanged(view) }
      guard let parsed = await Self.parse(json, kind: kind, origin: origin) else { return }
      switch kind {
      case "passkeyCancel": self.cancelled(view: view, frame: frame, pageId: parsed.pageId)
      case "passkeyDelegated": self.delegated(view: view, frame: frame, intake: parsed)
      case "passkeyCreate": self.begin(.create, intake: parsed, view: view, frame: frame, main: main, origin: origin)
      case "passkeyGet": self.begin(.get, intake: parsed, view: view, frame: frame, main: main, origin: origin)
      default: break
      }
    }
  }

  @concurrent nonisolated static func parse(_ json: String, kind: String, origin: String?) async -> Intake? {
    guard let message = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any], let pageId = message["id"] as? String, isPageId(pageId)
    else { return nil }
    var intake = Intake(pageId: pageId)
    intake.claimed = (message["extensions"] as? [Any] ?? []).prefix(64).compactMap { $0 as? String }
    intake.conditional = message["mediation"] as? String == "conditional"
    intake.outcome = message["outcome"] as? String
    let ceremony: VaultPasskeyRequest.Kind? = kind == "passkeyCreate" ? .create : kind == "passkeyGet" ? .get : nil
    if let ceremony, let origin {
      intake.request = VaultPasskeyRequest.parse(message, kind: ceremony)
      intake.site = intake.request.flatMap { VaultRelyingParty.check(rpId: $0.rpId, origin: origin) }
    }
    return intake
  }

  nonisolated static func isPageId(_ id: String) -> Bool {
    !id.isEmpty && id.count <= longestPageId && id.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x7A) }
  }

  @discardableResult
  func reply(_ view: ArdiaWebView, frame: String, origin: String?, pageId: String, _ answer: [String: Any]) -> Bool {
    var payload = answer
    payload["id"] = pageId
    guard let json = Self.json(payload) else { return false }
    return view.answerPasskey(frame: frame, origin: answer["credential"] == nil ? nil : origin, json: json)
  }

  private func dismissed(_ tabId: String) -> Int {
    guard let held = dismissals[tabId] else { return 0 }
    guard Date().timeIntervalSince(held.at) < Self.dismissalMemory else {
      dismissals[tabId] = nil
      return 0
    }
    return held.count
  }

  private func noteDismissal(_ tabId: String) {
    dismissals[tabId] = (dismissed(tabId) + 1, Date())
  }

  private func mayShowSheet(_ view: ArdiaWebView) -> Bool {
    view.visible && (view.window?.isKeyWindow == true || LaunchConfig.shared.background)
  }

  private func acknowledge(_ view: ArdiaWebView, frame: String, origin: String?, pageId: String) {
    reply(view, frame: frame, origin: origin, pageId: pageId, ["ack": true])
  }

  private func fallBack(_ view: ArdiaWebView, frame: String, origin: String?, pageId: String, count: Bool) {
    reply(view, frame: frame, origin: origin, pageId: pageId, ["fallback": true])
    if count { emitDone(tabId: view.vaultTabId ?? "", requestId: "", outcome: .fallback) }
  }

  private func begin(_ kind: VaultPasskeyRequest.Kind, intake: Intake, view: ArdiaWebView, frame: String, main: Bool, origin: String?) {
    let pageId = intake.pageId
    let served = enabled && Self.servesProfile(of: view)
    guard let origin, main, served, let tabId = view.vaultTabId, view.passkeyOriginIsCurrent(origin) else {
      return fallBack(view, frame: frame, origin: origin, pageId: pageId, count: served)
    }
    let claimed = claimedExtensions(intake.claimed)
    guard let request = intake.request, !request.unsupported, let site = intake.site else {
      let route = VaultPasskeyRoute.decide(.init(source: source, creating: kind == .create, conditional: intake.conditional,
                                                 extensions: claimed, ardiaCan: false, ardiaHasPasskeys: false))
      return routeWithoutArdia(route, view: view, frame: frame, origin: origin, pageId: pageId, tabId: tabId)
    }
    let modal = !request.conditional
    if modal, !mayShowSheet(view) {
      if source == .chrome {
        reply(view, frame: frame, origin: origin, pageId: pageId, ["chrome": true])
        return emitDone(tabId: tabId, requestId: "", outcome: .fallback, via: "chrome")
      }
      return fallBack(view, frame: frame, origin: origin, pageId: pageId, count: true)
    }
    acknowledge(view, frame: frame, origin: origin, pageId: pageId)
    if modal, pending.values.contains(where: { $0.tabId == tabId && !$0.request.conditional }) || dismissed(tabId) >= Self.mostDismissals {
      reply(view, frame: frame, origin: origin, pageId: pageId, ["error": "NotAllowedError"])
      return
    }
    for other in Array(pending.values) where other.tabId == tabId && other.request.conditional {
      finish(other, answer: ["error": modal ? "NotAllowedError" : "AbortError"], outcome: .cancelled)
    }
    let entry = Pending(id: UUID().uuidString, view: view, tabId: tabId, frameId: frame, pageId: pageId, origin: origin, site: site, request: request)
    entry.extensions = claimed
    pending[entry.id] = entry
    armTimer(entry)
    Task { @MainActor in
      async let found = Self.candidates(rpId: site.rpId)
      async let delegates = VaultBroker.shared.passkeyDelegates()
      let (candidates, delegateList) = await (found, delegates)
      guard self.pending[entry.id] === entry else { return }
      guard self.enabled, Self.servesProfile(of: view), view.passkeyOriginIsCurrent(origin) else { return self.finish(entry, answer: ["fallback": true], outcome: .fallback) }
      let handlers = VaultPasskeyDelegate.handlers(delegateList, systemAvailable: VaultSystemPasskeys.available, contenders: claimed)
      entry.handlers = handlers
      let shown = await VaultPasskeyWork.matching(candidates, request: request, handlers: handlers)
      guard self.pending[entry.id] === entry else { return }
      entry.existing = shown.existing
      entry.candidates = shown.candidates
      let route = VaultPasskeyRoute.decide(.init(source: self.source, creating: kind == .create, conditional: request.conditional, extensions: claimed,
                                                 ardiaCan: true, ardiaHasPasskeys: !entry.candidates.isEmpty,
                                                 systemProviders: handlers.filter { $0.value == .system }.keys.sorted(),
                                                 delegatedExtensions: handlers.values.compactMap { if case .browserExtension(let id) = $0 { id } else { nil } }))
      switch route {
      case .system(let provider):
        entry.ready = true
        _ = await self.answerFromSystem(entry, view: view, provider: provider, direct: true)
      case .ardia:
        self.start(entry)
      case .chrome:
        self.finish(entry, answer: ["chrome": true], outcome: .fallback, via: "chrome")
      case .asIfAbsent:
        self.finish(entry, answer: ["fallback": true], outcome: .fallback)
      case .extensionId(let id):
        self.finish(entry, answer: ["extension": id], outcome: .handedOff, via: id)
      case .choose(let ardia, let extensions):
        entry.choosing = true
        entry.extensions = extensions
        if !ardia { entry.candidates = [] }
        self.start(entry, choose: ardia)
      }
    }
  }

  private func routeWithoutArdia(_ route: VaultPasskeyRoute, view: ArdiaWebView, frame: String, origin: String, pageId: String, tabId: String) {
    switch route {
    case .chrome:
      reply(view, frame: frame, origin: origin, pageId: pageId, ["chrome": true])
      emitDone(tabId: tabId, requestId: "", outcome: .fallback, via: "chrome")
    case .extensionId(let id):
      reply(view, frame: frame, origin: origin, pageId: pageId, ["extension": id])
      emitDone(tabId: tabId, requestId: "", outcome: .handedOff, via: id)
    case .ardia, .asIfAbsent, .choose, .system:
      fallBack(view, frame: frame, origin: origin, pageId: pageId, count: true)
    }
  }

  private func armTimer(_ entry: Pending) {
    guard !entry.request.conditional else { return }
    let timer = DispatchWorkItem { [weak self, id = entry.id] in
      MainActor.assumeIsolated {
        guard let self, let entry = self.pending[id] else { return }
        self.finish(entry, answer: ["error": "NotAllowedError"], outcome: .timedOut)
      }
    }
    entry.timer = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + entry.request.timeout, execute: timer)
  }

  func start(_ entry: Pending, choose ardiaChoice: Bool? = nil) {
    entry.ready = true
    var event: [String: Any] = [
      "tabId": entry.tabId, "requestId": entry.id, "origin": entry.origin, "rpId": entry.site.rpId,
      "kind": entry.request.kind == .create ? "create" : "get", "conditional": entry.request.conditional,
      "passkeys": entry.candidates.map { $0.metadata() }, "system": VaultSystemPasskeys.available,
      "extensions": extensionMetadata(entry.extensions), "choose": entry.choosing, "ardia": ardiaChoice ?? true,
      "private": ArdiaHost.isPrivateProfile(entry.view?.profile ?? ""),
      "delegates": entry.handlers.keys.sorted().map { provider -> [String: Any] in
        ["provider": provider, "via": entry.handlers[provider] == .system ? "system" : "extension"]
      },
    ]
    if let notice = entry.notice { event["notice"] = ["kind": notice.kind, "provider": notice.provider] }
    if entry.request.kind == .create {
      event["userName"] = entry.request.userName
      event["displayName"] = entry.request.displayName
      event["exists"] = !entry.existing.isEmpty
    }
    let stamped = entry.stamp.onto(event)
    if entry.request.conditional { ArdiaEvents.emit("vaults.passkeyOffer", data: stamped) } else { ArdiaEvents.emit("vaults.passkeyRequest", data: stamped) }
  }

  func finish(_ entry: Pending, answer: [String: Any]?, outcome: Outcome?, via: String? = nil) {
    guard pending[entry.id] === entry else { return }
    pending[entry.id] = nil
    entry.timer?.cancel()
    if entry.system { VaultSystemPasskeys.cancelRunning() }
    entry.handingOff = nil
    if let answer, let view = entry.view { reply(view, frame: entry.frameId, origin: entry.origin, pageId: entry.pageId, answer) }
    emitDone(tabId: entry.tabId, requestId: entry.id, outcome: outcome ?? .cancelled, via: via, stamp: entry.stamp)
  }

  func emitDone(tabId: String, requestId: String, outcome: Outcome, via: String? = nil, stamp: ArdiaConsentStamp = .begin()) {
    var data: [String: Any] = ["tabId": tabId, "requestId": requestId, "outcome": outcome.rawValue]
    if outcome != .handingOff {
      if let via { data["via"] = via } else if outcome == .created || outcome == .used { data["via"] = "ardia" }
    }
    ArdiaEvents.emit("vaults.passkeyDone", data: stamp.onto(data))
  }

  private func documentChanged(_ view: ArdiaWebView) {
    guard let tabId = view.vaultTabId else { return }
    for entry in Array(pending.values) where entry.tabId == tabId || entry.view == nil { finish(entry, answer: nil, outcome: .cancelled) }
  }

  private func cancelled(view: ArdiaWebView, frame: String, pageId: String) {
    for entry in Array(pending.values) where entry.view === view && entry.frameId == frame && entry.pageId == pageId {
      finish(entry, answer: nil, outcome: .cancelled)
    }
  }

  func answer(requestId: String, choice: String, target: String? = nil) async -> [String: Any] {
    guard let entry = pending[requestId], entry.ready, let view = entry.view else { return ["ok": false, "error": "gone"] }
    guard !entry.busy else { return ["ok": false, "error": "busy"] }
    switch choice {
    case "cancel":
      noteDismissal(entry.tabId)
      finish(entry, answer: ["error": "NotAllowedError"], outcome: .refused)
      return ["ok": true]
    case "other", "source:chrome":
      finish(entry, answer: ["chrome": true], outcome: .fallback, via: "chrome")
      return ["ok": true]
    case "system":
      return await answerFromSystem(entry, view: view, provider: nil, direct: false)
    case "source:ardia":
      guard entry.choosing, entry.request.kind == .create || !entry.candidates.isEmpty else { return ["ok": false, "error": "invalid"] }
      entry.choosing = false
      start(entry)
      return ["ok": true]
    default:
      if choice.hasPrefix("delegate:") {
        let provider = String(choice.dropFirst("delegate:".count))
        guard entry.handlers[provider] == .system, entry.request.kind == .get || entry.existing.isEmpty else { return ["ok": false, "error": "invalid"] }
        entry.choosing = false
        return await answerFromSystem(entry, view: view, provider: provider, direct: false)
      }
      if choice.hasPrefix("source:ext:") {
        let id = String(choice.dropFirst("source:ext:".count))
        guard entry.extensions.contains(id) else { return ["ok": false, "error": "invalid"] }
        finish(entry, answer: ["extension": id], outcome: .handedOff, via: id)
        return ["ok": true]
      }
      if entry.choosing { return ["ok": false, "error": "invalid"] }
    }
    guard view.passkeyOriginIsCurrent(entry.origin) else {
      finish(entry, answer: nil, outcome: .cancelled)
      return ["ok": false, "error": "gone"]
    }
    switch entry.request.kind {
    case .create:
      if !entry.existing.isEmpty {
        guard choice == "existing" else { return ["ok": false, "error": "invalid"] }
        finish(entry, answer: ["error": "InvalidStateError"], outcome: .refused)
        return ["ok": true]
      }
      guard choice == "save" else { return ["ok": false, "error": "invalid"] }
      if let target, let handler = entry.handlers[target] {
        switch handler {
        case .system: return await answerFromSystem(entry, view: view, provider: target, direct: false)
        case .browserExtension(let id): return handOff(entry, view: view, provider: target, extensionId: id, allow: nil)
        }
      }
      if let target, target != ArdiaVault.id { return await create(entry, in: target) }
      return await create(entry)
    case .get:
      guard let candidate = entry.candidates.first(where: { $0.id == choice }) else { return ["ok": false, "error": "invalid"] }
      if candidate.delegated {
        guard case .browserExtension(let id) = entry.handlers[candidate.provider] else { return ["ok": false, "error": "invalid"] }
        return handOff(entry, view: view, provider: candidate.provider, extensionId: id, allow: candidate.id)
      }
      return await assert(entry, candidate: candidate)
    }
  }

  private func create(_ entry: Pending) async -> [String: Any] {
    entry.busy = true
    defer { entry.busy = false }
    let rpId = entry.site.rpId
    guard await VaultOwnerCheck.confirmEach("save a passkey for \(rpId)") else { return ["ok": false, "error": "declined"] }
    guard pending[entry.id] === entry, let view = entry.view, view.passkeyOriginIsCurrent(entry.origin) else { return ["ok": false, "error": "gone"] }
    let made = await VaultPasskeyWork.newPasskey(rpId: rpId, origin: entry.origin, request: entry.request)
    let key = made.key
    let credentialId = made.credentialId
    let id = VaultBase64URL.encode(credentialId)
    let passkey = made.passkey
    guard pending[entry.id] === entry, entry.view != nil else { return ["ok": false, "error": "gone"] }
    claim(entry)
    let edit = await ArdiaVaultBackup.shared.editPasskeys { $0[id] = passkey }
    guard edit == .saved else {
      reply(view, frame: entry.frameId, origin: entry.origin, pageId: entry.pageId, ["error": "NotAllowedError"])
      emitDone(tabId: entry.tabId, requestId: entry.id, outcome: .failed, stamp: entry.stamp)
      return ["ok": false, "error": "failed"]
    }
    let credential = await VaultPasskeyWork.registration(site: entry.site, request: entry.request, origin: entry.origin, key: key, credentialId: credentialId,
                                             backedUp: VaultCloud.shared.isOn)
    guard entry.view != nil, reply(view, frame: entry.frameId, origin: entry.origin, pageId: entry.pageId, ["credential": credential.credential]) else {
      _ = await ArdiaVaultBackup.shared.editPasskeys { $0[id] = nil }
      emitDone(tabId: entry.tabId, requestId: entry.id, outcome: .cancelled, stamp: entry.stamp)
      return ["ok": false, "error": "gone"]
    }
    emitDone(tabId: entry.tabId, requestId: entry.id, outcome: .created, stamp: entry.stamp)
    _ = await ArdiaVaultBackup.shared.editPasskeys { all in
      for (other, held) in all where other != id && held.rpId == passkey.rpId && held.userHandle == passkey.userHandle { all[other] = nil }
    }
    NSLog("[vaults] ardia saved a passkey")
    return ["ok": true]
  }

  private func create(_ entry: Pending, in holder: String) async -> [String: Any] {
    entry.busy = true
    defer { entry.busy = false }
    let rpId = entry.site.rpId
    let name = VaultRegistry.provider(holder)?.name ?? holder
    guard await VaultOwnerCheck.confirmEach("save a passkey for \(rpId) in \(name)") else { return ["ok": false, "error": "declined"] }
    guard pending[entry.id] === entry, let view = entry.view, view.passkeyOriginIsCurrent(entry.origin) else { return ["ok": false, "error": "gone"] }
    entry.timer?.cancel()
    let request = entry.request
    let credential = VaultNewPasskey(credentialId: UUID(), key: P256.Signing.PrivateKey(), rpId: rpId, rpName: request.rpName,
                                     userHandle: request.userId, userName: request.userName, displayName: request.displayName, createdAt: Date())
    switch await VaultBroker.shared.savePasskey(credential, in: holder, origin: entry.origin) {
    case .failure(.unavailable):
      armTimer(entry)
      return ["ok": false, "error": "unavailable"]
    case .failure(.failed(let message)):
      armTimer(entry)
      return ["ok": false, "error": "failed", "message": message]
    case .success:
      guard pending[entry.id] === entry, let view = entry.view else { return ["ok": false, "error": "gone"] }
      claim(entry)
      let answer = await VaultPasskeyWork.registration(site: entry.site, request: entry.request, origin: entry.origin, key: credential.key, credentialId: credential.rawId,
                                           backedUp: true)
      guard entry.view != nil, reply(view, frame: entry.frameId, origin: entry.origin, pageId: entry.pageId, ["credential": answer.credential]) else {
        emitDone(tabId: entry.tabId, requestId: entry.id, outcome: .cancelled, stamp: entry.stamp)
        return ["ok": false, "error": "gone"]
      }
      emitDone(tabId: entry.tabId, requestId: entry.id, outcome: .created, via: holder, stamp: entry.stamp)
      NSLog("[vaults] a credential provider saved a passkey")
      return ["ok": true]
    }
  }

  private func claim(_ entry: Pending) {
    guard pending[entry.id] === entry else { return }
    pending[entry.id] = nil
    entry.timer?.cancel()
  }

  private func assert(_ entry: Pending, candidate: VaultPasskeyCandidate) async -> [String: Any] {
    entry.busy = true
    defer { entry.busy = false }
    let rpId = entry.site.rpId
    let scope = VaultTouchGrants.passkey(request: entry.id, credential: candidate.id)
    guard await VaultOwnerCheck.confirmEach("sign in to \(rpId) with a passkey", touchScope: scope) else { return ["ok": false, "error": "declined"] }
    guard pending[entry.id] === entry, let view = entry.view, view.passkeyOriginIsCurrent(entry.origin) else { return ["ok": false, "error": "gone"] }
    guard let signer = await Self.signer(candidate), candidate.rpId == rpId else {
      finish(entry, answer: ["error": "NotAllowedError"], outcome: .failed)
      return ["ok": false, "error": "failed"]
    }
    let backedUp = candidate.provider != ArdiaVault.id || VaultCloud.shared.isOn
    guard let signed = await VaultPasskeyWork.assertion(signer, credentialId: candidate.id, rpId: rpId, request: entry.request, origin: entry.origin, backedUp: backedUp) else {
      finish(entry, answer: ["error": "NotAllowedError"], outcome: .failed)
      return ["ok": false, "error": "failed"]
    }
    guard pending[entry.id] === entry else { return ["ok": false, "error": "gone"] }
    var credential: [String: Any] = signed
    if entry.request.appid { credential["extensions"] = ["appid": false] }
    finish(entry, answer: ["credential": credential], outcome: .used)
    return ["ok": true]
  }

  @concurrent nonisolated static func candidates(rpId: String) async -> [VaultPasskeyCandidate] {
    var found = await ArdiaVaultBackup.shared.passkeys().compactMap { id, passkey -> VaultPasskeyCandidate? in
      guard passkey.rpId == rpId, let raw = VaultBase64URL.decode(id) else { return nil }
      return VaultPasskeyCandidate(provider: ArdiaVault.id, credentialId: raw, item: nil, rpId: passkey.rpId, userName: passkey.userName,
                                   displayName: passkey.displayName, discoverable: true)
    }
    found.sort { ($0.userName.lowercased(), $0.id) < ($1.userName.lowercased(), $1.id) }
    found += await VaultBroker.shared.passkeyCandidates(rpId: rpId)
    return found
  }

  @concurrent nonisolated static func signer(_ candidate: VaultPasskeyCandidate) async -> VaultPasskeySigner? {
    guard !candidate.delegated else { return nil }
    if candidate.provider == ArdiaVault.id {
      guard let passkey = await ArdiaVaultBackup.shared.passkeys()[candidate.id], let key = passkey.signingKey, let handle = passkey.userHandleBytes else {
        return nil
      }
      return VaultPasskeySigner(key: key, userHandle: handle)
    }
    return await VaultBroker.shared.passkeySigner(candidate)
  }

  @concurrent nonisolated static func list() async -> [[String: Any]] {
    var all = await ArdiaVaultBackup.shared.passkeys().map { id, passkey -> [String: Any] in
      var object: [String: Any] = ["id": id, "provider": ArdiaVault.id, "rpId": passkey.rpId, "userName": passkey.userName,
                                   "displayName": passkey.displayName, "createdAt": passkey.createdAt * 1000]
      if let origin = passkey.origin { object["origin"] = origin }
      return object
    }
    all += await VaultBroker.shared.passkeyCandidates(rpId: nil).map { $0.metadata() }
    return all
  }

  static func delete(id: String) async -> [String: Any] {
    guard VaultPasskey.isId(id), let passkey = await ArdiaVaultBackup.shared.passkeys()[id] else { return ["deleted": false, "error": "notFound"] }
    guard await VaultOwnerCheck.confirmEach("delete the passkey for \(passkey.rpId)") else { return ["deleted": false, "error": "declined"] }
    guard await ArdiaVaultBackup.shared.editPasskeys({ $0[id] = nil }) == .saved else { return ["deleted": false, "error": "failed"] }
    NSLog("[vaults] ardia deleted a passkey")
    return ["deleted": true]
  }

  nonisolated static func json(_ object: [String: Any]) -> String? {
    guard JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
