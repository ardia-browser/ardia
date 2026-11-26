import ArdiaCore
import Darwin
import Foundation
import Network

final class PluginHostFetch {
  typealias Reply = ([String: Any]) -> Void

  struct Stream {
    let chunk: (_ text: String, _ ready: @escaping () -> Void) -> Void
    let end: () -> Void
    let fail: (_ reason: String) -> Void
  }

  static let readChunk = 64 * 1024
  static let maxStreamBytes = 256 << 20
  static let streamIdle: TimeInterval = 120
  static let streamLifetime: TimeInterval = 30 * 60

  private let allowedHosts: [String]
  private let allowLoopback: Bool
  private let timeout: TimeInterval
  private let queue = DispatchQueue(label: "ardia.plugins.fetch", qos: .userInitiated)
  private var hop: PluginHttpHop
  private var parser: PluginHttpParser
  private var redirects = 0
  private var reply: Reply?
  private var connection: NWConnection?
  private var deadline: DispatchWorkItem?
  private var deadlineUptime: TimeInterval = 0
  private var attempts = PluginConnectAttempts(addresses: [], deadline: 0)
  private var attemptDeadline: DispatchWorkItem?
  private var requestBytes = Data()
  private var keepAlive: PluginHostFetch?
  private var stream: Stream?
  private var streamText = PluginUtf8Chunks()
  private var idle: DispatchWorkItem?
  private var binary = false
  private var bodyCap = PluginFetchPolicy.maxResponseBytes
  private var maxBody: Int { stream == nil ? bodyCap : Self.maxStreamBytes }

  private init(request: PluginFetchRequest, allowedHosts: [String], allowLoopback: Bool, stream: Stream?, reply: @escaping Reply) {
    self.allowedHosts = allowedHosts
    self.allowLoopback = allowLoopback
    self.timeout = request.timeout
    self.hop = PluginHttpHop(request)
    self.stream = stream
    self.parser = PluginHttpParser(method: request.method, maxBody: stream == nil ? PluginFetchPolicy.maxResponseBytes : Self.maxStreamBytes)
    self.reply = reply
  }

  static func failed(_ reason: String) -> [String: Any] { ["ok": false, "reason": reason] }

  @discardableResult
  static func run(_ spec: [String: Any], stream: Stream? = nil, reply: @escaping Reply) -> PluginHostFetch? {
    guard let url = spec["url"] as? String, let allowedHosts = spec["allowedHosts"] as? [String] else {
      reply(failed("hostFetch needs a url and allowedHosts"))
      return nil
    }
    let method = spec["method"] as? String ?? "GET"
    let headers = (spec["headers"] as? [String: Any] ?? [:]).mapValues { "\($0)" }
    let body = spec["body"] as? String
    let timeoutMs = (spec["timeoutMs"] as? NSNumber)?.intValue ?? 30000
    let loopback = PluginFetchPolicy.loopbackAllowed(isolated: LaunchConfig.shared.isolated, allowedHosts: allowedHosts)
    let made = PluginFetchPolicy.request(url: url, method: method, headers: headers, body: body, timeoutMs: timeoutMs, allowedHosts: allowedHosts, allowLoopback: loopback)
    switch made {
    case .failure(let refusal):
      reply(failed(refusal.reason))
      return nil
    case .success(let request):
      let fetch = PluginHostFetch(request: request, allowedHosts: allowedHosts, allowLoopback: loopback, stream: stream, reply: reply)
      if spec["binary"] as? Bool == true {
        fetch.binary = true
        fetch.bodyCap = PluginImageBytes.maxBytes
      }
      fetch.start()
      return fetch
    }
  }

  func cancel() {
    queue.async { [self] in
      stream = nil
      finish(Self.failed("it was cancelled"))
    }
  }

  static func addresses(of host: String) -> [String]? {
    var hints = addrinfo(ai_flags: AI_ADDRCONFIG, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM, ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
    var list: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, nil, &hints, &list) == 0, let first = list else { return nil }
    defer { freeaddrinfo(first) }
    var found: [String] = []
    var cursor: UnsafeMutablePointer<addrinfo>? = first
    while let entry = cursor {
      var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if let address = entry.pointee.ai_addr, getnameinfo(address, entry.pointee.ai_addrlen, &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0 {
        found.append(String(cString: name))
      }
      cursor = entry.pointee.ai_next
    }
    return found
  }

  static func vettedAddresses(for url: URL, allowLoopback: Bool, allowedHosts: [String] = []) -> Result<[String], FolderRefusal> {
    if let loopback = PluginFetchPolicy.loopbackAddress(for: url, allowedHosts: allowedHosts) { return .success([loopback]) }
    guard let raw = url.host else { return .failure(FolderRefusal(reason: "the address has no host")) }
    let host = PluginFetchPolicy.normalizedHost(raw)
    let resolved = PluginFetchPolicy.isIPLiteral(host) ? [] : addresses(of: host)
    return PluginFetchPolicy.vettedAddresses(for: url, resolved: resolved, allowLoopback: allowLoopback)
  }

  static func endpoint(_ address: String, port: Int) -> NWEndpoint? {
    guard let port = NWEndpoint.Port(rawValue: UInt16(clamping: port)), port.rawValue > 0 else { return nil }
    if let v4 = IPv4Address(address) { return .hostPort(host: .ipv4(v4), port: port) }
    if let v6 = IPv6Address(address) { return .hostPort(host: .ipv6(v6), port: port) }
    return nil
  }

  static func parameters(for url: URL, timeout: TimeInterval) -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.connectionTimeout = max(1, Int(timeout.rounded(.up)))
    tcp.noDelay = true
    guard url.scheme?.lowercased() == "https" else {
      let plain = NWParameters(tls: nil, tcp: tcp)
      plain.preferNoProxies = true
      return plain
    }
    let tls = NWProtocolTLS.Options()
    let security = tls.securityProtocolOptions
    let host = PluginFetchPolicy.normalizedHost(url.host ?? "")
    if !PluginFetchPolicy.isIPLiteral(host) { sec_protocol_options_set_tls_server_name(security, host) }
    sec_protocol_options_add_tls_application_protocol(security, "http/1.1")
    sec_protocol_options_set_min_tls_protocol_version(security, .TLSv12)
    let secure = NWParameters(tls: tls, tcp: tcp)
    secure.preferNoProxies = true
    return secure
  }

  private func start() {
    let deadline = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.finish(Self.failed("it timed out after \(Int(self.timeout)) s"))
    }
    self.deadline = deadline
    deadlineUptime = ProcessInfo.processInfo.systemUptime + timeout
    keepAlive = self
    queue.asyncAfter(deadline: .now() + timeout, execute: deadline)
    queue.async { self.connect() }
  }

  private func connect() {
    guard reply != nil else { return }
    let url = hop.url
    let allowLoopback = allowLoopback
    let allowedHosts = allowedHosts
    DispatchQueue.global(qos: .userInitiated).async {
      let vetted = Self.vettedAddresses(for: url, allowLoopback: allowLoopback, allowedHosts: allowedHosts)
      self.queue.async { self.open(vetted) }
    }
  }

  private func open(_ vetted: Result<[String], FolderRefusal>) {
    guard reply != nil else { return }
    switch vetted {
    case .failure(let refusal): return finish(Self.failed(redirects > 0 ? "it redirected to an address it may not reach: \(refusal.reason)" : refusal.reason))
    case .success(let addresses): attempts = PluginConnectAttempts(addresses: addresses, deadline: deadlineUptime)
    }
    guard let bytes = PluginHttpCodec.requestBytes(hop) else { return finish(Self.failed("the request couldn't be made")) }
    requestBytes = bytes
    parser = PluginHttpParser(method: hop.method, maxBody: maxBody)
    tryNextAddress()
  }

  private func tryNextAddress() {
    guard reply != nil else { return }
    closeConnection()
    guard let (address, attemptTimeout) = attempts.next(now: ProcessInfo.processInfo.systemUptime) else { return finish(Self.failed(attempts.failureReason)) }
    guard let endpoint = Self.endpoint(address, port: PluginHttpCodec.port(of: hop.url)) else {
      attempts.failed(reason: "the request couldn't be made")
      return tryNextAddress()
    }
    let made = NWConnection(to: endpoint, using: Self.parameters(for: hop.url, timeout: attemptTimeout))
    connection = made
    let giveUp = DispatchWorkItem { [weak self, weak made] in
      guard let self, let made, self.connection === made else { return }
      self.attempts.failed(reason: "it timed out")
      self.tryNextAddress()
    }
    attemptDeadline = giveUp
    queue.asyncAfter(deadline: .now() + attemptTimeout, execute: giveUp)
    made.stateUpdateHandler = { [weak self, weak made] state in
      guard let self, let made, self.connection === made else { return }
      switch state {
      case .ready:
        self.attemptDeadline?.cancel()
        self.attemptDeadline = nil
        self.send(self.requestBytes, on: made)
      case .waiting(let error), .failed(let error):
        guard self.attemptDeadline != nil else { return self.finish(Self.failed(Self.describe(error))) }
        self.attempts.failed(reason: Self.describe(error))
        self.tryNextAddress()
      default: break
      }
    }
    made.start(queue: queue)
  }

  private func send(_ bytes: Data, on made: NWConnection) {
    made.send(
      content: bytes,
      completion: .contentProcessed { [weak self, weak made] error in
        guard let self, let made, self.connection === made else { return }
        if let error { return self.finish(Self.failed(Self.describe(error))) }
        self.receive(on: made)
      })
  }

  private func receive(on made: NWConnection) {
    made.receive(minimumIncompleteLength: 1, maximumLength: Self.readChunk) { [weak self, weak made] data, _, isComplete, error in
      guard let self, let made, self.connection === made else { return }
      do {
        var finished = false
        if let data, !data.isEmpty { finished = try self.parser.feed(data) }
        if !finished, isComplete {
          try self.parser.finishAtEOF()
          finished = true
        }
        if self.stream != nil, self.parser.headReady, !PluginHttpCodec.isRedirect(self.parser.response.status) {
          return self.pushStream(finished: finished, failure: finished ? nil : error, on: made)
        }
        if finished { return self.answered() }
      } catch let refusal as FolderRefusal {
        return self.finish(Self.failed(refusal.reason))
      } catch {
        return self.finish(Self.failed(error.localizedDescription))
      }
      if let error { return self.finish(Self.failed(Self.describe(error))) }
      self.receive(on: made)
    }
  }

  private func answered() {
    closeConnection()
    let response = parser.response
    guard PluginHttpCodec.isRedirect(response.status) else { return succeed(response) }
    redirects += 1
    switch PluginHttpCodec.redirect(from: hop, status: response.status, location: response.values("location").first) {
    case .failure(let refusal): return finish(Self.failed(refusal.reason))
    case .success(let next):
      if let problem = PluginFetchPolicy.checkRedirect(to: next.url, count: redirects, allowedHosts: allowedHosts, allowLoopback: allowLoopback) {
        return finish(Self.failed(problem))
      }
      hop = next
      connect()
    }
  }

  private func head(_ response: PluginHttpResponse) -> [String: Any] {
    [
      "ok": true, "status": response.status, "statusText": HTTPURLResponse.localizedString(forStatusCode: response.status),
      "url": hop.url.absoluteString, "headers": response.joinedHeaders,
    ]
  }

  private func pushStream(finished: Bool, failure: NWError?, on made: NWConnection) {
    guard let stream else { return }
    if let reply {
      self.reply = nil
      deadline?.cancel()
      deadline = nil
      let lifetime = DispatchWorkItem { [weak self] in self?.failStream("it streamed for longer than \(Int(Self.streamLifetime / 60)) minutes") }
      deadline = lifetime
      queue.asyncAfter(deadline: .now() + Self.streamLifetime, execute: lifetime)
      reply(head(parser.response))
    }
    armIdle()
    let text = streamText.text(parser.drainBody()) + (finished ? streamText.finish() : "")
    let next = { [weak self, weak made] in
      guard let self else { return }
      self.queue.async {
        guard self.stream != nil else { return }
        if finished { return self.endStream() }
        if let failure { return self.failStream(Self.describe(failure)) }
        guard let made, self.connection === made else { return }
        self.receive(on: made)
      }
    }
    if text.isEmpty { return next() }
    stream.chunk(text, next)
  }

  private func armIdle() {
    idle?.cancel()
    let item = DispatchWorkItem { [weak self] in self?.failStream("it sent nothing for \(Int(Self.streamIdle)) s") }
    idle = item
    queue.asyncAfter(deadline: .now() + Self.streamIdle, execute: item)
  }

  private func endStream() {
    let ending = stream
    stream = nil
    finish([:])
    ending?.end()
  }

  private func failStream(_ reason: String) {
    let failing = stream
    stream = nil
    finish(Self.failed(reason))
    failing?.fail(reason)
  }

  private func succeed(_ response: PluginHttpResponse) {
    finish([
      "ok": true, "status": response.status, "statusText": HTTPURLResponse.localizedString(forStatusCode: response.status),
      "url": hop.url.absoluteString, "headers": response.joinedHeaders, "body": binary ? response.body.base64EncodedString() : String(decoding: response.body, as: UTF8.self),
    ])
  }

  private func closeConnection() {
    attemptDeadline?.cancel()
    attemptDeadline = nil
    guard let made = connection else { return }
    connection = nil
    made.stateUpdateHandler = nil
    made.cancel()
  }

  private func finish(_ body: [String: Any]) {
    let pending = reply
    reply = nil
    deadline?.cancel()
    deadline = nil
    idle?.cancel()
    idle = nil
    closeConnection()
    keepAlive = nil
    if let pending { return pending(body) }
    if let failing = stream, (body["ok"] as? Bool) == false {
      stream = nil
      failing.fail(body["reason"] as? String ?? "the stream failed")
    }
  }

  static func describe(_ error: NWError) -> String {
    switch error {
    case .posix(let code) where code == .ETIMEDOUT: return "it timed out"
    case .posix(let code) where code == .ECONNREFUSED: return "the server refused the connection"
    case .tls(let status): return "the secure connection failed (\(status))"
    case .dns: return "the server couldn't be found"
    default: return error.localizedDescription
    }
  }
}
