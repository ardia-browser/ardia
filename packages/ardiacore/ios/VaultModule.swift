import CoreGraphics
import ExpoModulesCore
import Foundation
import LocalAuthentication

public class VaultModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    OnCreate {
      ArdiaWebView.setVerificationCodeKeeper { token, uri, profile, done in VaultModule.keep(token: token, uri: uri, profile: profile, done: done) }
    }

    Self.calls.function
  }

  private static var attempts: [String: () -> Void] = [:]
  private static var pendingKeeps: [String: (origin: String, usernames: [String])] = [:]
  private static let store = VaultStore.shared

  private static func onVault<T>(_ work: @escaping () -> T, then: @escaping (T) -> Void) {
    store.queue.async {
      let value = work()
      DispatchQueue.main.async { then(value) }
    }
  }

  private static func elapsed(since start: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 }

  static func keep(token: String, uri: String, profile: String, done: @escaping (Bool) -> Void) {
    let stamp = ArdiaConsentStamp.begin()
    guard let pending = pendingKeeps.removeValue(forKey: token), let code = VerificationCode(otpauth: uri) else { return done(false) }
    let username = pending.usernames.first { $0.caseInsensitiveCompare(code.account) == .orderedSame } ?? (pending.usernames.count == 1 ? pending.usernames[0] : code.account)
    guard !username.isEmpty else { return done(false) }
    onVault({ store.saveCode(code, profile: profile, origin: pending.origin, username: username) }) { saved in
      done(saved)
      if saved { ArdiaEvents.emit("vault.codeKept", data: stamp.onto(["profile": profile, "origin": pending.origin, "username": username])) }
    }
  }

  private static var prompts: [String: LAContext] = [:]
  private static var fakePrompts = Set<String>()

  private static func authenticate(_ id: String, _ reason: String, _ done: @escaping (Bool, String) -> Void) {
    let config = LaunchConfig.shared
    if config.background {
      let granted = config.testValue("reauth") == "granted"
      if let delay = config.testValue("vaultAuthDelayMs").flatMap(Double.init) {
        fakePrompts.insert(id)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay / 1000) {
          let current = fakePrompts.remove(id) != nil
          done(granted && current, granted && current ? "granted" : current ? "testDenied" : "cancelled")
        }
        return
      }
      NSLog("[vault] device owner check in a hidden test instance, no prompt: %@", granted ? "granted" : "denied")
      return done(granted, granted ? "granted" : "testDenied")
    }
    let context = LAContext()
    var problem: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else { return done(false, "unavailable") }
    prompts[id] = context
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { granted, error in
      let code = (error as? LAError)?.code
      DispatchQueue.main.async {
        let current = prompts[id] === context
        if current { prompts.removeValue(forKey: id) }
        done(granted && current, granted && current ? "granted" : code == .userCancel || code == .appCancel || code == .systemCancel || !current ? "cancelled" : "failed")
      }
    }
  }

  static let calls = vaultCallTable(
    state: { _, reply in onVault({ store.state() }) { reply.ok($0) } },
    screenLocked: { _, reply in
      if LaunchConfig.shared.background { return reply.ok(false) }
      let session = CGSessionCopyCurrentDictionary() as? [String: Any]
      reply.ok((session?["CGSSessionScreenIsLocked"] as? Bool) ?? false)
    },
    signIn: { args, reply in
      let started = DispatchTime.now().uptimeNanoseconds
      let profile = args.profile, origin = try args.text("origin"), username = try args.text("username"), url = try args.text("url"), attempt = try args.text("attempt")
      guard attempts[attempt] == nil else { return reply.ok(["status": "failed", "reason": "duplicateAttempt"]) }
      var cancelledEarly = false
      attempts[attempt] = { cancelledEarly = true }
      onVault({ store.warm() && store.code(profile: profile, origin: origin, username: username) != nil }) { hasCode in
        guard !cancelledEarly, attempts[attempt] != nil else {
          attempts.removeValue(forKey: attempt)
          return reply.ok(["status": "cancelled", "usedCode": false, "codeMs": 0, "prepareMs": elapsed(since: started), "appMs": elapsed(since: started)])
        }
        let prepared = elapsed(since: started)
        var usedCode = false
        var codeMs = 0.0
        let provider: ((@escaping (String?) -> Void) -> Void)? = hasCode ? { answer in
          guard attempts[attempt] != nil else { return answer(nil) }
          let codeStart = DispatchTime.now().uptimeNanoseconds
          store.queue.async {
            let code = store.code(profile: profile, origin: origin, username: username)?.code(at: Date())
            DispatchQueue.main.async {
              codeMs = elapsed(since: codeStart)
              usedCode = code != nil && attempts[attempt] != nil
              answer(attempts[attempt] != nil ? code : nil)
            }
          }
        } : nil
        let cancel = ArdiaServices.vaultSignIn(profile: profile, url: url, origin: origin, username: username, codeProvider: provider) { result in
          attempts.removeValue(forKey: attempt)
          var answer = result
          answer["usedCode"] = usedCode
          answer["codeMs"] = codeMs
          answer["prepareMs"] = prepared
          answer["appMs"] = elapsed(since: started)
          reply.ok(answer)
        }
        if attempts[attempt] != nil { attempts[attempt] = cancel }
      }
    },
    cancelSignIn: { args, reply in
      let attempt = try args.text("attempt")
      attempts.removeValue(forKey: attempt)?()
      reply.ok(true)
    },
    warm: { _, reply in onVault({ store.warm() }) { reply.ok($0) } },
    saveSecret: { args, reply in
      let profile = args.profile, origin = try args.text("origin"), username = try args.text("username")
      guard let code = VerificationCode(otpauth: try args.text("uri")) else { return reply.ok(["saved": false, "reason": "unreadable"]) }
      onVault({ store.saveCode(code, profile: profile, origin: origin, username: username) }) { reply.ok(["saved": $0]) }
    },
    keepOfferedCode: { args, reply in
      let token = try args.text("token"), tab = try args.text("tab"), origin = try args.text("origin"), usernames = try args.strings("usernames")
      let generation = try args.optionalDouble("generation") ?? -1
      pendingKeeps[token] = (origin, usernames)
      let done = { (result: [AnyHashable: Any]) in
        pendingKeeps.removeValue(forKey: token)
        reply.ok(result)
      }
      if let live = WebKitHub.shared.transfers.liveTab(tab) { return live.setUpVerificationCode(token, generation: generation, done: done) }
      let started = ArdiaWebView.setUpVerificationCode(token, tab: tab, generation: generation) { done($0) }
      if !started {
        pendingKeeps.removeValue(forKey: token)
        reply.ok(["opened": false, "reason": "noTab"])
      }
    },
    hasSecret: { args, reply in
      let profile = args.profile, origin = try args.text("origin"), username = try args.text("username")
      onVault({ store.code(profile: profile, origin: origin, username: username) != nil }) { reply.ok($0) }
    },
    secrets: { args, reply in
      let profile = args.profile
      onVault({ store.codes(profile: profile) }) { reply.ok($0) }
    },
    removeSecret: { args, reply in
      let profile = args.profile, origin = try args.text("origin"), username = try args.text("username")
      onVault({ store.removeCode(profile: profile, origin: origin, username: username) }) { reply.ok($0) }
    },
    always: { _, reply in
      onVault({ store.always().map { ["profile": $0.profile, "origin": $0.origin, "teamId": $0.teamId, "identifier": $0.identifier, "program": $0.program, "added": $0.added] } }) { reply.ok($0) }
    },
    setAlways: { args, reply in
      let grant = VaultStore.AlwaysGrant(profile: args.profile, origin: try args.text("origin"), teamId: try args.text("teamId"), identifier: try args.text("identifier"), program: try args.text("program"), added: Date().timeIntervalSince1970 * 1000)
      let on = try args.bool("on")
      onVault({ store.setAlways(grant, on: on) }) { reply.ok($0) }
    },
    authenticate: { args, reply in
      let started = DispatchTime.now().uptimeNanoseconds
      authenticate(try args.text("id"), try args.text("reason")) { granted, how in reply.ok(["granted": granted, "how": how, "ms": elapsed(since: started)]) }
    },
    cancelAuthenticate: { args, reply in
      let id = try args.text("id")
      prompts.removeValue(forKey: id)?.invalidate()
      fakePrompts.remove(id)
      reply.ok(true)
    },
    appendLog: { args, reply in
      let lines = try args.strings("lines").filter { !$0.contains("\n") && $0.utf8.count <= 8192 }
      onVault({ VaultActivity.append(lines, to: store.activityURL, folder: { store.ensureFolder() }) }) { reply.ok($0) }
    },
    readLog: { args, reply in
      let limit = max(1, min(5000, try args.int("limit")))
      onVault({ VaultActivity.read(store.activityURL, limit: limit) }) { reply.ok($0) }
    }
  )
}
