import Darwin
import Foundation

enum PluginSignInBind: Equatable {
  case listening
  case portInUse(String)
  case failed(String)

  var reply: [String: Any] {
    switch self {
    case .listening: return ["ok": true]
    case .portInUse(let reason): return ["ok": false, "code": "port_in_use", "reason": reason]
    case .failed(let reason): return ["ok": false, "code": "failed", "reason": reason]
    }
  }
}

struct POSIXErrorBox: Error {
  let code: Int32
}

final class PluginSignInListener {
  static let maxSessions = 16
  static let maxConnections = 16
  static let readDeadline: TimeInterval = 5
  static let drainDeadline: TimeInterval = 1

  private final class Connection {
    let fd: Int32
    let owner: String
    var source: DispatchSourceRead?
    var buffer = Data()
    var answered = false

    init(fd: Int32, owner: String) {
      self.fd = fd
      self.owner = owner
    }

    var key: ObjectIdentifier { ObjectIdentifier(self) }
  }

  private final class Session {
    let id: String
    let expectation: PluginSignInExpectation
    var sockets: [Int32] = []
    var accepting: [DispatchSourceRead] = []
    var connections: [ObjectIdentifier: Connection] = [:]
    var deadline: DispatchWorkItem?

    init(id: String, expectation: PluginSignInExpectation) {
      self.id = id
      self.expectation = expectation
    }
  }

  let queue: DispatchQueue
  private var sessions: [String: Session] = [:]
  private var draining: [ObjectIdentifier: Connection] = [:]
  private var pendingBinds: [String: Int] = [:]
  private var nextBind = 0
  private let caught: (String, String) -> Void

  init(queue: DispatchQueue = DispatchQueue(label: "ardia.plugins.signin", qos: .userInitiated), caught: @escaping (String, String) -> Void) {
    self.queue = queue
    self.caught = caught
  }

  func listen(id: String, host: String, port: Int, path: String, state: String, deadlineMs: Int, answer: @escaping (PluginSignInBind) -> Void) {
    queue.async { [self] in
      nextBind += 1
      let token = nextBind
      pendingBinds[id] = token
      queue.async { [self] in
        guard pendingBinds[id] == token else { return answer(.failed("stopped before it listened")) }
        pendingBinds.removeValue(forKey: id)
        answer(listenLocked(id: id, host: host, port: port, path: path, state: state, deadlineMs: deadlineMs))
      }
    }
  }

  func stop(_ id: String) {
    queue.async { [self] in
      pendingBinds.removeValue(forKey: id)
      stopLocked(id)
    }
  }

  func stopAll() {
    queue.sync { [self] in
      pendingBinds.removeAll()
      for id in Array(sessions.keys) { stopLocked(id) }
      for connection in draining.values { drop(connection) }
      draining.removeAll()
    }
  }

  var sessionCount: Int { queue.sync { sessions.count } }

  var drainingCount: Int { queue.sync { draining.count } }

  private func listenLocked(id: String, host: String, port: Int, path: String, state: String, deadlineMs: Int) -> PluginSignInBind {
    stopLocked(id)
    guard let expectation = PluginSignInExpectation.forCallback(host: host, port: port, path: path, state: state) else { return .failed("not a loopback callback") }
    guard sessions.count < Self.maxSessions else { return .failed("too many sign-ins waiting") }
    let session = Session(id: id, expectation: expectation)
    for address in PluginSignInExpectation.bindAddresses(host: host) {
      switch bind(address, port) {
      case .success(let fd): session.sockets.append(fd)
      case .failure(let box):
        let code = box.code
        if code == EADDRNOTAVAIL, address == "::1", host == "localhost" { continue }
        for fd in session.sockets { Darwin.close(fd) }
        let reason = "\(address):\(port): \(String(cString: strerror(code)))"
        return code == EADDRINUSE ? .portInUse(reason) : .failed(reason)
      }
    }
    guard !session.sockets.isEmpty else { return .failed("nothing to listen on") }
    sessions[id] = session
    for fd in session.sockets {
      let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
      source.setEventHandler { [weak self, weak session] in
        guard let self, let session else { return }
        self.accept(session, fd)
      }
      source.setCancelHandler { Darwin.close(fd) }
      source.resume()
      session.accepting.append(source)
    }
    let deadline = DispatchWorkItem { [weak self] in self?.stopLocked(id) }
    session.deadline = deadline
    queue.asyncAfter(deadline: .now() + .milliseconds(max(deadlineMs, 1000)), execute: deadline)
    return .listening
  }

  private func withAddress<T>(_ address: String, _ port: Int, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
    if address.contains(":") {
      var addr = sockaddr_in6()
      addr.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
      addr.sin6_family = sa_family_t(AF_INET6)
      addr.sin6_port = in_port_t(UInt16(port).bigEndian)
      addr.sin6_addr = in6addr_loopback
      return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
    }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr = in_addr(s_addr: in_addr_t(0x7F00_0001).bigEndian)
    return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
  }

  private func someoneListens(_ address: String, _ port: Int) -> Bool {
    let fd = socket(address.contains(":") ? AF_INET6 : AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { return false }
    defer { Darwin.close(fd) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var wait = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
    return withAddress(address, port) { Darwin.connect(fd, $0, $1) } == 0
  }

  private func bind(_ address: String, _ port: Int) -> Result<Int32, POSIXErrorBox> {
    if someoneListens(address, port) { return .failure(POSIXErrorBox(code: EADDRINUSE)) }
    let v6 = address.contains(":")
    let fd = socket(v6 ? AF_INET6 : AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { return .failure(POSIXErrorBox(code: errno)) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
    if v6 { setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &on, socklen_t(MemoryLayout<Int32>.size)) }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    let result = withAddress(address, port) { Darwin.bind(fd, $0, $1) }
    if result != 0 || Darwin.listen(fd, 16) != 0 {
      let code = errno
      Darwin.close(fd)
      return .failure(POSIXErrorBox(code: code))
    }
    return .success(fd)
  }

  private func stopLocked(_ id: String, keeping winner: ObjectIdentifier? = nil) {
    guard let session = sessions.removeValue(forKey: id) else { return }
    session.deadline?.cancel()
    for source in session.accepting { source.cancel() }
    session.accepting.removeAll()
    session.sockets.removeAll()
    for (key, connection) in session.connections where key != winner { drop(connection) }
    session.connections.removeAll()
    for (key, connection) in draining where connection.owner == id && key != winner {
      draining.removeValue(forKey: key)
      drop(connection)
    }
  }

  private func drop(_ connection: Connection) {
    if let source = connection.source {
      connection.source = nil
      source.cancel()
    } else {
      Darwin.close(connection.fd)
    }
  }

  private func accept(_ session: Session, _ listener: Int32) {
    while true {
      let fd = Darwin.accept(listener, nil, nil)
      guard fd >= 0 else { return }
      guard sessions[session.id] === session, session.connections.count + drainingCount(session.id) < Self.maxConnections else {
        Darwin.close(fd)
        continue
      }
      var on: Int32 = 1
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
      _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
      let connection = Connection(fd: fd, owner: session.id)
      session.connections[connection.key] = connection
      let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
      connection.source = source
      source.setEventHandler { [weak self, weak session, weak connection] in
        guard let self, let connection else { return }
        self.readable(session, connection)
      }
      source.setCancelHandler { Darwin.close(fd) }
      source.resume()
      queue.asyncAfter(deadline: .now() + Self.readDeadline) { [weak self, weak session, weak connection] in
        guard let self, let connection, !connection.answered else { return }
        session?.connections.removeValue(forKey: connection.key)
        self.drop(connection)
      }
    }
  }

  private func drainingCount(_ owner: String) -> Int { draining.values.reduce(0) { $0 + ($1.owner == owner ? 1 : 0) } }

  private func readable(_ session: Session?, _ connection: Connection) {
    var chunk = [UInt8](repeating: 0, count: 4096)
    let n = Darwin.read(connection.fd, &chunk, chunk.count)
    if n < 0, errno == EAGAIN || errno == EINTR { return }
    if connection.answered {
      if n <= 0 { finishDrain(connection) }
      return
    }
    guard n > 0, let session, sessions[session.id] === session else {
      session?.connections.removeValue(forKey: connection.key)
      return drop(connection)
    }
    connection.buffer.append(contentsOf: chunk[0..<n])
    let verdict = PluginSignInRequest.verdict(connection.buffer, expecting: session.expectation)
    if verdict == .incomplete { return }
    respond(connection, verdict)
    session.connections.removeValue(forKey: connection.key)
    if case .caught(let target) = verdict {
      stopLocked(session.id, keeping: connection.key)
      caught(session.id, target)
    }
  }

  private func respond(_ connection: Connection, _ verdict: PluginSignInVerdict) {
    connection.answered = true
    connection.buffer = Data()
    let bytes = [UInt8](PluginSignInRequest.response(verdict))
    _ = bytes.withUnsafeBufferPointer { Darwin.write(connection.fd, $0.baseAddress, $0.count) }
    draining[connection.key] = connection
    queue.asyncAfter(deadline: .now() + Self.drainDeadline) { [weak self, weak connection] in
      guard let self, let connection else { return }
      self.finishDrain(connection)
    }
  }

  private func finishDrain(_ connection: Connection) {
    guard draining.removeValue(forKey: connection.key) != nil else { return }
    drop(connection)
  }
}
