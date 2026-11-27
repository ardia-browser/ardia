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
    guard let (scheme, host) = page(origin) else { return done(nil) }
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

  @objc(saveForOrigin:username:password:completion:)
  static func save(origin: String, username: String, password: String, done: @escaping (Bool) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let (scheme, host) = page(origin) else {
      count("saveFailed")
      return done(false)
    }
    ApplePasswordsClient.shared.save(host: host, insecure: scheme == "http", user: username, password: password) { result in
      DispatchQueue.main.async {
        let saved = (try? result.get()) != nil
        if saved { remember(scheme: scheme, host: host, user: username, password: password) }
        count(saved ? "saved" : "saveFailed")
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

  private static func count(_ name: String) {
    ArdiaEvents.emit("passwords.applePasswordsSaveCounted", data: ArdiaConsentStamp.begin().onto(["name": name]))
  }
}
