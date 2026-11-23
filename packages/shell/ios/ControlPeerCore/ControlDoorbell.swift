import Darwin
import Foundation

public final class ControlDoorbell {
  public enum Outcome: String {
    case once, halfHour, always, deny, unshown, timeout, left, stopped, full, quiet, unsaved
  }

  public struct Ask {
    public let id: Int
    public let key: String?
    public let process: String
    public let peer: ControlPeer
    public let deadline: Date
    public fileprivate(set) var connections: Set<Int>
  }

  public static let defaultDeadline: TimeInterval = 60
  public static let maxWaiting = 8
  public static let quietAfterRefusal: TimeInterval = 30

  public typealias Open = (_ connection: Int, _ fd: Int32, _ key: String?, _ until: Date?) -> Bool
  public typealias Send = (_ name: String, _ body: [String: Any]) -> Bool

  private let queue: DispatchQueue
  private let deadline: TimeInterval
  private let tick: TimeInterval
  private let now: () -> Date
  private let open: Open
  private let send: Send
  private let capacity: () -> Int
  private let alive: (audit_token_t) -> Bool
  private let dismiss: (Int) -> Void
  private var waiting: [Int: (fd: Int32, ask: Int)] = [:]
  private var asks: [Int: Ask] = [:]
  private var tokens: [Int: audit_token_t] = [:]
  private var quiet: [String: Date] = [:]
  private var nextAsk = 0
  private var timer: DispatchSourceTimer?

  public init(
    queue: DispatchQueue, deadline: TimeInterval = ControlDoorbell.defaultDeadline, tick: TimeInterval = 1, now: @escaping () -> Date = Date.init,
    capacity: @escaping () -> Int = { Int.max }, alive: @escaping (audit_token_t) -> Bool = ControlPeer.alive, dismiss: @escaping (Int) -> Void = { _ in },
    open: @escaping Open, send: @escaping Send
  ) {
    self.queue = queue
    self.deadline = deadline
    self.tick = tick
    self.now = now
    self.capacity = capacity
    self.alive = alive
    self.dismiss = dismiss
    self.open = open
    self.send = send
  }

  public var waitingCount: Int { waiting.count }
  public var openAsks: [Ask] { asks.values.sorted { $0.id < $1.id } }

  public func ring(connection: Int, fd: Int32, peer: ControlPeer, key: String?, token: audit_token_t) {
    dispatchPrecondition(condition: .onQueue(queue))
    let at = now()
    quiet = quiet.filter { $0.value > at }
    if let key, quiet[key] != nil { return Self.refuse(fd, .quiet) }
    guard waiting.count < Self.maxWaiting else { return Self.refuse(fd, .full) }
    let process = ControlPeer.process(of: token)
    if let shared = asks.values.first(where: { $0.process == process && $0.key == key && $0.peer == peer }) {
      asks[shared.id]?.connections.insert(connection)
      waiting[connection] = (fd, shared.id)
      return
    }
    nextAsk += 1
    let ask = Ask(id: nextAsk, key: key, process: process, peer: peer, deadline: at.addingTimeInterval(deadline), connections: [connection])
    let told = send("onPeerAsk", [
      "ask": ask.id, "name": peer.name, "signedBy": peer.signedBy, "path": peer.path.map { ControlPeer.plain($0, limit: 300) } ?? "",
      "identifier": peer.identifier.map { ControlPeer.plain($0, limit: 120) } ?? "", "remember": key != nil,
      "deadline": ask.deadline.timeIntervalSince1970 * 1000,
    ])
    guard told else { return Self.refuse(fd, .unshown) }
    asks[ask.id] = ask
    tokens[ask.id] = token
    waiting[connection] = (fd, ask.id)
    arm()
  }

  @discardableResult
  public func answer(_ id: Int, _ outcome: Outcome, approvals: ControlApprovals?) -> Bool {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let ask = asks[id], [.once, .halfHour, .always, .deny, .unshown].contains(outcome) else { return false }
    let at = now()
    dropLeft(of: id)
    if asks[id]?.connections.isEmpty ?? true || !(tokens[id].map(alive) ?? false) {
      end(id, .left, admit: false)
      return false
    }
    if ask.deadline <= at {
      end(id, .timeout, admit: false)
      quietAll(ask.key, .timeout, at: at)
      return false
    }
    if outcome == .deny {
      guard stillLive(id, at: at) != nil else { return false }
      end(id, .deny, admit: false)
      quietAll(ask.key, .deny, at: at)
      return true
    }
    if outcome == .unshown {
      end(id, .unshown, admit: false)
      return true
    }
    guard let live = stillLive(id, at: at) else { return false }
    guard capacity() > 0 else {
      end(id, .full, admit: false)
      return false
    }
    guard outcome != .once else {
      end(id, .once, admit: true)
      return true
    }
    let decision: ControlPeerDecision = outcome == .always ? .always : .halfHour
    guard let key = live.key, let approval = decision.approval(for: live.peer, key: key, now: at), approvals?.add(approval, now: at) == true else {
      end(id, .unsaved, admit: true)
      return true
    }
    let until = approval.until.map { Date(timeIntervalSince1970: $0) }
    end(id, outcome, admit: true, key: key, until: until)
    for other in openAsks where other.key == key {
      guard stillLive(other.id, at: at) != nil else { continue }
      end(other.id, outcome, admit: true, key: key, until: until)
    }
    return true
  }

  private func stillLive(_ id: Int, at: Date) -> Ask? {
    guard let ask = asks[id] else { return nil }
    if ask.deadline <= at {
      end(id, .timeout, admit: false)
      return nil
    }
    dropLeft(of: id)
    guard let live = asks[id], !live.connections.isEmpty, let token = tokens[id], alive(token) else {
      end(id, .left, admit: false)
      return nil
    }
    return live
  }

  private func quietAll(_ key: String?, _ outcome: Outcome, at: Date) {
    guard let key else { return }
    quiet[key] = at.addingTimeInterval(Self.quietAfterRefusal)
    for ask in openAsks where ask.key == key { end(ask.id, outcome, admit: false) }
  }

  public func check() {
    dispatchPrecondition(condition: .onQueue(queue))
    for id in asks.keys { dropLeft(of: id) }
    let at = now()
    for ask in openAsks {
      if ask.connections.isEmpty || !(tokens[ask.id].map(alive) ?? false) {
        end(ask.id, .left, admit: false)
      } else if ask.deadline <= at {
        end(ask.id, .timeout, admit: false)
        quietAll(ask.key, .timeout, at: at)
      }
    }
    if asks.isEmpty { disarm() }
  }

  public func stop() {
    dispatchPrecondition(condition: .onQueue(queue))
    for ask in openAsks { end(ask.id, .stopped, admit: false) }
    for entry in waiting.values { Darwin.close(entry.fd) }
    waiting.removeAll()
    quiet.removeAll()
    disarm()
  }

  private func dropLeft(of id: Int) {
    guard let ask = asks[id] else { return }
    for connection in ask.connections {
      guard let entry = waiting[connection], Self.peerLeft(entry.fd) else { continue }
      Darwin.close(entry.fd)
      waiting[connection] = nil
      asks[id]?.connections.remove(connection)
    }
  }

  private func arm() {
    guard timer == nil else { return }
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + tick, repeating: tick)
    source.setEventHandler { [weak self] in self?.check() }
    timer = source
    source.activate()
  }

  private func disarm() {
    timer?.cancel()
    timer = nil
  }

  private func end(_ id: Int, _ outcome: Outcome, admit: Bool, key: String? = nil, until: Date? = nil) {
    guard let ask = asks.removeValue(forKey: id) else { return }
    tokens[id] = nil
    var admitted = 0
    for connection in ask.connections.sorted() {
      guard let entry = waiting.removeValue(forKey: connection) else { continue }
      if !admit {
        Self.refuse(entry.fd, outcome)
      } else if open(connection, entry.fd, key, until) {
        admitted += 1
      } else {
        Self.refuse(entry.fd, .full)
      }
    }
    let reported: Outcome = admit && admitted == 0 ? .full : outcome
    dismiss(id)
    _ = send("onPeerAskEnded", ["ask": id, "outcome": reported.rawValue])
    if asks.isEmpty { disarm() }
  }

  public static func peerLeft(_ fd: Int32) -> Bool {
    var probe = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    if poll(&probe, 1, 0) > 0, probe.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 { return true }
    var byte: UInt8 = 0
    let got = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
    if got == 0 { return true }
    if got > 0 { return false }
    return errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR
  }

  public static func refusal(_ outcome: Outcome) -> String {
    switch outcome {
    case .deny, .quiet: return "You chose Don't Allow when Ardia asked whether this program may control it."
    case .timeout: return "Ardia asked whether this program may control it, and nobody answered in time."
    case .unshown: return "Ardia has to ask before this program may control it, and nobody can see the question (no Ardia window is on screen, or Ardia runs in the background)."
    case .full: return "Too many programs are connected to Ardia or waiting to be let in. Try again in a minute."
    case .stopped: return "Control was turned off before anyone answered."
    default: return "Ardia didn't let this program control it."
    }
  }

  public static func refuse(_ fd: Int32, _ outcome: Outcome) {
    let body: [String: Any] = ["id": NSNull(), "error": ["code": "refused", "message": refusal(outcome)]]
    if var data = try? JSONSerialization.data(withJSONObject: body) {
      data.append(10)
      _ = data.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, data.count, MSG_DONTWAIT) }
    }
    Darwin.close(fd)
  }
}
