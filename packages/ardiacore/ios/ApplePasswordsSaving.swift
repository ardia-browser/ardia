import CryptoKit
import Foundation

@objc(ApplePasswordsSaving)
final class ApplePasswordsSaving: NSObject {
  static let target = "applePasswords"
  static let notSaved = "notSaved"
  private static var confirmed: [String: SHA256.Digest] = [:]

  private static func key(_ scheme: String, _ host: String, _ user: String) -> String {
    "\(scheme.lowercased())://\(ApplePasswordsMatch.normalized(host))\u{1}\(user)"
  }

  private static func digest(_ password: String) -> SHA256.Digest { SHA256.hash(data: Data(password.utf8)) }

  private static func page(_ origin: String) -> (scheme: String, host: String)? {
    guard let url = URL(string: origin), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
      let host = url.host?.lowercased(), !host.isEmpty
    else { return nil }
    return (scheme, host)
  }

  static func remember(scheme: String, host: String, user: String, password: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    confirmed[key(scheme, host, user)] = digest(password)
  }

  @objc(decideForOrigin:profile:username:password:completion:)
  static func decide(origin: String, profile: String, username: String, password: String, done: @escaping (String?) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let (scheme, host) = page(origin), ApplePasswordsMatch.savable(username: username, password: password) != nil else { return done(nil) }
    let remembered = confirmed[key(scheme, host, username)]
    if remembered == digest(password) { return done(nil) }
    ApplePasswordsClient.shared.logins(host: host) { result in
      guard case .success(let entries) = result else { return DispatchQueue.main.async { done(nil) } }
      LoginList.domains(ApplePasswordsMatch.probes([host] + ApplePasswordsMatch.siteHosts(entries)), profile: profile) { domains in
        let kept = ApplePasswordsMatch.logins(entries, scheme: scheme, host: host, domains: domains).contains { $0.user == username }
        guard kept else { return done(remembered == nil ? "save" : "update") }
        ApplePasswordsClient.shared.password(host: host, user: username) { result in
          DispatchQueue.main.async {
            guard case .success(let saved) = result else { return done(nil) }
            guard Data(saved.utf8) != Data(password.utf8) else {
              remember(scheme: scheme, host: host, user: username, password: password)
              return done(nil)
            }
            done("update")
          }
        }
      }
    }
  }

  static func save(origin: String, username: String, password: String, update: Bool, engine: String, done: @escaping (Bool) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let (scheme, host) = page(origin), ApplePasswordsMatch.savable(username: username, password: password) != nil else {
      count("saveFailed", engine: engine)
      return done(false)
    }
    ApplePasswordsClient.shared.save(host: host, insecure: scheme == "http", user: username, password: password, update: update) { result in
      DispatchQueue.main.async {
        let saved = (try? result.get()) != nil
        if saved { remember(scheme: scheme, host: host, user: username, password: password) }
        count(saved ? "saved" : "saveFailed", engine: engine)
        done(saved)
      }
    }
  }

  @objc(promptWithState:origin:username:passwordLength:usernames:)
  static func prompt(_ state: String, origin: String, username: String, passwordLength: Int, usernames: [String]) -> [String: Any] {
    [
      "state": state, "origin": origin, "username": username, "passwordLength": passwordLength, "federation": "", "usernames": usernames,
      "target": target,
    ]
  }

  private final class Held {
    let origin: String
    let username: String
    let password: String
    let turn: Int
    var shown = false
    var update = false

    init(origin: String, username: String, password: String, turn: Int) {
      self.origin = origin
      self.username = username
      self.password = password
      self.turn = turn
    }
  }

  private static let held = NSMapTable<AnyObject, Held>.weakToStrongObjects()
  private static var turns = 0

  @objc(offerLogin:profile:on:show:)
  static func offer(_ login: [String: String], profile: String, on view: AnyObject, show: @escaping ([String: Any]?) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    held.removeObject(forKey: view)
    guard let origin = login["origin"], let password = login["password"], !password.isEmpty, page(origin) != nil,
      !ArdiaHost.isPrivateProfile(profile)
    else { return show(nil) }
    let username = login["username"] ?? ""
    turns += 1
    let pending = Held(origin: origin, username: username, password: password, turn: turns)
    held.setObject(pending, forKey: view)
    decide(origin: origin, profile: profile, username: username, password: password) { [weak view] state in
      guard let view, held.object(forKey: view)?.turn == pending.turn else { return }
      guard let state else {
        held.removeObject(forKey: view)
        return show(nil)
      }
      pending.shown = true
      pending.update = state == "update"
      show(prompt(state, origin: origin, username: username, passwordLength: password.count, usernames: [username]))
    }
  }

  @objc(answer:username:on:notSaved:)
  static func answer(_ action: String, username: String?, on view: AnyObject, notSaved: @escaping ([String: Any]) -> Void) -> String {
    dispatchPrecondition(condition: .onQueue(.main))
    let chrome = action == "never" ? "never" : "dismiss"
    guard let login = held.object(forKey: view), login.shown else { return chrome }
    held.removeObject(forKey: view)
    guard action == "save" || action == "update" else { return chrome }
    let name = username ?? login.username
    save(origin: login.origin, username: name, password: login.password, update: login.update && name == login.username, engine: "chromium") { saved in
      guard !saved else { return }
      notSaved(prompt(Self.notSaved, origin: login.origin, username: name, passwordLength: login.password.count, usernames: [name]))
    }
    return chrome
  }

  private static func count(_ name: String, engine: String) {
    ArdiaEvents.emit("passwords.applePasswordsSaveCounted", data: ArdiaConsentStamp.begin().onto(["name": name, "engine": engine]))
  }
}
