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

  private func exchange(_ message: [String: Any], cmd: Int, wait: TimeInterval) throws -> [String: Any] {
    let pipe = try running()
    try pipe.write(message)
    let deadline = Date().addingTimeInterval(wait)
    while let reply = pipe.next(until: deadline) {
      if reply["cmd"] as? Int == cmd { return reply }
    }
    if pipe.hasEnded { throw Failure.ended }
    pipe.stop()
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

  private static func text(_ object: [String: Any]) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }
}
