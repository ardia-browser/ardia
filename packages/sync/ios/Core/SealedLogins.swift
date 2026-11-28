import Foundation

public enum SealedLogins {
  public static func from(_ reply: [String: Any]?, seal: (_ password: String, _ origin: String, _ username: String) throws -> String) -> [[String: Any]]? {
    guard let logins = reply?["logins"] as? [[String: Any]] else {
      NSLog("[sync] reading passwords: \(reply?["error"] ?? "no reply")")
      return nil
    }
    var copies: [(realm: String, username: String, password: String, created: Double, modified: Double)] = []
    for login in logins {
      guard let realm = login["realm"] as? String, let username = login["username"] as? String,
            let password = login["password"] as? String, let created = login["created"] as? Double else {
        NSLog("[sync] reading passwords: a malformed login; not syncing passwords now")
        return nil
      }
      copies.append((realm, username, password, created, login["modified"] as? Double ?? 0))
    }
    var newest: [String: Int] = [:]
    var order: [String] = []
    for (index, copy) in copies.enumerated() {
      let key = "\(copy.realm)\u{0}\(copy.username)"
      guard let current = newest[key] else {
        newest[key] = index
        order.append(key)
        continue
      }
      if copy.modified > copies[current].modified { newest[key] = index }
    }
    var sealed: [[String: Any]] = []
    for key in order {
      let copy = copies[newest[key]!]
      guard let origin = loginOrigin(copy.realm) else { continue }
      guard let box = try? seal(copy.password, origin, copy.username) else {
        NSLog("[sync] reading passwords: one login couldn't be sealed; listing it as passwordless so sync leaves it alone")
        sealed.append(["origin": origin, "username": copy.username, "passwordless": true, "created": copy.created])
        continue
      }
      sealed.append(["origin": origin, "username": copy.username, "sealed": box, "created": copy.created])
    }
    return sealed
  }

  public static func loginOrigin(_ realm: String) -> String? {
    let origin = realm.hasSuffix("/") ? String(realm.dropLast()) : realm
    return origin.range(of: #"^https?://[^/\s]+$"#, options: .regularExpression) != nil ? origin : nil
  }
}
