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
  private static let log = Logger(subsystem: "com.ardia.browser", category: "ApplePasswords")

  enum Outcome: String {
    case awaitingCode, paired, wrongCode, failed, refused, helperMissing, tooOld, notEntitled
  }

  private let queue = DispatchQueue(label: "ardia.apple-passwords", qos: .userInitiated)
  private var pipe: ApplePasswordsPipe?
  private var generation = UUID()
  private var killed = false
  private var base64 = true
  private var pending: (srp: ApplePasswordsSRP, reply: String, generation: UUID)?
  private var session: ApplePasswordsSRP?
  private var lastState: String?
  private var owed: [Int: Int] = [:]

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
    queue.async {
      let outcome = self.showCode()
      self.announce()
      done(outcome)
    }
  }

  func finishPairing(code: String, _ done: @escaping (Outcome) -> Void) {
    queue.async {
      var outcome = self.checkCode(code)
      if outcome == .wrongCode, self.showCode() != .awaitingCode { outcome = .failed }
      self.announce()
      done(outcome)
    }
  }

  func cancelPairing(_ done: @escaping () -> Void) {
    queue.async {
      self.pending = nil
      try? self.pipe?.write(["cmd": 19])
      done()
    }
  }

  private func announce() {
    let now = state
    guard now != lastState else { return }
    lastState = now
    ArdiaEvents.emit("passwords.applePasswordsChanged", data: ArdiaConsentStamp.begin().onto(["state": now]))
  }

  private func running() throws -> ApplePasswordsPipe {
    if let pipe, !pipe.hasEnded { return pipe }
    guard let program = Self.helper else { throw Failure.missing }
    let started = ApplePasswordsPipe(program: program, origin: Self.origin)
    let id = UUID()
    started.onMessage = { [weak self] message in
      guard let cmd = message["cmd"] as? Int, Self.endedPushes.contains(cmd) else { return }
      self?.queue.async { self?.drop(id, why: "push \(cmd)") }
    }
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
    owed = [:]
    if killedByMacOS {
      killed = true
      Self.log.error("helper killed by macOS at launch")
    }
    pipe = nil
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

  private func exchange(_ message: [String: Any], cmd: Int, also: Int? = nil, wait: TimeInterval, keepsHelper: Bool = false) throws -> [String: Any] {
    let pipe = try running()
    try pipe.write(message)
    let deadline = Date().addingTimeInterval(wait)
    while let reply = pipe.next(until: deadline) {
      guard let got = reply["cmd"] as? Int else { continue }
      if let late = owed[got], late > 0 {
        owed[got] = late - 1
        continue
      }
      if got == cmd || got == also { return reply }
    }
    if pipe.hasEnded { throw Failure.ended }
    guard keepsHelper else {
      pipe.stop()
      throw Failure.timedOut
    }
    if cmd != Self.saveCmd { owed[cmd, default: 0] += 1 }
    throw Failure.timedOut
  }

  private func failure(_ error: Error) -> Outcome {
    if case Failure.missing = error { return .helperMissing }
    if let pipe {
      pipe.waitForExit(until: Date().addingTimeInterval(Self.exitGraceSeconds))
      if pipe.killedByMacOS { killed = true }
    }
    return killed ? .refused : .failed
  }

  private func showCode() -> Outcome {
    if let barrier = barrier() { return barrier }
    pending = nil
    do {
      let hello = try exchange(["cmd": 14], cmd: 14, wait: Self.helloSeconds)
      base64 = (hello["capabilities"] as? [String: Any])?["shouldUseBase64"] as? Bool ?? true
      let srp = ApplePasswordsSRP(base64: base64)
      let m0 = try Self.text(["QID": "m0", "PAKE": srp.first, "HSTBRSR": Self.browserName])
      let reply = try exchange(["cmd": 2, "msg": m0], cmd: 2, wait: Self.pairingSeconds)
      guard let payload = reply["payload"] as? [String: Any], payload["QID"] as? String == "m0", let pake = payload["PAKE"] as? String else {
        throw Failure.unexpected
      }
      pending = (srp, pake, generation)
      Self.log.notice("code shown by Passwords")
      return .awaitingCode
    } catch {
      return failure(error)
    }
  }

  private func checkCode(_ code: String) -> Outcome {
    if let barrier = barrier() { return barrier }
    guard let waiting = pending, waiting.generation == generation else { return .failed }
    pending = nil
    var srp = waiting.srp
    do {
      let m2 = try srp.second(after: waiting.reply, code: code)
      let reply = try exchange(["cmd": 2, "msg": try Self.text(["QID": "m2", "PAKE": m2])], cmd: 2, wait: Self.pairingSeconds)
      guard waiting.generation == generation, let pake = (reply["payload"] as? [String: Any])?["PAKE"] as? String else { throw Failure.unexpected }
      try srp.third(pake)
      session = srp
      Self.log.notice("paired")
      return .paired
    } catch ApplePasswordsSRP.Failure.wrongCode {
      Self.log.notice("pairing code refused")
      return .wrongCode
    } catch ApplePasswordsSRP.Failure.refused {
      return .refused
    } catch {
      return failure(error)
    }
  }

  enum Problem: Error, Equatable {
    case unavailable(Outcome)
    case notConnected
    case refused
    case failed
  }

  static let saveCmd = 6
  static let saveSeconds: TimeInterval = 120
  static let alreadyKeptStatus = 7
  static let listSeconds: TimeInterval = 10
  static let passwordSeconds: TimeInterval = 120
  static let successStatuses: Set<Int> = [0, 3]
  static let sessionOverStatus = 9
  static let placeholderUser = "Passwords\u{a0}not\u{a0}saved"
  static let noPassword = "Not Included"

  func logins(host: String, _ done: @escaping (Result<[ApplePasswordsEntry], Problem>) -> Void) {
    queue.async {
      done(Result {
        let answer = try self.sealed(4, qid: "CmdGetLoginNames4URL", url: host, ["ACT": 5, "URL": host], wait: Self.listSeconds)
        return Self.entries(answer).compactMap { entry in
          guard let user = entry["USR"] as? String, user != Self.placeholderUser else { return nil }
          return ApplePasswordsEntry(user: user, sites: entry["sites"] as? [String] ?? [])
        }
      }.mapError(Self.problem))
    }
  }

  func password(host: String, user: String, _ done: @escaping (Result<String, Problem>) -> Void) {
    queue.async {
      done(Result {
        let answer = try self.sealed(5, qid: "CmdGetPassword4LoginName", url: host, ["ACT": 2, "URL": host, "USR": user], wait: Self.passwordSeconds)
        let entries = Self.entries(answer)
        let entry = entries.first { ($0["sites"] as? [String] ?? []).contains(host) && $0["USR"] as? String == user }
          ?? entries.first { $0["USR"] as? String == user }
        guard let password = entry?["PWD"] as? String, password != Self.noPassword else { throw Problem.failed }
        return password
      }.mapError(Self.problem))
    }
  }

  func save(host: String, user: String, password: String, _ done: @escaping (Result<Void, Problem>) -> Void) {
    queue.async {
      done(Result {
        do {
          _ = try self.sealed(
            Self.saveCmd, qid: "CmdSetPassword4LoginName_URL", url: nil,
            ["ACT": 4, "URL": "", "USR": "", "PWD": "", "NURL": host, "NUSR": user, "NPWD": password],
            wait: Self.saveSeconds, also: 4, kept: [Self.alreadyKeptStatus])
        } catch Failure.unexpected {
          Self.log.notice("save had no readable answer, reading the list")
          let answer = try self.sealed(4, qid: "CmdGetLoginNames4URL", url: host, ["ACT": 5, "URL": host], wait: Self.listSeconds)
          guard Self.entries(answer).contains(where: { $0["USR"] as? String == user }) else { throw Problem.failed }
        }
      }.mapError(Self.problem))
    }
  }

  private static func problem(_ error: Error) -> Problem { error as? Problem ?? .failed }

  private static func entries(_ answer: [String: Any]) -> [[String: Any]] {
    if let list = answer["Entries"] as? [[String: Any]] { return list }
    return answer.keys.filter { $0.hasPrefix("Entry_") }.sorted().compactMap { answer[$0] as? [String: Any] }
  }

  private func sealed(
    _ cmd: Int, qid: String, url: String?, _ body: [String: Any], wait: TimeInterval, also: Int? = nil, kept: Set<Int> = []
  ) throws -> [String: Any] {
    if let barrier = barrier() { throw Problem.unavailable(barrier) }
    guard let session, pipe?.hasEnded == false else { throw Problem.notConnected }
    let id = generation
    let smsg = try session.seal(body)
    let payload = try Self.text(["QID": qid, "SMSG": smsg])
    var message: [String: Any] = ["cmd": cmd, "tabId": 0, "frameId": 0, "payload": payload]
    if let url { message["url"] = url }
    let reply: [String: Any]
    do {
      reply = try exchange(message, cmd: cmd, also: also, wait: wait, keepsHelper: true)
    } catch {
      if killed { throw Problem.unavailable(.refused) }
      throw generation == id && self.session != nil ? Problem.failed : Problem.notConnected
    }
    guard let answer = session.open(ApplePasswordsSRP.object(reply["payload"])?["SMSG"]) else { throw Failure.unexpected }
    let status = answer["STATUS"] as? Int ?? 1
    if status == Self.sessionOverStatus {
      drop(id, why: "status \(status)")
      throw Problem.notConnected
    }
    guard Self.successStatuses.contains(status) || kept.contains(status) else {
      Self.log.notice("request \(cmd, privacy: .public) refused with status \(status, privacy: .public)")
      throw Problem.refused
    }
    return answer
  }

  private static func text(_ object: [String: Any]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }
}
