import Foundation
import os

final class ApplePasswordsClient: @unchecked Sendable {
  static let shared = ApplePasswordsClient()
  static let hostName = "com.apple.passwordmanager"
  static let origin = "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj/"
  static let browserName = "Ardia"
  static let manifestFolders = ["/Library/Google/Chrome/NativeMessagingHosts", "/System/Cryptexes/App/Library/Google/Chrome/NativeMessagingHosts"]
  static let fakeHelperKey = "applePasswordsManifest"
  static let helloSeconds: TimeInterval = 5
  static let pairingSeconds: TimeInterval = 15
  static let exitGraceSeconds: TimeInterval = 1
  static let endedPushes: Set<Int> = [9, 10]
  static let changed = Notification.Name("ArdiaApplePasswordsChanged")
  private static let log = Logger(subsystem: "com.ardia.browser", category: "ApplePasswords")

  enum Outcome: String {
    case awaitingCode, paired, wrongCode, failed, refused, helperMissing, tooOld, notEntitled
  }

  private struct Awaiting {
    let cmd: Int
    let also: Int?
    let generation: UUID
    var done: ((Result<[String: Any], Error>) -> Void)?
    var deadline: DispatchSourceTimer?
  }

  static let owedSeconds: TimeInterval = 30
  private static let deadlineLeeway = DispatchTimeInterval.milliseconds(100)
  private static let lastRequestId = Int(Int32.max)

  private let queue = DispatchQueue(label: "ardia.apple-passwords", qos: .userInitiated)
  private var pipe: ApplePasswordsPipe?
  private var generation = UUID()
  private var killed = false
  private var base64 = true
  private var fillsCodes = false
  private var pending: (srp: ApplePasswordsSRP, reply: String, generation: UUID)?
  private var session: ApplePasswordsSRP?
  private var lastState: String?
  private var awaiting: [Int: Awaiting] = [:]
  private var requestId = 0
  private var pairingSteps: [(@escaping () -> Void) -> Void] = []
  private var pairingBusy = false

  static var fakeManifest: String? {
    #if DEBUG
      return LaunchConfig.shared.testValue(fakeHelperKey)
    #else
      return nil
    #endif
  }

  private static var macOSSupported: Bool {
    ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 15, minorVersion: 4, patchVersion: 0))
  }

  private static var manifests: [String] {
    if let fake = fakeManifest { return [fake] }
    return manifestFolders.map { "\($0)/\(hostName).json" }
  }

  static var helper: URL? {
    for file in manifests {
      guard let data = FileManager.default.contents(atPath: file),
        let manifest = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        manifest["name"] as? String == hostName, manifest["type"] as? String == "stdio",
        (manifest["allowed_origins"] as? [String] ?? []).contains(origin),
        let path = manifest["path"] as? String, path.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: path)
      else { continue }
      return URL(fileURLWithPath: path)
    }
    return nil
  }

  private func barrier() -> Outcome? {
    if !WebKitHub.passkeysEntitled && Self.fakeManifest == nil { return .notEntitled }
    if !Self.macOSSupported { return .tooOld }
    if killed { return .refused }
    if pipe == nil && Self.helper == nil { return .helperMissing }
    return nil
  }

  private var state: String {
    if let barrier = barrier() { return barrier.rawValue }
    return session != nil ? "connected" : "notConnected"
  }

  func status(_ done: @escaping (String) -> Void) {
    queue.async { done(self.state) }
  }

  func beginPairing(_ done: @escaping (Outcome) -> Void) {
    pairingStep { next in
      self.showCode { outcome in
        self.announce()
        done(outcome)
        next()
      }
    }
  }

  func finishPairing(code: String, _ done: @escaping (Outcome) -> Void) {
    pairingStep { next in
      self.checkCode(code) { outcome in
        let finish = { (outcome: Outcome) in
          self.announce()
          done(outcome)
          next()
        }
        guard outcome == .wrongCode else { return finish(outcome) }
        self.showCode { shown in finish(shown == .awaitingCode ? .wrongCode : .failed) }
      }
    }
  }

  func cancelPairing(_ done: @escaping () -> Void) {
    pairingStep { next in
      self.pending = nil
      try? self.pipe?.write(["cmd": 19])
      done()
      next()
    }
  }

  private func pairingStep(_ step: @escaping (_ next: @escaping () -> Void) -> Void) {
    queue.async {
      self.pairingSteps.append(step)
      self.nextPairingStep()
    }
  }

  private func nextPairingStep() {
    guard !pairingBusy, !pairingSteps.isEmpty else { return }
    pairingBusy = true
    let step = pairingSteps.removeFirst()
    step {
      self.pairingBusy = false
      self.nextPairingStep()
    }
  }

  private func announce() {
    let now = state
    guard now != lastState else { return }
    lastState = now
    NotificationCenter.default.post(name: Self.changed, object: nil, userInfo: ["state": now])
    ArdiaEvents.emit("passwords.applePasswordsChanged", data: ArdiaConsentStamp.begin().onto(["state": now]))
  }

  private func running() throws -> ApplePasswordsPipe {
    if let stale = pipe, stale.hasEnded {
      ended(generation, killedByMacOS: stale.killedByMacOS)
      if killed { throw Failure.ended }
    }
    if let pipe, !pipe.hasEnded { return pipe }
    guard let program = Self.helper else { throw Failure.missing }
    let started = ApplePasswordsPipe(program: program, origin: Self.origin)
    let id = UUID()
    started.onMessage = { [weak self] message in self?.queue.async { self?.heard(message, from: id) } }
    started.onExit = { [weak self, weak started] in
      let killed = started?.killedByMacOS ?? false
      self?.queue.async { self?.ended(id, killedByMacOS: killed) }
    }
    try started.start()
    generation = id
    pipe = started
    Self.log.notice("helper started")
    return started
  }

  private func ended(_ id: UUID, killedByMacOS: Bool) {
    guard generation == id else { return }
    if killedByMacOS {
      killed = true
      Self.log.error("helper killed by macOS at launch")
    }
    pipe = nil
    let gone = awaiting.filter { $0.value.generation == id }
    awaiting = awaiting.filter { $0.value.generation != id }
    gone.values.forEach { $0.deadline?.cancel() }
    gone.keys.sorted().forEach { gone[$0]?.done?(.failure(Failure.ended)) }
    drop(id, why: "exit")
  }

  private func drop(_ id: UUID, why: String) {
    guard generation == id else { return }
    Self.log.notice("session over: \(why, privacy: .public)")
    session = nil
    pending = nil
    announce()
  }

  private enum Failure: Error { case missing, ended, timedOut, unexpected }

  private func heard(_ message: [String: Any], from id: UUID) {
    guard let got = message["cmd"] as? Int else { return }
    if Self.endedPushes.contains(got) { return drop(id, why: "push \(got)") }
    let accepts = { (entry: Awaiting) in entry.generation == id && (entry.cmd == got || entry.also == got) }
    let request: Int?
    if let tabId = message["tabId"] as? Int, tabId > 0 {
      request = awaiting[tabId].flatMap { accepts($0) ? tabId : nil }
    } else {
      request = awaiting.filter { accepts($0.value) }.keys.min()
    }
    guard let request, let entry = settle(request) else { return }
    entry.done?(.success(message))
  }

  private func nextRequestId() -> Int {
    repeat { requestId = requestId >= Self.lastRequestId ? 1 : requestId + 1 } while awaiting[requestId] != nil
    return requestId
  }

  private func exchange(
    _ message: [String: Any], cmd: Int, also: Int? = nil, wait: TimeInterval, keepsHelper: Bool = false, _ done: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    let pipe: ApplePasswordsPipe
    do { pipe = try running() } catch { return done(.failure(error)) }
    let id = nextRequestId()
    var sent = message
    if sent["tabId"] != nil {
      sent["tabId"] = id
      sent["frameId"] = 0
    }
    awaiting[id] = Awaiting(cmd: cmd, also: also, generation: generation, done: done)
    arm(id, after: wait) { [weak self] in self?.expire(id, pipe: pipe, keepsHelper: keepsHelper) }
    do {
      try pipe.write(sent)
    } catch {
      Self.log.notice("cmd \(cmd, privacy: .public) not written; its exit or deadline answers it")
    }
  }

  private func arm(_ id: Int, after seconds: TimeInterval, _ fire: @escaping () -> Void) {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + seconds, leeway: Self.deadlineLeeway)
    timer.setEventHandler(handler: fire)
    awaiting[id]?.deadline?.cancel()
    awaiting[id]?.deadline = timer
    timer.resume()
  }

  private func settle(_ id: Int) -> Awaiting? {
    let entry = awaiting.removeValue(forKey: id)
    entry?.deadline?.cancel()
    return entry
  }

  private func expire(_ id: Int, pipe: ApplePasswordsPipe, keepsHelper: Bool) {
    guard let entry = awaiting[id], let done = entry.done else { return }
    guard keepsHelper else {
      _ = settle(id)
      pipe.stop()
      return done(.failure(Failure.timedOut))
    }
    if entry.cmd == Self.saveCmd {
      _ = settle(id)
    } else {
      awaiting[id]?.done = nil
      arm(id, after: Self.owedSeconds) { [weak self] in _ = self?.settle(id) }
    }
    Self.log.notice("no answer to cmd \(entry.cmd, privacy: .public) in time, helper kept")
    done(.failure(Failure.timedOut))
  }

  private func failure(_ error: Error) -> Outcome {
    if case Failure.missing = error { return .helperMissing }
    return killed ? .refused : .failed
  }

  private func showCode(_ done: @escaping (Outcome) -> Void) {
    if let barrier = barrier() { return done(barrier) }
    pending = nil
    exchange(["cmd": 14], cmd: 14, wait: Self.helloSeconds) { result in
      let hello: [String: Any]
      switch result {
      case .success(let reply): hello = reply
      case .failure(let error): return done(self.failure(error))
      }
      let capabilities = hello["capabilities"] as? [String: Any]
      self.base64 = capabilities?["shouldUseBase64"] as? Bool ?? true
      self.fillsCodes = capabilities?["canFillOneTimeCodes"] as? Bool ?? false
      let srp = ApplePasswordsSRP(base64: self.base64)
      guard let m0 = try? Self.text(["QID": "m0", "PAKE": srp.first, "HSTBRSR": Self.browserName]) else { return done(.failed) }
      self.exchange(["cmd": 2, "msg": m0], cmd: 2, wait: Self.pairingSeconds) { result in
        let reply: [String: Any]
        switch result {
        case .success(let answer): reply = answer
        case .failure(let error): return done(self.failure(error))
        }
        guard let payload = reply["payload"] as? [String: Any], payload["QID"] as? String == "m0", let pake = payload["PAKE"] as? String else {
          return done(self.failure(Failure.unexpected))
        }
        self.pending = (srp, pake, self.generation)
        Self.log.notice("code shown by Passwords")
        done(.awaitingCode)
      }
    }
  }

  private func checkCode(_ code: String, _ done: @escaping (Outcome) -> Void) {
    if let barrier = barrier() { return done(barrier) }
    guard let waiting = pending, waiting.generation == generation else { return done(.failed) }
    pending = nil
    var srp = waiting.srp
    let m2: String
    do {
      m2 = try Self.text(["QID": "m2", "PAKE": try srp.second(after: waiting.reply, code: code)])
    } catch {
      return done(Self.pairingOutcome(error) ?? failure(error))
    }
    exchange(["cmd": 2, "msg": m2], cmd: 2, wait: Self.pairingSeconds) { result in
      let reply: [String: Any]
      switch result {
      case .success(let answer): reply = answer
      case .failure(let error): return done(self.failure(error))
      }
      guard waiting.generation == self.generation, let pake = (reply["payload"] as? [String: Any])?["PAKE"] as? String else {
        return done(self.failure(Failure.unexpected))
      }
      do {
        try srp.third(pake)
      } catch {
        return done(Self.pairingOutcome(error) ?? self.failure(error))
      }
      self.session = srp
      Self.log.notice("paired")
      done(.paired)
    }
  }

  private static func pairingOutcome(_ error: Error) -> Outcome? {
    switch error {
    case ApplePasswordsSRP.Failure.wrongCode:
      log.notice("pairing code refused")
      return .wrongCode
    case ApplePasswordsSRP.Failure.refused: return .refused
    default: return nil
    }
  }

  enum Problem: Error, Equatable {
    case unavailable(Outcome)
    case notConnected
    case refused
    case timedOut
    case unreadable

    var kind: String {
      switch self {
      case .notConnected: "notPaired"
      case .unavailable(.helperMissing): "helperMissing"
      case .unavailable, .refused: "refused"
      case .timedOut: "timedOut"
      case .unreadable: "unreadable"
      }
    }
  }

  static let saveCmd = 6
  static let saveSeconds: TimeInterval = 120
  static let alreadyKeptStatus = 7
  static let listSeconds: TimeInterval = 10
  static let passwordSeconds: TimeInterval = 120
  static let successStatuses: Set<Int> = [0, 3]
  static let sessionOverStatus = 9

  func logins(host: String, _ done: @escaping (Result<[ApplePasswordsEntry], Problem>) -> Void) {
    queue.async {
      self.sealed(4, qid: "CmdGetLoginNames4URL", url: host, ["ACT": 5, "URL": host], wait: Self.listSeconds) { result in
        done(result.map(ApplePasswordsReply.entries).mapError(Self.problem))
      }
    }
  }

  func password(host: String, user: String, _ done: @escaping (Result<String, Problem>) -> Void) {
    queue.async {
      self.sealed(5, qid: "CmdGetPassword4LoginName", url: host, ["ACT": 2, "URL": host, "USR": user], wait: Self.passwordSeconds) { result in
        done(result.mapError(Self.problem).flatMap { answer in
          ApplePasswordsReply.password(answer, host: host, user: user).map { .success($0) } ?? .failure(.unreadable)
        })
      }
    }
  }

  static let codesSeconds: TimeInterval = 10
  static let codeSeconds: TimeInterval = 120

  func codes(page: String, _ done: @escaping (Result<[ApplePasswordsCode], Problem>) -> Void) {
    queue.async {
      if self.session != nil, !self.fillsCodes { return done(.success([])) }
      self.sealed(16, qid: "CmdGetOneTimeCodes", url: nil, ["ACT": 5, "TYPE": "oneTimeCodes", "frameURLs": [page]], wait: Self.codesSeconds) { result in
        done(result.map(ApplePasswordsReply.codes).mapError(Self.problem))
      }
    }
  }

  func code(page: String, user: String, _ done: @escaping (Result<[ApplePasswordsCode], Problem>) -> Void) {
    queue.async {
      guard self.session == nil || self.fillsCodes else { return done(.failure(.refused)) }
      let body: [String: Any] = ["ACT": 2, "TYPE": "oneTimeCodes", "frameURLs": [page], "username": user]
      self.sealed(17, qid: "CmdDidFillOneTimeCode", url: nil, body, wait: Self.codeSeconds) { result in
        done(result.map(ApplePasswordsReply.codes).mapError(Self.problem))
      }
    }
  }

  static func savedSite(host: String, insecure: Bool) -> String { insecure ? "http://\(host)" : host }

  func save(host: String, insecure: Bool, user: String, password: String, update: Bool, _ done: @escaping (Result<Void, Problem>) -> Void) {
    queue.async {
      let body: [String: Any] = ["ACT": 4, "URL": "", "USR": "", "PWD": "", "NURL": Self.savedSite(host: host, insecure: insecure), "NUSR": user, "NPWD": password]
      self.sealed(Self.saveCmd, qid: "CmdSetPassword4LoginName_URL", url: nil, body, wait: Self.saveSeconds, also: 4, kept: [Self.alreadyKeptStatus]) { result in
        guard case .failure(Failure.unexpected) = result else { return done(result.map { _ in () }.mapError(Self.problem)) }
        guard !update else {
          Self.log.notice("update had no readable answer, not saved")
          return done(.failure(.unreadable))
        }
        Self.log.notice("save had no readable answer, reading the list")
        self.sealed(4, qid: "CmdGetLoginNames4URL", url: host, ["ACT": 5, "URL": host], wait: Self.listSeconds) { listed in
          done(listed.mapError(Self.problem).flatMap { answer in
            ApplePasswordsReply.entries(answer).contains { $0.user == user } ? .success(()) : .failure(.unreadable)
          })
        }
      }
    }
  }

  private static func problem(_ error: Error) -> Problem { error as? Problem ?? .unreadable }


  private func sealed(
    _ cmd: Int, qid: String, url: String?, _ body: [String: Any], wait: TimeInterval, also: Int? = nil, kept: Set<Int> = [],
    _ done: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    if let barrier = barrier() { return done(.failure(Problem.unavailable(barrier))) }
    guard let session, pipe?.hasEnded == false else { return done(.failure(Problem.notConnected)) }
    let id = generation
    let message: [String: Any]
    do {
      let payload = try Self.text(["QID": qid, "SMSG": try session.seal(body)])
      message = ["cmd": cmd, "tabId": 0, "frameId": 0, "payload": payload].merging(url.map { ["url": $0] } ?? [:]) { first, _ in first }
    } catch {
      return done(.failure(Problem.unreadable))
    }
    exchange(message, cmd: cmd, also: also, wait: wait, keepsHelper: true) { result in
      let reply: [String: Any]
      switch result {
      case .success(let answer): reply = answer
      case .failure:
        if self.killed { return done(.failure(Problem.unavailable(.refused))) }
        return done(.failure(self.generation == id && self.session != nil ? Problem.timedOut : Problem.notConnected))
      }
      guard let answer = session.open(ApplePasswordsSRP.object(reply["payload"])?["SMSG"]) else { return done(.failure(Failure.unexpected)) }
      let status = answer["STATUS"] as? Int ?? 1
      if status == Self.sessionOverStatus {
        self.drop(id, why: "status \(status)")
        return done(.failure(Problem.notConnected))
      }
      guard Self.successStatuses.contains(status) || kept.contains(status) else {
        Self.log.notice("request \(cmd, privacy: .public) refused with status \(status, privacy: .public)")
        return done(.failure(Problem.refused))
      }
      done(.success(answer))
    }
  }

  private static func text(_ object: [String: Any]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }
}
