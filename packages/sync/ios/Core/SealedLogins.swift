import Foundation

public enum SealedLogins {
  public static func from(_ reply: [String: Any]?, seal: (_ password: String, _ origin: String, _ username: String) throws -> String) -> [[String: Any]]? {
    guard let logins = reply?["logins"] as? [[String: Any]] else {
      NSLog("[sync] reading passwords: \(reply?["error"] ?? "no reply")")
      return nil
    }
    var sealed: [[String: Any]] = []
    var seen = Set<String>()
    for login in logins {
      guard let realm = login["realm"] as? String, let username = login["username"] as? String,
            let password = login["password"] as? String, let created = login["created"] as? Double else {
        NSLog("[sync] reading passwords: a malformed login; not syncing passwords now")
        return nil
      }
      guard seen.insert("\(realm)\u{0}\(username)").inserted, let origin = loginOrigin(realm) else { continue }
      guard let box = try? seal(password, origin, username) else {
        NSLog("[sync] reading passwords: one login couldn't be sealed; listing it as passwordless so sync leaves it alone")
        sealed.append(["origin": origin, "username": username, "passwordless": true, "created": created])
        continue
      }
      sealed.append(["origin": origin, "username": username, "sealed": box, "created": created])
    }
    return sealed
  }

  public static func loginOrigin(_ realm: String) -> String? {
    let origin = realm.hasSuffix("/") ? String(realm.dropLast()) : realm
    return origin.range(of: #"^https?://[^/\s]+$"#, options: .regularExpression) != nil ? origin : nil
  }
}
