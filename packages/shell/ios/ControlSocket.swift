import AppKit
import ArdiaCore
import Darwin
import Foundation

final class ControlSocket {
  static let shared = ControlSocket()
  static let socketName = "ArdiaControl.sock"
  static let lockName = "ArdiaControl.sock.lock"
  static let maxConnections = 16
  static let maxPathBytes = 103
  static let acceptsPerCallback = 8
  static let maxResolving = 8
  static let resolveDeadline: TimeInterval = 10
  static let doorbellKey = "peer-doorbell-"
  static let endpointDeadline: TimeInterval = 5

  typealias Sink = (_ name: String, _ body: [String: Any]) -> Void

  private let queue = DispatchQueue(label: "ardia.control", qos: .userInitiated)
  private var sink: (owner: ObjectIdentifier, send: Sink)?
  private var listenFd: Int32 = -1
  private var lockFd: Int32 = -1
  private var folderFd: Int32 = -1
  private var acceptSource: DispatchSourceRead?
  private var bound: (path: String, device: dev_t, inode: ino_t)?
  private var connections: [Int: ControlConnection] = [:]
  private var peerFinished = Set<Int>()
  private var nextConnection = 0
  private var generation = 0
  private var quitObserver: NSObjectProtocol?
  private var resolving: [Int: Int32] = [:]
  private var approvalKeys: [Int: String] = [:]
  private let resolver = DispatchQueue(label: "ardia.control.peers", qos: .userInitiated, attributes: .concurrent)
  private var resolverJobs = 0
  private var expiries: [String: DispatchWorkItem] = [:]
  private var approvedUntil: [Int: Date] = [:]
  private let cutOffLock = NSLock()
  private var cutOffFlag = false
  private lazy var doorbell = ControlDoorbell(
    queue: queue,
    capacity: { [weak self] in self.map { Self.maxConnections - $0.connections.count } ?? 0 },
    dismiss: { id in DispatchQueue.main.async { DialogsModule.dismissShownOnly(key: "\(Self.doorbellKey)\(id)") } },
    open: { [weak self] connection, fd, key, until in self?.open(connection, fd: fd, key: key, until: until) ?? false },
    send: { [weak self] name, body in
      guard let sink = self?.sink else { return false }
      sink.send(name, body)
      return true
    })
  private lazy var policy = ControlPeerPolicy(
    ownTeam: ControlPeerPolicy.ownTeam(of: ControlPeer.resolveSelf()),
    sameUserIsEnough: LaunchConfig.shared.testInstance && !LaunchConfig.shared.testFlag("controlDoorbell"))

  func attach(_ owner: AnyObject, send: @escaping Sink) {
    let id = ObjectIdentifier(owner)
    queue.sync {
      if let previous = sink, previous.owner != id { doorbell.stop() }
      sink = (id, send)
    }
    if quitObserver == nil {
      quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { [weak self] _ in
        self?.queue.sync { self?.stopOnQueue() }
      }
    }
  }

  func detach(_ owner: AnyObject) {
    let id = ObjectIdentifier(owner)
    queue.async { [self] in
      guard sink?.owner == id else { return }
      sink = nil
      stopOnQueue()
    }
  }

  func start(_ done: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in done(startOnQueue()) }
  }

  func stop(_ done: @escaping () -> Void) {
    queue.async { [self] in
      stopOnQueue()
      done()
    }
  }

  private var isCutOff: Bool {
    cutOffLock.lock()
    defer { cutOffLock.unlock() }
    return cutOffFlag
  }

  private func setCutOff(_ on: Bool) {
    cutOffLock.lock()
    cutOffFlag = on
    cutOffLock.unlock()
  }

  func cutOff() -> Bool {
    setCutOff(true)
    queue.async { [self] in
      if isCutOff { for connection in Array(connections.values) { connection.retire() } }
    }
    return true
  }

  private func mayWrite(_ connection: ControlConnection) -> Bool {
    guard !isCutOff else {
      connection.retire()
      return false
    }
    return stillApproved(connection)
  }

  func reply(_ connection: Int, _ line: String, ticket: Int) {
    let data = Self.framed(line)
    queue.async { [self] in
      if !isCutOff, let target = connections[connection], stillApproved(target) {
        target.reply(data, ticket: ticket)
      } else if ticket > 0 {
        sink?.send("onWritten", ["tickets": [ticket]])
      }
    }
  }

  func devtoolsEndpoint(_ connection: Int, _ done: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      guard admits(connection) else { return done(["problem": "left"]) }
      DispatchQueue.main.async { [weak self] in
        ArdiaEngineBridge.callForSecretReply(DevtoolsEndpoint.engineCall, profile: "", timeout: Self.endpointDeadline) { reply in
          self?.answerEndpoint(connection, done) { reply.map(DevtoolsEndpoint.read(engineReply:)) ?? .failure(.unreadable) }
        }
      }
    }
  }

  private func answerEndpoint(_ connection: Int, _ done: @escaping ([String: Any]) -> Void, _ read: @escaping () -> Result<DevtoolsEndpoint, DevtoolsEndpoint.Problem>) {
    queue.async { [self] in
      guard admits(connection) else { return done(["problem": "left"]) }
      let result = read()
      guard admits(connection) else { return done(["problem": "left"]) }
      switch result {
      case let .success(endpoint): done(endpoint.reply)
      case let .failure(problem): done(["problem": problem.rawValue])
      }
    }
  }

  private func admits(_ connection: Int) -> Bool {
    guard !isCutOff, bound != nil, !peerFinished.contains(connection), let target = connections[connection] else { return false }
    return stillApproved(target)
  }

  func broadcast(_ targets: [Int], _ line: String) {
    let data = Self.framed(line)
    let kept = data.starts(with: Self.decidePrefix)
    queue.async { [self] in
      for id in targets {
        guard let target = connections[id], stillApproved(target) else { continue }
        if kept { target.send(data) } else { target.event(data) }
      }
    }
  }

  func answerPeer(_ ask: Int, _ outcome: String, _ done: @escaping (Bool) -> Void) {
    queue.async { [self] in
      guard let outcome = ControlDoorbell.Outcome(rawValue: outcome) else { return done(false) }
      done(doorbell.answer(ask, outcome, approvals: approvalStore()))
    }
  }

  func approvals(_ done: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      guard let store = approvalStore() else { return done(["approvals": [], "problem": "Ardia has no data folder."]) }
      let list = store.load().map(\.dictionary)
      var out: [String: Any] = ["approvals": list, "doorbell": !policy.sameUserIsEnough]
      if let problem = store.problem { out["problem"] = problem }
      done(out)
    }
  }

  func revokeApproval(_ key: String, _ done: @escaping (Bool) -> Void) {
    queue.async { [self] in
      let removed = approvalStore()?.revoke(key) ?? false
      retireApproved { $0 == key }
      done(removed)
    }
  }

  private func approvalStore() -> ControlApprovals? {
    guard let dir = try? DocumentStore.url(Self.socketName).deletingLastPathComponent().path else { return nil }
    return ControlApprovals(directory: dir)
  }

  private func retireApproved(_ matches: (String) -> Bool) {
    for (id, key) in approvalKeys where matches(key) {
      connections[id]?.retire()
    }
  }

  private func stillApproved(_ connection: ControlConnection) -> Bool {
    guard let until = approvedUntil[connection.id], until <= Date(), let key = approvalKeys[connection.id] else { return true }
    let now = Date()
    if let live = approvalStore()?.load(now: now).first(where: { $0.key == key && $0.live(at: now) }) {
      approvedUntil[connection.id] = live.until.map { Date(timeIntervalSince1970: $0) }
      return true
    }
    connection.retire()
    return false
  }

  private func expire(_ key: String, at until: Date) {
    guard expiries[key] == nil else { return }
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.expiries[key] = nil
      let now = Date()
      let live = self.approvalStore()?.load(now: now).first { $0.key == key && $0.live(at: now) }
      if let live {
        if let later = live.until { self.expire(key, at: Date(timeIntervalSince1970: later)) }
        return
      }
      self.retireApproved { $0 == key }
    }
    expiries[key] = item
    queue.asyncAfter(wallDeadline: .now() + max(0, until.timeIntervalSinceNow), execute: item)
  }

  private static let decidePrefix = Data("{\"decide\":".utf8)

  private static func framed(_ line: String) -> Data {
    var data = Data(line.utf8)
    data.append(10)
    return data
  }

  private func status(_ state: String, reason: String? = nil, path: String = "") -> [String: Any] {
    var status: [String: Any] = ["state": state, "generation": generation, "path": path]
    if let reason { status["reason"] = reason }
    return status
  }

  private func refuse(_ reason: String, path: String = "") -> [String: Any] {
    NSLog("[control] the ardia command's socket didn't start: %@", reason)
    return status("off", reason: reason, path: path)
  }

  private func startOnQueue() -> [String: Any] {
    setCutOff(false)
    if let bound { return status("on", path: bound.path) }
    let dir: String
    do {
      dir = try DocumentStore.url(Self.socketName).deletingLastPathComponent().path
    } catch {
      return refuse("Ardia has no data folder.")
    }
    let path = (dir as NSString).appendingPathComponent(Self.socketName)
    guard path.utf8.count <= Self.maxPathBytes else {
      return refuse("The socket path is longer than \(Self.maxPathBytes) bytes: \(path)", path: path)
    }
    let folder = PrivateFolder.openFolder(dir)
    guard folder.fd >= 0 else { return refuse(folder.problem ?? "Couldn't open the data folder.", path: path) }
    var keepFolder = false
    defer { if !keepFolder { Darwin.close(folder.fd) } }
    if let problem = PrivateFolder.ancestorProblem(folder.fd) { return refuse(problem, path: path) }
    let lock = openat(folder.fd, Self.lockName, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard lock >= 0 else { return refuse("Couldn't open the socket's lock file (\(Self.errnoText())).", path: path) }
    guard PrivateFolder.onlyOwnerCanRead(lock), flock(lock, LOCK_EX | LOCK_NB) == 0 else {
      Darwin.close(lock)
      return refuse("Another Ardia is serving this data folder, or its lock file isn't yours alone.", path: path)
    }
    var old = stat()
    if fstatat(folder.fd, Self.socketName, &old, AT_SYMLINK_NOFOLLOW) == 0 {
      guard (old.st_mode & S_IFMT) == S_IFSOCK else {
        Darwin.close(lock)
        return refuse("\(path) exists and isn't a socket, so it was left alone.", path: path)
      }
      unlinkat(folder.fd, Self.socketName, 0)
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
      Darwin.close(lock)
      return refuse("Couldn't make a socket (\(Self.errnoText())).", path: path)
    }
    Self.prepare(fd)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      let bytes = Array(path.utf8)
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let previousMask = umask(0o177)
    let bindResult = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    umask(previousMask)
    var made = stat()
    var atPath = stat()
    guard bindResult == 0, listen(fd, Int32(Self.maxConnections)) == 0, fstatat(folder.fd, Self.socketName, &made, AT_SYMLINK_NOFOLLOW) == 0 else {
      let text = Self.errnoText()
      Darwin.close(fd)
      Darwin.close(lock)
      return refuse("Couldn't listen on \(path) (\(text)).", path: path)
    }
    guard (made.st_mode & S_IFMT) == S_IFSOCK, lstat(path, &atPath) == 0, atPath.st_dev == made.st_dev, atPath.st_ino == made.st_ino else {
      Darwin.close(fd)
      Darwin.close(lock)
      return refuse("The data folder \(dir) changed while Ardia was starting its socket, so it didn't start.", path: path)
    }
    generation += 1
    listenFd = fd
    lockFd = lock
    folderFd = folder.fd
    keepFolder = true
    bound = (path, made.st_dev, made.st_ino)
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in self?.acceptAll() }
    source.setCancelHandler { Darwin.close(fd) }
    acceptSource = source
    source.activate()
    return status("on", path: path)
  }

  private func stopOnQueue() {
    guard let bound else { return }
    self.bound = nil
    for connection in Array(connections.values) { connection.retire() }
    connections.removeAll()
    peerFinished.removeAll()
    approvalKeys.removeAll()
    approvedUntil.removeAll()
    for item in expiries.values { item.cancel() }
    expiries.removeAll()
    for fd in resolving.values { Darwin.close(fd) }
    resolving.removeAll()
    doorbell.stop()
    acceptSource?.cancel()
    acceptSource = nil
    listenFd = -1
    var now = stat()
    if fstatat(folderFd, Self.socketName, &now, AT_SYMLINK_NOFOLLOW) == 0, (now.st_mode & S_IFMT) == S_IFSOCK, now.st_dev == bound.device, now.st_ino == bound.inode {
      unlinkat(folderFd, Self.socketName, 0)
    }
    Darwin.close(lockFd)
    lockFd = -1
    Darwin.close(folderFd)
    folderFd = -1
  }

  private func acceptAll() {
    for _ in 0..<Self.acceptsPerCallback where bound != nil {
      let fd = accept(listenFd, nil, nil)
      if fd < 0 { return }
      var uid: uid_t = 0
      var gid: gid_t = 0
      guard getpeereid(fd, &uid, &gid) == 0, uid == geteuid(), connections.count < Self.maxConnections, resolverJobs < Self.maxResolving,
        let token = ControlPeer.auditToken(of: fd)
      else {
        Darwin.close(fd)
        continue
      }
      Self.prepare(fd)
      nextConnection += 1
      let id = nextConnection
      if policy.sameUserIsEnough {
        _ = open(id, fd: fd, key: nil, until: nil)
        continue
      }
      resolving[id] = fd
      resolverJobs += 1
      let generation = generation
      resolver.async { [weak self] in
        let peer = ControlPeer.resolve(token)
        self?.queue.async {
          self?.resolverJobs -= 1
          self?.resolved(id, peer, token, generation)
        }
      }
      queue.asyncAfter(deadline: .now() + Self.resolveDeadline) { [weak self] in
        guard let fd = self?.resolving.removeValue(forKey: id) else { return }
        NSLog("[control] gave up on identifying a program after %.0f s", Self.resolveDeadline)
        ControlDoorbell.refuse(fd, .full)
      }
    }
  }

  private func resolved(_ id: Int, _ peer: ControlPeer, _ token: audit_token_t, _ generation: Int) {
    guard let fd = resolving.removeValue(forKey: id) else { return }
    guard bound != nil, generation == self.generation else {
      Darwin.close(fd)
      return
    }
    let store = approvalStore()
    let now = Date()
    let approvals = store?.load(now: now) ?? []
    switch policy.verdict(peer, approvals: approvals, now: now) {
    case .ardia, .sameUser:
      if !open(id, fd: fd, key: nil, until: nil) { ControlDoorbell.refuse(fd, .full) }
    case let .approved(key):
      let until = approvals.first { $0.key == key }?.until.map { Date(timeIntervalSince1970: $0) }
      if !open(id, fd: fd, key: key, until: until) { ControlDoorbell.refuse(fd, .full) }
    case let .ask(key):
      NSLog("[control] asking whether %@ (%@) may control Ardia", peer.name, peer.signedBy)
      doorbell.ring(connection: id, fd: fd, peer: peer, key: key, token: token)
    }
  }

  private func open(_ id: Int, fd: Int32, key: String?, until: Date?) -> Bool {
    guard bound != nil, !isCutOff, connections.count < Self.maxConnections else { return false }
    let generation = generation
    let connection = ControlConnection(
      id: id, fd: fd, queue: queue,
      onLine: { [weak self] connection, line in
        guard let self, self.stillApproved(connection) else { return }
        self.sink?.send("onRequest", ["connection": connection.id, "generation": generation, "line": line])
      },
      onClose: { [weak self] connection in
        guard let self, self.connections.removeValue(forKey: connection.id) != nil else { return }
        self.approvalKeys[connection.id] = nil
        self.approvedUntil[connection.id] = nil
        guard self.peerFinished.remove(connection.id) == nil else { return }
        self.sink?.send("onClose", ["connection": connection.id])
      },
      onWritten: { [weak self] tickets in self?.sink?.send("onWritten", ["tickets": tickets]) },
      onPeerFinished: { [weak self] connection in
        guard let self, self.connections[connection.id] != nil, self.peerFinished.insert(connection.id).inserted else { return }
        self.sink?.send("onClose", ["connection": connection.id])
      },
      mayWrite: { [weak self] connection in self?.mayWrite(connection) ?? false })
    connections[id] = connection
    if let key {
      approvalKeys[id] = key
      if let until {
        approvedUntil[id] = until
        expire(key, at: until)
      }
    }
    connection.open()
    return true
  }

  private static func prepare(_ fd: Int32) {
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  }

  private static func errnoText() -> String {
    String(cString: strerror(errno))
  }
}
