import WebKit

@available(macOS 15.4, *)
extension WebKitExtensionBridge {
  private func senderInfo(_ extensionId: String, _ value: Any?) -> [String: Any] {
    var sender: [String: Any] = ["id": extensionId]
    let info = value as? [String: Any] ?? [:]
    if let url = info["url"] as? String, !url.isEmpty { sender["url"] = url }
    if let origin = info["origin"] as? String, !origin.isEmpty { sender["origin"] = origin }
    return sender
  }

  func runtimeCall(_ method: String, args: [Any], context: String?, loaded: WebKitExtensionHub.Loaded,
                           reply: @escaping (Any?, (any Error)?) -> Void) -> Bool {
    let argument = { (index: Int) -> Any? in args.indices.contains(index) ? args[index] : nil }
    switch method {
    case "sendExternal":
      guard let target = argument(0) as? String, acceptsExternal(target, from: loaded.id) else { reply(["error": Self.noReceiver], nil); return true }
      deliverExternal("message", to: target, body: ["message": argument(1) ?? NSNull(), "sender": senderInfo(loaded.id, argument(2))], channel: nil, reply: reply)
    case "connectExternal":
      guard let target = argument(0) as? String, let channel = argument(2) as? String, acceptsExternal(target, from: loaded.id),
        WebKitExtensionAccess.ownsNewChannel(channel, extensionId: loaded.id, open: Set(channels.keys))
      else { reply(["error": Self.noReceiver], nil); return true }
      channels[channel] = Channel(opener: loaded.id, openerContext: context, acceptor: nil)
      deliverExternal("connect", to: target, body: ["name": argument(1) ?? "", "channel": channel, "sender": senderInfo(loaded.id, argument(3))], channel: channel,
                      reply: reply)
    case "portPost", "portClose":
      guard let id = argument(0) as? String, let channel = channels[id] else { reply(["result": NSNull()], nil); return true }
      let fromOpener = channel.opener == loaded.id && channel.openerContext == context
      guard fromOpener || channel.acceptor.flatMap({ listeners[$0]?.extensionId }) == loaded.id else { reply(["result": NSNull()], nil); return true }
      let other = fromOpener ? channel.acceptor.flatMap { listeners[$0] } : listeners.values.first { $0.extensionId == channel.opener && $0.context == channel.openerContext }
      if method == "portClose" {
        channels.removeValue(forKey: id)
        other?.port.sendMessage(["ardia": 1, "signal": "portDisconnect", "channel": id], completionHandler: nil)
      } else if fromOpener, channel.acceptor == nil {
        channels[id]?.held.append(argument(1) ?? NSNull())
      } else {
        other?.port.sendMessage(["ardia": 1, "signal": "portMessage", "channel": id, "message": argument(1) ?? NSNull()], completionHandler: nil)
      }
      reply(["result": NSNull()], nil)
    default:
      return false
    }
    return true
  }

  private func acceptsExternal(_ target: String, from sender: String) -> Bool {
    guard let manifest = hub?.loadedExtension(target)?.context.webExtension.manifest else { return true }
    return WebKitExtensionAccess.acceptsExternal(from: sender, manifest: manifest)
  }

  private func receivers(of extensionId: String, api: String) -> [ObjectIdentifier] {
    listeners.filter { $0.value.extensionId == extensionId && !$0.value.relayed && $0.value.apis.contains(api) && !$0.value.port.isDisconnected }.map(\.key)
  }

  func whenListening(_ extensionId: String, api: String, then: @escaping ([ObjectIdentifier]) -> Void) {
    let now = receivers(of: extensionId, api: api)
    guard now.isEmpty else { return then(now) }
    guard let target = hub?.loadedExtension(extensionId) else { return then([]) }
    target.context.loadBackgroundContent { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return then([]) }
        self.awaitReceivers(extensionId, api: api, until: Date().addingTimeInterval(Self.wakeDeadline), then: then)
      }
    }
  }

  private func awaitReceivers(_ extensionId: String, api: String, until deadline: Date, then: @escaping ([ObjectIdentifier]) -> Void) {
    let found = receivers(of: extensionId, api: api)
    guard found.isEmpty, Date() < deadline, hub?.loadedExtension(extensionId) != nil else { return then(found) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
      MainActor.assumeIsolated {
        guard let self else { return then([]) }
        self.awaitReceivers(extensionId, api: api, until: deadline, then: then)
      }
    }
  }

  private func deliverExternal(_ kind: String, to target: String, body: [String: Any], channel: String?, reply: @escaping (Any?, (any Error)?) -> Void) {
    whenListening(target, api: "runtime") { [weak self] found in
      guard let self, !found.isEmpty else {
        if let channel { self?.channels.removeValue(forKey: channel) }
        return reply(["error": Self.noReceiver], nil)
      }
      Self.nextRequest += 1
      let id = "wk-ext-external-\(Self.nextRequest)"
      let targets = kind == "connect" ? Array(found.prefix(1)) : found
      self.externals[id] = External(reply: reply, waiting: Set(targets), listened: false, channel: channel, queue: Array(found.dropFirst(targets.count)))
      self.send(kind, request: id, body: body, to: targets)
    }
  }

  private func send(_ kind: String, request: String, body: [String: Any], to targets: [ObjectIdentifier]) {
    var message = body
    message["ardia"] = 1
    message["signal"] = kind
    message["request"] = request
    externals[request]?.body = message
    for key in targets { listeners[key]?.port.sendMessage(message, completionHandler: nil) }
  }

  func externalReplied(_ request: String, from key: ObjectIdentifier, body: [String: Any]) {
    guard var entry = externals[request], entry.waiting.contains(key) else { return }
    if body["responded"] as? Bool == true {
      externals.removeValue(forKey: request)
      if let channel = entry.channel {
        guard channels[channel] != nil else {
          listeners[key]?.port.sendMessage(["ardia": 1, "signal": "portDisconnect", "channel": channel], completionHandler: nil)
          return entry.reply(["error": Self.noReceiver], nil)
        }
        accept(channel, by: key)
      }
      return entry.reply(["result": body["response"] ?? NSNull()], nil)
    }
    entry.waiting.remove(key)
    entry.listened = entry.listened || body["listened"] as? Bool == true
    while entry.waiting.isEmpty, let next = entry.queue.first, let message = entry.body {
      entry.queue.removeFirst()
      guard listeners[next] != nil else { continue }
      entry.waiting = [next]
      externals[request] = entry
      listeners[next]?.port.sendMessage(message, completionHandler: nil)
      return
    }
    guard entry.waiting.isEmpty else { return externals[request] = entry }
    externals.removeValue(forKey: request)
    if let channel = entry.channel { channels.removeValue(forKey: channel) }
    entry.reply(entry.listened && entry.channel == nil ? ["result": NSNull()] : ["error": Self.noReceiver], nil)
  }

  private func accept(_ id: String, by key: ObjectIdentifier) {
    guard var channel = channels[id] else { return }
    let held = channel.held
    channel.acceptor = key
    channel.held = []
    channels[id] = channel
    for message in held { listeners[key]?.port.sendMessage(["ardia": 1, "signal": "portMessage", "channel": id, "message": message], completionHandler: nil) }
  }

  func listenerGone(_ key: ObjectIdentifier) {
    for (request, entry) in externals where entry.queue.contains(key) { externals[request]?.queue.removeAll { $0 == key } }
    for request in externals.filter({ $0.value.waiting.contains(key) }).map(\.key) {
      externalReplied(request, from: key, body: ["responded": false, "listened": true])
    }
    for (id, channel) in channels {
      let wasAcceptor = channel.acceptor == key
      let wasOpener = !wasAcceptor && !listeners.values.contains { $0.extensionId == channel.opener && $0.context == channel.openerContext }
      guard wasAcceptor || wasOpener else { continue }
      channels.removeValue(forKey: id)
      let other = wasAcceptor
        ? listeners.values.first { $0.extensionId == channel.opener && $0.context == channel.openerContext }
        : channel.acceptor.flatMap { listeners[$0] }
      other?.port.sendMessage(["ardia": 1, "signal": "portDisconnect", "channel": id], completionHandler: nil)
    }
  }
}
