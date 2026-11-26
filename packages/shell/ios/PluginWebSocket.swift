import ArdiaCore
import Foundation
import Network

final class PluginWebSocket {
  struct Events {
    let send: (_ event: String, _ data: [String: Any], _ ready: @escaping (Bool) -> Void) -> Void
    let fits: (_ event: String, _ data: [String: Any]) -> Bool
    let closed: () -> Void
  }

  static let maxMessage = 1 << 20
  static let maxQueued = 64
  static let maxProtocols = 8
  static let connectTimeout: TimeInterval = 20

  private let url: URL
  private let httpURL: URL
  private let allowedHosts: [String]
  private let allowLoopback: Bool
  private let protocols: [String]
  private let headers: [(String, String)]
  private let events: Events
  private let queue = DispatchQueue(label: "ardia.plugins.socket", qos: .userInitiated)
  private let key = PluginWebSocketCodec.key()
  private var connection: NWConnection?
  private var addresses: [String] = []
  private var openReply: (([String: Any]) -> Void)?
  private var head = Data()
  private var parser = PluginWebSocketParser(maxPayload: PluginWebSocket.maxMessage)
  private var upgraded = false
  private var queued = 0
  private var finished = false
  private var keepAlive: PluginWebSocket?

  private init(url: URL, httpURL: URL, allowedHosts: [String], allowLoopback: Bool, protocols: [String], headers: [(String, String)], events: Events) {
    self.url = url
    self.httpURL = httpURL
    self.allowedHosts = allowedHosts
    self.allowLoopback = allowLoopback
    self.protocols = protocols
    self.headers = headers
    self.events = events
  }

  static func httpURL(_ url: URL) -> URL? {
    guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    switch parts.scheme?.lowercased() {
    case "wss": parts.scheme = "https"
    case "ws": parts.scheme = "http"
    default: return nil
    }
    parts.fragment = nil
    return parts.url
  }

  static func make(_ spec: [String: Any], events: Events) -> Result<PluginWebSocket, FolderRefusal> {
    guard let raw = spec["url"] as? String, raw.count <= 8192, let url = URL(string: raw), let allowedHosts = spec["allowedHosts"] as? [String], let http = httpURL(url)
    else { return .failure(FolderRefusal(reason: "a socket needs a ws:// or wss:// address")) }
    let allowLoopback = PluginFetchPolicy.loopbackAllowed(isolated: LaunchConfig.shared.isolated, allowedHosts: allowedHosts)
    if let problem = PluginFetchPolicy.check(http, allowedHosts: allowedHosts, allowLoopback: allowLoopback) {
      return .failure(FolderRefusal(reason: problem.replacingOccurrences(of: "https addresses can be fetched", with: "wss addresses can be reached")))
    }
    let protocols = (spec["protocols"] as? [String]) ?? []
    guard protocols.count <= maxProtocols, protocols.allSatisfy(PluginFetchPolicy.isToken) else { return .failure(FolderRefusal(reason: "protocols must be up to \(maxProtocols) tokens")) }
    let given = (spec["headers"] as? [String: Any] ?? [:]).mapValues { "\($0)" }
    switch PluginFetchPolicy.checkedHeaders(given) {
    case .failure(let refusal): return .failure(refusal)
    case .success(let checked):
      let headers = checked.filter { !$0.key.hasPrefix("sec-websocket") && $0.key != "origin" && $0.key != "cookie" }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
      guard PluginWebSocketCodec.handshake(url: http, key: "probe", protocols: protocols, headers: headers) != nil else { return .failure(FolderRefusal(reason: "the socket's address or headers can't be sent")) }
      return .success(PluginWebSocket(url: url, httpURL: http, allowedHosts: allowedHosts, allowLoopback: allowLoopback, protocols: protocols, headers: headers, events: events))
    }
  }

  func open(reply: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      guard !finished else { return reply(PluginHostFetch.failed("the socket was closed before it opened")) }
      keepAlive = self
      openReply = reply
      queue.asyncAfter(deadline: .now() + Self.connectTimeout) { [weak self] in
        guard let self, self.openReply != nil else { return }
        self.fail("it timed out after \(Int(Self.connectTimeout)) s")
      }
      let target = httpURL
      let allowLoopback = allowLoopback
      let allowedHosts = allowedHosts
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let vetted = PluginHostFetch.vettedAddresses(for: target, allowLoopback: allowLoopback, allowedHosts: allowedHosts)
        self?.queue.async { self?.vetted(vetted) }
      }
    }
  }

  private func vetted(_ result: Result<[String], FolderRefusal>) {
    guard !finished, openReply != nil else { return }
    switch result {
    case .failure(let refusal): fail(refusal.reason)
    case .success(let found):
      addresses = found
      connectNext()
    }
  }

  private func connectNext() {
    guard !finished, openReply != nil else { return }
    guard !addresses.isEmpty else { return fail("the server couldn't be reached") }
    let address = addresses.removeFirst()
    guard let endpoint = PluginHostFetch.endpoint(address, port: PluginHttpCodec.port(of: httpURL)) else { return connectNext() }
    let made = NWConnection(to: endpoint, using: PluginHostFetch.parameters(for: httpURL, timeout: Self.connectTimeout))
    connection = made
    made.stateUpdateHandler = { [weak self, weak made] state in
      guard let self, let made, self.connection === made else { return }
      switch state {
      case .ready: self.sendHandshake(on: made)
      case .waiting, .failed:
        if self.upgraded { return self.fail("the connection dropped") }
        made.stateUpdateHandler = nil
        made.cancel()
        self.connectNext()
      default: break
      }
    }
    made.start(queue: queue)
  }

  private func sendHandshake(on made: NWConnection) {
    guard let bytes = PluginWebSocketCodec.handshake(url: httpURL, key: key, protocols: protocols, headers: headers) else { return fail("the socket's request couldn't be made") }
    made.send(content: bytes, completion: .contentProcessed { [weak self] error in
      guard let self else { return }
      if let error { return self.fail(PluginHostFetch.describe(error)) }
      self.receive()
    })
  }

  private func receive() {
    guard !finished, let made = connection else { return }
    made.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, !self.finished else { return }
      if let data, !data.isEmpty {
        if !self.upgraded { return self.takeHead(data, complete: isComplete) }
        return self.take(data, complete: isComplete)
      }
      if let error { return self.fail(PluginHostFetch.describe(error)) }
      if isComplete { return self.finish(code: 1006, reason: "the server closed the connection", clean: false) }
      self.receive()
    }
  }

  private func takeHead(_ data: Data, complete: Bool) {
    head.append(data)
    guard let end = PluginWebSocketCodec.headEnd(head) else {
      if head.count > PluginWebSocketCodec.maxHeadBytes || complete { return fail("the server's answer wasn't a WebSocket upgrade") }
      return receive()
    }
    let rest = Data(head.suffix(from: end))
    switch PluginWebSocketCodec.checkHandshake(Data(head.prefix(end)), key: key, protocols: protocols) {
    case .failure(let refusal): return fail(refusal.reason)
    case .success(let chosen):
      upgraded = true
      head = Data()
      if let reply = openReply {
        openReply = nil
        reply(["ok": true, "open": true, "protocol": chosen])
      }
      rest.isEmpty ? receive() : take(rest, complete: complete)
    }
  }

  private func take(_ data: Data, complete: Bool) {
    let messages: [PluginWebSocketMessage]
    do {
      messages = try parser.feed(data)
    } catch let refusal as FolderRefusal {
      return protocolError(refusal.reason)
    } catch {
      return protocolError("the server sent a bad frame")
    }
    deliver(messages[...], complete: complete)
  }

  private func deliver(_ messages: ArraySlice<PluginWebSocketMessage>, complete: Bool) {
    guard !finished else { return }
    guard let message = messages.first else {
      if complete { return finish(code: 1006, reason: "the server closed the connection", clean: false) }
      return receive()
    }
    let rest = messages.dropFirst()
    switch message {
    case .ping(let payload):
      write(PluginWebSocketCodec.frame(opcode: 0xA, payload: payload))
      deliver(rest, complete: complete)
    case .pong:
      deliver(rest, complete: complete)
    case .close(let code, let reason):
      write(PluginWebSocketCodec.frame(opcode: 0x8, payload: PluginWebSocketCodec.closePayload(code: code == 1005 ? 1000 : code, reason: "")))
      finish(code: code, reason: reason, clean: true)
    case .text(let payload), .binary(let payload):
      let binary: Bool
      if case .binary = message { binary = true } else { binary = false }
      let body: [String: Any] = ["data": binary ? payload.base64EncodedString() : String(decoding: payload, as: UTF8.self), "binary": binary]
      guard events.fits("net.ws.message", body) else {
        let notice = PluginWebSocketCodec.tooBig
        events.send("net.ws.error", ["message": notice.message, "code": notice.code]) { _ in }
        return close(code: notice.close, reason: notice.reason)
      }
      events.send("net.ws.message", body) { [weak self] delivered in
        self?.queue.async {
          guard let self else { return }
          if delivered { return self.deliver(rest, complete: complete) }
          let notice = PluginWebSocketCodec.fellBehind
          self.events.send("net.ws.error", ["message": notice.message, "code": notice.code]) { _ in }
          self.close(code: notice.close, reason: notice.reason)
        }
      }
    }
  }

  private func protocolError(_ reason: String) {
    write(PluginWebSocketCodec.frame(opcode: 0x8, payload: PluginWebSocketCodec.closePayload(code: 1002, reason: "")))
    fail(reason)
  }

  private func write(_ data: Data, done: ((NWError?) -> Void)? = nil) {
    guard let made = connection else {
      done?(nil)
      return
    }
    made.send(content: data, completion: .contentProcessed { error in done?(error) })
  }

  static func closeCode(_ code: Int) -> Int {
    code == 1000 || code == 1001 || code == 1008 || code == 1009 || (3000...4999).contains(code) ? code : 1000
  }

  func send(_ text: String, binary: Bool, reply: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      guard !finished, upgraded, connection != nil else { return reply(PluginHostFetch.failed("the socket isn't open")) }
      let data = binary ? Data(base64Encoded: text) : Data(text.utf8)
      guard let data else { return reply(PluginHostFetch.failed("a binary message must be base64")) }
      guard data.count <= Self.maxMessage else { return reply(PluginHostFetch.failed("the message is over \(Self.maxMessage >> 20) MB")) }
      guard queued < Self.maxQueued else { return reply(PluginHostFetch.failed("the socket has \(Self.maxQueued) messages waiting to send")) }
      queued += 1
      write(PluginWebSocketCodec.frame(opcode: binary ? 0x2 : 0x1, payload: data)) { [weak self] error in
        self?.queue.async {
          self?.queued -= 1
          reply(error.map { PluginHostFetch.failed(PluginHostFetch.describe($0)) } ?? ["ok": true])
        }
      }
    }
  }

  func close(code: Int, reason: String) {
    queue.async { [self] in
      guard !finished else { return }
      guard upgraded, connection != nil else { return finish(code: code, reason: reason, clean: true) }
      let frame = PluginWebSocketCodec.frame(opcode: 0x8, payload: PluginWebSocketCodec.closePayload(code: Self.closeCode(code), reason: reason))
      write(frame) { [weak self] _ in self?.queue.async { self?.finish(code: code, reason: reason, clean: true) } }
    }
  }

  private func fail(_ reason: String) {
    guard !finished else { return }
    if let reply = openReply {
      openReply = nil
      reply(PluginHostFetch.failed(reason))
      return finish(code: 1006, reason: reason, clean: false, announce: false)
    }
    events.send("net.ws.error", ["message": reason]) { _ in }
    finish(code: 1006, reason: reason, clean: false)
  }

  private func finish(code: Int, reason: String, clean: Bool, announce: Bool = true) {
    guard !finished else { return }
    finished = true
    var shouldAnnounce = announce && upgraded
    if let reply = openReply {
      openReply = nil
      reply(PluginHostFetch.failed(reason.isEmpty ? "the socket closed before it opened" : reason))
      shouldAnnounce = false
    }
    teardown(announce: shouldAnnounce, code: code, reason: reason, clean: clean)
  }

  private func teardown(announce: Bool, code: Int, reason: String, clean: Bool) {
    let made = connection
    connection = nil
    made?.stateUpdateHandler = nil
    made?.cancel()
    if announce { events.send("net.ws.close", ["code": code, "reason": reason, "wasClean": clean]) { _ in } }
    events.closed()
    keepAlive = nil
  }
}
