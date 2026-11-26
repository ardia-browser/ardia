import Foundation

final class PluginNetChannels {
  static let shared = PluginNetChannels()
  static let maxStreams = 8
  static let maxSockets = 8
  static let maxBacklog = 4 << 20
  static let backlogPause: TimeInterval = 0.02
  static let maxBacklogWaits = 500
  static let maxClosedRuns = 1024
  static let lineRoom = ControlOutput.maxLine - 256
  static let idPattern = "^[A-Za-z0-9_-]{1,64}$"

  private let streams = PluginRunTable<PluginHostFetch>(maxClosedRuns: maxClosedRuns)
  private let sockets = PluginRunTable<PluginWebSocket>(maxClosedRuns: maxClosedRuns)

  static func runKey(_ name: String, _ run: Int) -> String { "\(name)#\(run)" }
  static func key(_ name: String, _ run: Int, _ id: String) -> String { "\(runKey(name, run))/\(id)" }

  static func eventData(_ event: String, _ data: [String: Any]) -> Data? {
    let body: [String: Any] = ["event": event, "time": Int(Date().timeIntervalSince1970 * 1000), "data": data]
    return try? JSONSerialization.data(withJSONObject: body)
  }

  static func fits(_ event: String, _ data: [String: Any]) -> Bool {
    (eventData(event, data)?.count ?? Int.max) <= lineRoom
  }

  static func send(_ name: String, _ run: Int, _ event: String, _ data: [String: Any], waits: Int = 0, still: @escaping () -> Bool = { true }, ready: @escaping (Bool) -> Void) {
    guard let json = eventData(event, data), json.count <= lineRoom else { return ready(false) }
    PluginHost.shared.deliver(name, run: run, String(decoding: json, as: UTF8.self), still: still) { backlog in
      guard let backlog else { return ready(false) }
      if backlog <= maxBacklog { return ready(true) }
      waitForRoom(name, run, waits: waits, ready: ready)
    }
  }

  private static func waitForRoom(_ name: String, _ run: Int, waits: Int, ready: @escaping (Bool) -> Void) {
    guard waits < maxBacklogWaits else { return ready(false) }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + backlogPause) {
      PluginHost.shared.backlog(name, run: run) { backlog in
        guard let backlog else { return ready(false) }
        if backlog <= maxBacklog { return ready(true) }
        waitForRoom(name, run, waits: waits + 1, ready: ready)
      }
    }
  }

  func fetchStream(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard let name = spec["name"] as? String, let run = (spec["run"] as? NSNumber)?.intValue, let id = spec["stream"] as? String, id.range(of: Self.idPattern, options: .regularExpression) != nil
    else { return reply(PluginHostFetch.failed("fetchStream needs a name, run and stream id")) }
    let streams = self.streams
    let admission = streams.admit(name, run, id, cap: Self.maxStreams, live: { PluginHost.shared.isLive(name, run: run) }) { token in
      let stream = PluginHostFetch.Stream(
        chunk: { [weak self] text, ready in
          guard streams.current(name, run, id, token: token) else { return }
          Self.send(name, run, "net.fetch.chunk", ["stream": id, "data": text], still: { streams.current(name, run, id, token: token) }) { delivered in
            if delivered { return ready() }
            self?.failStream(name, run, id, token: token, reason: "the plugin didn't read the stream in time", code: "backpressure")
          }
        },
        end: {
          guard streams.remove(name, run, id, token: token) else { return }
          Self.send(name, run, "net.fetch.end", ["stream": id], still: { streams.untaken(name, run, id, by: token) }) { _ in }
        },
        fail: { reason in
          guard streams.remove(name, run, id, token: token) else { return }
          Self.send(name, run, "net.fetch.error", ["stream": id, "message": reason, "code": "failed"], still: { streams.untaken(name, run, id, by: token) }) { _ in }
        })
      return PluginHostFetch.run(spec, stream: stream) { body in
        if (body["ok"] as? Bool) != true { streams.remove(name, run, id, token: token) }
        reply(body)
      }
    }
    switch admission {
    case .admitted, .failed: break
    case .closed: reply(PluginHostFetch.failed("the plugin's run has ended"))
    case .taken: reply(PluginHostFetch.failed("a stream with that id is already open"))
    case .full: reply(PluginHostFetch.failed("the plugin has too many open streams (at most \(Self.maxStreams))"))
    }
  }

  func cancelStream(_ name: String, _ run: Int, _ id: String) {
    streams.take(name, run, id)?.value?.cancel()
  }

  func failStream(_ name: String, _ run: Int, _ id: String, token: UInt64, reason: String, code: String) {
    guard let found = streams.removeValue(name, run, id, token: token) else { return }
    found.cancel()
    let streams = self.streams
    Self.send(name, run, "net.fetch.error", ["stream": id, "message": reason, "code": code], still: { streams.untaken(name, run, id, by: token) }) { _ in }
  }

  func connect(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard let name = spec["name"] as? String, let run = (spec["run"] as? NSNumber)?.intValue, let id = spec["socket"] as? String, id.range(of: Self.idPattern, options: .regularExpression) != nil
    else { return reply(PluginHostFetch.failed("wsConnect needs a name, run and socket id")) }
    let sockets = self.sockets
    var refusal: String?
    let admission = sockets.admit(name, run, id, cap: Self.maxSockets, live: { PluginHost.shared.isLive(name, run: run) }) { token in
      let made = PluginWebSocket.make(spec, events: PluginWebSocket.Events(
        send: { event, data, ready in
          guard sockets.current(name, run, id, token: token) else { return ready(false) }
          Self.send(name, run, event, data.merging(["socket": id]) { $1 }, still: { sockets.untaken(name, run, id, by: token) }, ready: ready)
        },
        fits: { event, data in Self.fits(event, data.merging(["socket": id]) { $1 }) },
        closed: { sockets.remove(name, run, id, token: token) }))
      switch made {
      case .success(let socket): return socket
      case .failure(let refused):
        refusal = refused.reason
        return nil
      }
    }
    switch admission {
    case .admitted: sockets.value(name, run, id)?.open(reply: reply)
    case .closed: reply(PluginHostFetch.failed("the plugin's run has ended"))
    case .taken: reply(PluginHostFetch.failed("a socket with that id is already open"))
    case .full: reply(PluginHostFetch.failed("the plugin has too many open sockets (at most \(Self.maxSockets))"))
    case .failed: reply(PluginHostFetch.failed(refusal ?? "the socket couldn't open"))
    }
  }

  func send(_ name: String, _ run: Int, _ id: String, _ data: String, binary: Bool, reply: @escaping ([String: Any]) -> Void) {
    guard let socket = sockets.value(name, run, id) else { return reply(PluginHostFetch.failed("the socket isn't open")) }
    socket.send(data, binary: binary, reply: reply)
  }

  func close(_ name: String, _ run: Int, _ id: String, code: Int, reason: String) {
    sockets.value(name, run, id)?.close(code: code, reason: reason)
  }

  func closeAll(_ name: String, run: Int) {
    let closingStreams = streams.closeRun(name, run: run)
    let closingSockets = sockets.closeRun(name, run: run)
    closingStreams.forEach { $0.cancel() }
    closingSockets.forEach { $0.close(code: 1001, reason: "The plugin stopped.") }
    PluginFileHandles.shared.closeAll(name, run: run)
    DispatchQueue.main.async { PluginAuthSession.cancel(plugin: name, run: run) }
  }

  func isClosed(_ name: String, _ run: Int) -> Bool { streams.isClosed(name, run) }

  func counts(_ name: String) -> (streams: Int, sockets: Int) {
    (streams.count(name), sockets.count(name))
  }
}
