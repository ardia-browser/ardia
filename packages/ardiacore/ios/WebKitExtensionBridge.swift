import AppKit
import WebKit

@available(macOS 15.4, *)
@MainActor
final class WebKitExtensionBridge {
  private struct Pending {
    let reply: (Any?, (any Error)?) -> Void
    let windows: [[String]]
    let timeout: DispatchWorkItem
    let extensionId: String
    let bridge: ObjectIdentifier
  }

  final class Listener {
    let port: WKWebExtension.MessagePort
    let extensionId: String
    var apis: Set<String> = []
    var context: String?
    var relayed = false

    init(port: WKWebExtension.MessagePort, extensionId: String) {
      self.port = port
      self.extensionId = extensionId
    }
  }

  struct External {
    let reply: (Any?, (any Error)?) -> Void
    var waiting: Set<ObjectIdentifier>
    var listened: Bool
    let channel: String?
    var queue: [ObjectIdentifier]
    var body: [String: Any]?
  }

  private final class WeakBridge {
    weak var bridge: WebKitExtensionBridge?
    init(_ bridge: WebKitExtensionBridge) { self.bridge = bridge }
  }

  struct Channel {
    let opener: String
    let openerContext: String?
    var acceptor: ObjectIdentifier?
    var held: [Any] = []
  }

  static let replyDeadline: TimeInterval = 15
  static let dialogReplyDeadline: TimeInterval = 600
  static let dialogCalls: Set<String> = ["management.uninstall", "management.uninstallSelf", "downloads.acceptDanger", "downloads.open"]
  static let nativeReplyDeadline: TimeInterval = 120
  static let wakeDeadline: TimeInterval = 5
  static let idleTick: TimeInterval = 1
  static let noReceiver = "Could not establish connection. Receiving end does not exist."
  static let nativeApis: Set<String> = ["idle", "dns", "tts", "offscreen", "storage", "identity", "commands", "alarms", "declarativeNetRequest"]
  static var nextRequest = 0
  private static var pending: [String: Pending] = [:]
  private static var bridges: [WeakBridge] = []
  static var live: [WebKitExtensionBridge] {
    bridges.removeAll { $0.bridge == nil }
    return bridges.compactMap(\.bridge)
  }

  private(set) weak var hub: WebKitExtensionHub?
  var listeners: [ObjectIdentifier: Listener] = [:]
  private var hosts: [ObjectIdentifier: WebKitExtensionNativeHost] = [:]
  private var oneShots: [UUID: WebKitExtensionNativeHost] = [:]
  private var announced: Set<String> = []
  private var watched: Set<String> = []
  private var dnrWaiters: [String: [(Bool) -> Void]] = [:]
  var externals: [String: External] = [:]
  var channels: [String: Channel] = [:]
  private var idleIntervals: [String: Int] = [:]
  private var idleStates: [String: String] = [:]
  private var idleTimer: Timer?
  private var authFlows: [UUID: WebKitExtensionAuthFlow] = [:]
  private var confirming: Set<String> = []
  private var pageGestures: [String: Date] = [:]
  static let pageGestureLifetime: TimeInterval = 5
  private lazy var speech = WebKitExtensionSpeech { [weak self] extensionId, id, event in
    self?.signal(["signal": "ttsEvent", "utterance": id, "event": event], to: extensionId, api: "tts")
  }
  private let offscreen = WebKitExtensionOffscreen()

  init(hub: WebKitExtensionHub) {
    self.hub = hub
    Self.bridges.append(WeakBridge(self))
    WebKitExtensionShortcuts.shared.update(active: true)
    WebKitExtensionPageInput.shared.start()
    WebKitExtensionShared.observeEngine()
  }

  func owns(_ tab: WebKitTab) -> Bool { hub?.owns(tab) ?? false }

  var baseProfile: String? { hub.map { ArdiaHost.baseProfile(of: $0.profile) } }

  func grants(of extensionId: String) -> WebKitExtensionGrants? { hub?.loadedExtension(extensionId)?.grants }

  var isPrivate: Bool { hub?.isPrivate ?? false }

  func hasExtension(_ extensionId: String) -> Bool { hub?.loadedExtension(extensionId) != nil }

  func notePageInput(in webView: WKWebView) {
    guard let hub, webView.configuration.webExtensionController === hub.controller,
      let url = webView.url, let id = WebKitExtensionAccess.ownPage(url), hub.loadedExtension(id) != nil
    else { return }
    pageGestures[id] = Date()
  }

  func hasPageGesture(_ extensionId: String) -> Bool {
    WebKitExtensionAccess.isFresh(pageGestures[extensionId], lifetime: Self.pageGestureLifetime, now: Date())
  }

  func deliverStorageChange(_ changes: Any, area: String, contentMayRead: Bool, to extensionId: String) {
    let body: [String: Any] = ["ardia": 1, "api": "storage", "event": "onChanged", "args": [changes, area], "windows": hub?.windowTabKeys() ?? [[String]]()]
    for listener in listeners.values where listener.extensionId == extensionId && listener.apis.contains("storage") && !listener.port.isDisconnected {
      guard contentMayRead || !listener.relayed else { continue }
      listener.port.sendMessage(body, completionHandler: nil)
    }
  }

  func deliverSignal(_ message: [String: Any], to extensionId: String, api: String) { signal(message, to: extensionId, api: api) }

  static let mirrorDeadline: TimeInterval = 3

  private func awaitMirror(_ extensionId: String, kinds: [String], done: @escaping (Bool) -> Void) {
    var settled = false
    let once = { (applied: Bool) in
      guard !settled else { return }
      settled = true
      done(applied)
    }
    dnrWaiters[extensionId, default: []].append(once)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.mirrorDeadline) { MainActor.assumeIsolated { once(true) } }
    deliverWaking(["signal": "dnrChanged", "kinds": kinds, "acknowledge": true], to: extensionId, api: "declarativeNetRequest") { [weak self] in
      guard self?.receivers(of: extensionId, api: "declarativeNetRequest").isEmpty != false else { return }
      self?.dnrWaiters.removeValue(forKey: extensionId)?.forEach { $0(true) }
    }
  }

  func deliverWaking(_ message: [String: Any], to extensionId: String, api: String, done: @escaping () -> Void = {}) {
    guard hub?.loadedExtension(extensionId)?.apis.contains(api) == true else { return done() }
    whenListening(extensionId, api: api) { [weak self] found in
      if !found.isEmpty { self?.signal(message, to: extensionId, api: api) }
      done()
    }
  }

  func deliverAlarm(_ alarm: [String: Any], to extensionId: String) {
    guard hub?.loadedExtension(extensionId)?.apis.contains("alarms") == true else { return }
    whenListening(extensionId, api: "alarms") { [weak self] found in
      guard let self, !found.isEmpty else { return WebKitExtensionShared.count("extensionAlarmUndelivered") }
      self.signal(["signal": "alarm", "alarm": alarm], to: extensionId, api: "alarms")
      WebKitExtensionShared.count("extensionAlarmMirrored")
    }
  }

  static func listenable(_ listen: [String], loaded: WebKitExtensionHub.Loaded, relayed: Bool) -> Set<String> {
    let apis = relayed ? WebKitExtensionShim.contentApis(loaded.apis) : loaded.apis
    let permissions = Set(apiPermissions(loaded))
    return Set(listen).intersection(apis).filter { WebKitExtensionAccess.mayListen($0, permissions: permissions) }
  }

  static func failure(_ message: String) -> NSError {
    NSError(domain: "dev.ardia.webkit.extensions", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  func sendMessage(_ message: Any?, to application: String?, from context: WKWebExtensionContext, reply: @escaping (Any?, (any Error)?) -> Void) {
    guard let hub, let loaded = hub.loadedExtension(context.uniqueIdentifier) else { return reply(nil, Self.failure("The extension isn't loaded.")) }
    guard let application, application != WebKitExtensionShim.application else {
      return call(message as? [String: Any] ?? [:], loaded: loaded, hub: hub, reply: reply)
    }
    guard loaded.nativeMessaging else { return reply(nil, WebKitExtensionNativeHost.forbidden) }
    sendToHost(application, message: message, extensionId: loaded.id, reply: reply)
  }

  func connect(_ port: WKWebExtension.MessagePort, from context: WKWebExtensionContext, completion: @escaping ((any Error)?) -> Void) {
    guard let hub, let loaded = hub.loadedExtension(context.uniqueIdentifier) else { return completion(Self.failure("The extension isn't loaded.")) }
    let key = ObjectIdentifier(port)
    guard let application = port.applicationIdentifier, application != WebKitExtensionShim.application else {
      let listener = Listener(port: port, extensionId: loaded.id)
      listeners[key] = listener
      port.messageHandler = { [weak self, weak listener] message, _ in
        guard let self, let listener, let body = message as? [String: Any] else { return }
        listener.relayed = listener.relayed || body["relayed"] as? Bool == true
        if let request = body["reply"] as? String {
          guard !listener.relayed else { return }
          return self.externalReplied(request, from: key, body: body)
        }
        guard let listen = body["listen"] as? [String] else { return }
        listener.context = body["context"] as? String ?? listener.context
        listener.apis = self.hub?.loadedExtension(listener.extensionId).map { Self.listenable(listen, loaded: $0, relayed: listener.relayed) } ?? []
        self.announce()
      }
      port.disconnectHandler = { [weak self] _ in
        guard let self else { return }
        self.listeners.removeValue(forKey: key)
        self.listenerGone(key)
        self.announce()
      }
      return completion(nil)
    }
    guard loaded.nativeMessaging else { return completion(WebKitExtensionNativeHost.forbidden) }
    do {
      let host = try WebKitExtensionNativeHost.launch(application, extensionId: loaded.id, onMessage: { [weak port] message in
        port?.sendMessage(message, completionHandler: nil)
      }, onExit: { [weak self, weak port] error in
        self?.hosts.removeValue(forKey: key)
        if let error { port?.disconnect(throwing: error) } else { port?.disconnect() }
      })
      hosts[key] = host
      port.messageHandler = { [weak host] message, _ in
        guard let message, let host, !host.send(message) else { return }
        host.finish(WebKitExtensionNativeHost.broken)
      }
      port.disconnectHandler = { [weak self] _ in
        self?.hosts.removeValue(forKey: key)?.close()
      }
      completion(nil)
    } catch {
      completion(error)
    }
  }

  private func sendToHost(_ application: String, message: Any?, extensionId: String, reply: @escaping (Any?, (any Error)?) -> Void) {
    let token = UUID()
    var answered = false
    var deadline: DispatchWorkItem?
    let answer: (Any?, (any Error)?) -> Void = { [weak self] value, error in
      guard !answered else { return }
      answered = true
      deadline?.cancel()
      self?.oneShots.removeValue(forKey: token)?.close()
      reply(value, error)
    }
    do {
      let host = try WebKitExtensionNativeHost.launch(application, extensionId: extensionId, onMessage: { message in answer(message, nil) },
                                                      onExit: { error in answer(nil, error ?? WebKitExtensionNativeHost.exited) })
      oneShots[token] = host
      guard let message, host.send(message) else { return answer(nil, WebKitExtensionNativeHost.broken) }
      let expire = DispatchWorkItem { MainActor.assumeIsolated { answer(nil, WebKitExtensionNativeHost.unanswered) } }
      deadline = expire
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.nativeReplyDeadline, execute: expire)
    } catch {
      answer(nil, error)
    }
  }

  private func call(_ body: [String: Any], loaded: WebKitExtensionHub.Loaded, hub: WebKitExtensionHub, reply: @escaping (Any?, (any Error)?) -> Void) {
    guard body["ardia"] as? Int == 1, let api = body["api"] as? String, let method = body["method"] as? String else {
      return reply(["error": "Ardia doesn't know this message."], nil)
    }
    guard loaded.apis.contains(api), WebKitExtensionAccess.mayCall(api, method, permissions: Set(Self.apiPermissions(loaded))) else {
      return reply(["error": "The extension doesn't have the \(api) permission."], nil)
    }
    let relayed = body["relayed"] as? Bool == true
    if relayed, !Self.contentCallAllowed(api, method, apis: loaded.apis) { return reply(["error": "\(api).\(method) isn't available to content scripts."], nil) }
    if !Self.uncounted.contains(method) { ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "shim\(api.prefix(1).uppercased())\(api.dropFirst())"])) }
    var args = body["args"] as? [Any] ?? []
    if relayed { args = Self.contentArgs(api, method, args: args, from: body["relayedFrom"]) }
    if api == "runtime", runtimeCall(method, args: args, context: body["context"] as? String, loaded: loaded, reply: reply) { return }
    if api == "declarativeNetRequest", method == "wakeMirror" {
      let kinds = (args.first as? [String]) ?? ["dynamic", "session", "rulesets"]
      return awaitMirror(loaded.id, kinds: kinds) { applied in reply(["result": applied], nil) }
    }
    if api == "declarativeNetRequest", method == "mirrored" {
      let applied = args.first as? Bool ?? true
      for waiter in dnrWaiters.removeValue(forKey: loaded.id) ?? [] { waiter(applied) }
      return reply(["result": NSNull()], nil)
    }
    if Self.nativeApis.contains(api) { return nativeCall(api, method, args: args, untrusted: relayed, loaded: loaded, hub: hub, reply: reply) }
    let tabs = (body["tabs"] as? [Any] ?? []).map { hub.resolve($0 as? [String: Any]) }
    let windows = hub.windowTabKeys()
    let gesture = { [self] in
      !relayed && body["activation"] as? Bool == true && hasPageGesture(loaded.id) || hub.shownTab().map(loaded.context.hasActiveUserGesture(in:)) == true
    }
    if api == "sidePanel" {
      if method == "open", !gesture() { return reply(["error": "`sidePanel.open()` may only be called in response to a user gesture."], nil) }
      return reply(hub.sidePanelCall(method, args: args, tabs: tabs, extensionId: loaded.id), nil)
    }
    if api == "downloads", method == "open" {
      guard Self.apiPermissions(loaded).contains("downloads.open") else { return reply(["error": "The extension doesn't have the downloads.open permission."], nil) }
      guard gesture() else { return reply(["error": "downloads.open may only be called from a user gesture."], nil) }
    }
    var reply = reply
    if api == "management", method == "uninstall" {
      guard gesture() else { return reply(["error": "management.uninstall requires a user gesture."], nil) }
      let caller = loaded.id
      guard confirming.insert(caller).inserted else { return reply(["error": "An uninstall confirmation is already open."], nil) }
      let answer = reply
      reply = { [weak self] value, error in
        self?.confirming.remove(caller)
        answer(value, error)
      }
    }
    if api == "downloads", method == "download" {
      let started: [String: Any]
      do {
        started = try hub.startDownload(args.first as? [String: Any] ?? [:])
      } catch {
        return reply(["error": error.localizedDescription], nil)
      }
      return forward(api: api, method: "download", args: [started], tabKeys: [], windows: windows, extensionId: loaded.id, hub: hub, reply: reply)
    }
    forward(api: api, method: method, args: args, tabKeys: tabs.map { tab -> Any in tab?.transferKey.map { $0 as Any } ?? NSNull() }, windows: windows, extensionId: loaded.id, hub: hub, reply: reply)
  }

  static func contentCallAllowed(_ api: String, _ method: String, apis: Set<String>) -> Bool {
    guard WebKitExtensionShim.contentApis(apis).contains(api), !(api == "storage" && method == "sharedSetAccessLevel") else { return false }
    return api != "runtime" || method == "sendExternal"
  }

  static func contentArgs(_ api: String, _ method: String, args: [Any], from relayedFrom: Any?) -> [Any] {
    var args = args
    guard api == "runtime", method == "sendExternal" else { return args }
    let from = relayedFrom as? [String: Any] ?? [:]
    while args.count < 3 { args.append(NSNull()) }
    args[2] = ["url": from["url"] as? String ?? "", "origin": from["origin"] as? String ?? ""]
    return args
  }

  private func forward(api: String, method: String, args: [Any], tabKeys: [Any], windows: [[String]], extensionId: String, hub: WebKitExtensionHub,
                       reply: @escaping (Any?, (any Error)?) -> Void) {
    Self.nextRequest += 1
    let id = "wk-ext-\(Self.nextRequest)"
    let timeout = DispatchWorkItem { MainActor.assumeIsolated { Self.deliver(id, ["error": "Ardia didn't answer in time."]) } }
    Self.pending[id] = Pending(reply: reply, windows: windows, timeout: timeout, extensionId: extensionId, bridge: ObjectIdentifier(self))
    let deadline = Self.dialogCalls.contains("\(api).\(method)") ? Self.dialogReplyDeadline : Self.replyDeadline
    DispatchQueue.main.asyncAfter(deadline: .now() + deadline, execute: timeout)
    var data: [String: Any] = [
      "id": id, "profile": hub.profile, "base": ArdiaHost.baseProfile(of: hub.profile), "private": hub.isPrivate, "extensionId": extensionId,
      "api": api, "method": method, "args": args, "tabKeys": tabKeys, "windows": windows,
      "answerBy": ((Date().timeIntervalSince1970 + deadline) * 1000).rounded(.down),
    ]
    if api == "management" { data["apiPermissions"] = hub.loaded.mapValues(Self.apiPermissions) }
    ArdiaEvents.emit("webKit.extensionCall", data: ArdiaConsentStamp.begin().onto(data))
  }

  nonisolated static func answer(_ id: String, _ payload: [String: Any]) {
    MainActor.assumeIsolated { deliver(id, payload) }
  }

  private static func deliver(_ id: String, _ payload: [String: Any]) {
    guard let entry = pending.removeValue(forKey: id) else { return }
    entry.timeout.cancel()
    var body: [String: Any] = ["windows": entry.windows]
    if let error = payload["error"] as? String { body["error"] = error } else { body["result"] = payload["result"] ?? NSNull() }
    entry.reply(body, nil)
  }

  nonisolated func event(api: String, name: String, args: [Any]) {
    MainActor.assumeIsolated { broadcast(api: api, name: name, args: args) }
  }

  private func broadcast(api: String, name: String, args: [Any]) {
    guard let hub else { return }
    let message: [String: Any] = ["ardia": 1, "api": api, "event": name, "args": args, "windows": hub.windowTabKeys()]
    for listener in listeners.values where listener.apis.contains(api) && !listener.port.isDisconnected {
      listener.port.sendMessage(message, completionHandler: nil)
    }
  }

  func dropExtension(_ id: String) {
    var cancelled: [String] = []
    for (request, waiting) in Self.pending where waiting.extensionId == id && waiting.bridge == ObjectIdentifier(self) {
      Self.pending.removeValue(forKey: request)
      waiting.timeout.cancel()
      waiting.reply(nil, Self.failure("The extension was unloaded."))
      cancelled.append(request)
    }
    if !cancelled.isEmpty { ArdiaEvents.emit("webKit.extensionCallsCancelled", data: ArdiaConsentStamp.begin().onto(["ids": cancelled])) }
    for reply in dnrWaiters.removeValue(forKey: id) ?? [] { reply(false) }
    for (key, listener) in listeners where listener.extensionId == id {
      listener.port.disconnect()
      listeners.removeValue(forKey: key)
      listenerGone(key)
    }
    closeHosts(of: id)
    offscreen.closeAll(of: id)
    speech.stop(extensionId: id)
    for (token, flow) in authFlows where flow.extensionId == id {
      authFlows.removeValue(forKey: token)
      flow.cancel()
    }
    idleIntervals.removeValue(forKey: id)
    idleStates.removeValue(forKey: id)
    confirming.remove(id)
    pageGestures.removeValue(forKey: id)
    announce()
  }

  func closeHosts(of id: String) {
    let owned = hosts.values.filter { $0.extensionId == id } + oneShots.values.filter { $0.extensionId == id }
    owned.forEach { $0.finish(WebKitExtensionNativeHost.exited) }
  }

  func closeAll() {
    listeners.values.forEach { $0.port.disconnect() }
    for key in Array(listeners.keys) {
      listeners.removeValue(forKey: key)
      listenerGone(key)
    }
    offscreen.closeAll()
    speech.stop()
    authFlows.values.forEach { $0.cancel() }
    authFlows.removeAll()
    hosts.values.forEach { $0.close() }
    hosts.removeAll()
    oneShots.values.forEach { $0.close() }
    oneShots.removeAll()
    announce()
  }

  func announce() {
    guard let hub else { return }
    let apis = listeners.values.reduce(into: Set<String>()) { $0.formUnion($1.apis) }
    watchShared(hub)
    watchIdle(listeners.values.contains { $0.apis.contains("idle") })
    guard apis != announced else { return }
    announced = apis
    ArdiaEvents.emit("webKit.extensionListeners", data: ArdiaConsentStamp.begin().onto([
      "profile": hub.profile, "base": ArdiaHost.baseProfile(of: hub.profile), "private": hub.isPrivate, "apis": apis.sorted(),
    ]))
  }

  private func watchShared(_ hub: WebKitExtensionHub) {
    let base = ArdiaHost.baseProfile(of: hub.profile)
    var wanted = listeners.values.reduce(into: Set<String>()) { keys, listener in
      if listener.apis.contains("storage") { keys.insert("storage|\(listener.extensionId)") }
    }
    for entry in hub.loaded.values where entry.apis.contains("alarms") { wanted.insert("alarms|\(entry.id)") }
    for entry in hub.loaded.values where entry.apis.contains("declarativeNetRequest") { wanted.insert("dnr|\(entry.id)") }
    for key in wanted.symmetricDifference(watched) {
      let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
      guard parts.count == 2, let feature = WebKitExtensionShared.Feature(rawValue: parts[0]) else { continue }
      WebKitExtensionShared.watch(feature, base: base, extensionId: parts[1], on: wanted.contains(key))
    }
    watched = wanted
  }

  static let uncounted: Set<String> = ["groupIdsOf", "portPost", "portClose"]

  static func apiPermissions(_ loaded: WebKitExtensionHub.Loaded) -> [String] {
    let manifest = loaded.context.webExtension.manifest
    let names = WebKitExtensionStaging.permissionNames(manifest["permissions"])
      .union(WebKitExtensionStaging.permissionNames(manifest["optional_permissions"]).intersection(loaded.grants.apis))
    return names.filter { $0 != "nativeMessaging" || loaded.nativeMessaging }.sorted()
  }

  private func signal(_ message: [String: Any], to extensionId: String, api: String) {
    var body = message
    body["ardia"] = 1
    for listener in listeners.values where listener.extensionId == extensionId && listener.apis.contains(api) && !listener.port.isDisconnected {
      listener.port.sendMessage(body, completionHandler: nil)
    }
  }

  private func nativeCall(_ api: String, _ method: String, args: [Any], untrusted: Bool, loaded: WebKitExtensionHub.Loaded, hub: WebKitExtensionHub,
                          reply: @escaping (Any?, (any Error)?) -> Void) {
    let answer = { (result: Any?) in reply(["result": result ?? NSNull()], nil) }
    let fail = { (message: String) in reply(["error": message], nil) }
    let argument = { (index: Int) -> Any? in args.indices.contains(index) ? args[index] : nil }
    if WebKitExtensionSharedCalls.handle(api, method, args: args, extensionId: loaded.id, profile: hub.profile, untrusted: untrusted, reply: reply) { return }
    switch (api, method) {
    case ("idle", "queryState"):
      answer(WebKitExtensionIdle.state(interval: WebKitExtensionIdle.interval(argument(0))))
    case ("idle", "setDetectionInterval"):
      idleIntervals[loaded.id] = WebKitExtensionIdle.interval(argument(0))
      answer(nil)
    case ("dns", "resolve"):
      fail(WebKitExtensionDns.unavailable)
    case ("tts", "speak"):
      guard let text = argument(0) as? String, (text as NSString).length <= 32768 else { return fail("Utterance is too long.") }
      let options = argument(1) as? [String: Any] ?? [:]
      let id = options["__utterance"] as? String ?? UUID().uuidString
      if let error = speech.speak(text, options: options, id: id, extensionId: loaded.id) { return fail(error) }
      answer(nil)
    case ("tts", "stop"):
      speech.stop()
      answer(nil)
    case ("tts", "pause"):
      speech.pause()
      answer(nil)
    case ("tts", "resume"):
      speech.resume()
      answer(nil)
    case ("tts", "isSpeaking"):
      answer(speech.isSpeaking)
    case ("tts", "getVoices"):
      answer(WebKitExtensionSpeech.voices())
    case ("offscreen", "createDocument"):
      offscreen.create(argument(0) as? [String: Any] ?? [:], context: loaded.context, extensionId: loaded.id) { error in
        if let error { fail(error) } else { answer(nil) }
      }
    case ("offscreen", "hasDocument"):
      answer(offscreen.has(loaded.id))
    case ("offscreen", "closeDocument"):
      if let error = offscreen.close(loaded.id) { fail(error) } else { answer(nil) }
    case ("storage", "managedGet"):
      answer(WebKitExtensionManagedStorage.get(argument(0), extensionId: loaded.id))
    case ("storage", "managedBytesInUse"):
      answer(WebKitExtensionManagedStorage.bytesInUse(argument(0), extensionId: loaded.id))
    case ("identity", "launchWebAuthFlow"):
      let options = argument(0) as? [String: Any] ?? [:]
      guard let text = options["url"] as? String, let url = URL(string: text), url.scheme != nil else { return fail(WebKitExtensionAuthFlow.notLoaded) }
      let flow = WebKitExtensionAuthFlow(
        extensionId: loaded.id, title: loaded.context.webExtension.displayName ?? loaded.id, options: options,
        dataStore: WebKitHub.shared.stores.dataStore(for: hub.profile))
      let token = UUID()
      authFlows[token] = flow
      flow.start(url) { [weak self] redirect, error in
        self?.authFlows.removeValue(forKey: token)
        if let error { fail(error) } else { answer(redirect) }
      }
    case ("commands", "getAll"):
      answer(commandList(loaded, hub: hub))
    default:
      fail("\(api).\(method) isn't supported.")
    }
  }

  private func commandList(_ loaded: WebKitExtensionHub.Loaded, hub: WebKitExtensionHub) -> [[String: Any]] {
    let shortcuts = WebKitExtensionShortcuts.shared.shortcuts(profile: hub.profile).filter { $0.extensionId == loaded.id }
    return loaded.context.commands.map { command in
      let shortcut = shortcuts.first { $0.command == command.id || ($0.isAction && WebKitExtensionShortcut.actionCommands.contains(command.id)) }
      return ["name": command.id, "description": command.title, "shortcut": shortcut?.display ?? ""]
    }
  }

  func performShortcut(_ event: NSEvent, tab: WebKitTab) -> Bool {
    guard let hub else { return false }
    for shortcut in WebKitExtensionShortcuts.shared.shortcuts(profile: hub.profile) where shortcut.matches(event) {
      guard let entry = hub.loadedExtension(shortcut.extensionId) else { continue }
      if shortcut.isAction {
        guard !event.isARepeat else { return true }
        guard let key = tab.transferKey else { continue }
        ArdiaEvents.emit("extensions.actionShortcut", data: ArdiaConsentStamp.begin().onto(["tabId": key, "extensionId": entry.id]))
      } else {
        guard let command = entry.context.commands.first(where: { $0.id == shortcut.command }) else { continue }
        entry.context.userGesturePerformed(in: tab)
        entry.context.performCommand(command)
      }
      ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionShortcut"]))
      return true
    }
    return false
  }

  private func watchIdle(_ on: Bool) {
    if on, idleTimer == nil {
      idleTimer = Timer.scheduledTimer(withTimeInterval: Self.idleTick, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.tickIdle() }
      }
    } else if !on, let timer = idleTimer {
      timer.invalidate()
      idleTimer = nil
      idleStates.removeAll()
    }
  }

  private func tickIdle() {
    let ids = Set(listeners.values.filter { $0.apis.contains("idle") }.map(\.extensionId))
    idleStates = idleStates.filter { ids.contains($0.key) }
    for id in ids {
      let state = WebKitExtensionIdle.state(interval: idleIntervals[id] ?? WebKitExtensionIdle.defaultInterval)
      let before = idleStates.updateValue(state, forKey: id)
      guard let before, before != state else { continue }
      signal(["api": "idle", "event": "onStateChanged", "args": [state], "windows": [[String]]()], to: id, api: "idle")
    }
  }
}
