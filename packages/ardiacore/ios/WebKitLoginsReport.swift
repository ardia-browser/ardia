import AppKit
import WebKit

struct WebKitLoginsReport {
  let event: String
  var key = ""
  var password = false
  var kind = LoginListField.Kind.login
  var typed = ""
  var rect = NSRect.zero
  var rules = StrongPassword.Rules()

  static func normalized(_ origin: String) -> String {
    origin.hasSuffix("/") ? String(origin.dropLast()).lowercased() : origin.lowercased()
  }

  static func frameOrigin(_ origin: WKSecurityOrigin, claimed: Any?) -> String? {
    let scheme = origin.protocol.lowercased()
    guard scheme == "https" || scheme == "http", !origin.host.isEmpty else { return nil }
    let frame = normalized(Origins.of(origin))
    guard let claimed = claimed as? String, normalized(claimed) == frame else { return nil }
    return frame
  }

  static let typedMax = 200
  static let coordinateMax = 1e6
  static let events: Set<String> = ["show", "input", "key", "hide", "passwordInput"]
  static let keys: Set<String> = ["down", "up", "enter", "escape", "tab"]

  static func read(_ data: [String: Any]) -> WebKitLoginsReport? {
    guard let event = choice(data["event"], events) else { return nil }
    switch event {
    case "key": return choice(data["key"], keys).map { WebKitLoginsReport(event: event, key: $0) }
    case "show", "input": break
    default: return WebKitLoginsReport(event: event)
    }
    let password = flag(data["password"])
    let code = flag(data["code"])
    let fresh = password && flag(data["newPassword"])
    var report = WebKitLoginsReport(event: event, password: password, kind: code ? .code : fresh ? .newPassword : .login)
    report.typed = password || code ? "" : typed(data["value"])
    report.rect = NSRect(
      x: coordinate(data["x"]), y: coordinate(data["y"]), width: max(1, coordinate(data["width"])), height: max(1, coordinate(data["height"])))
    if fresh { report.rules = LoginListField.rules(maxLength: data["maxLength"], minLength: data["minLength"]) }
    return report
  }

  private static func choice(_ value: Any?, _ choices: Set<String>) -> String? {
    (value as? String).flatMap { choices.contains($0) ? $0 : nil }
  }

  private static func number(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
    return number.doubleValue
  }

  private static func flag(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
    return number.boolValue
  }

  private static func coordinate(_ value: Any?) -> Double { number(value).map { max(-coordinateMax, min(coordinateMax, $0)) } ?? 0 }

  private static func typed(_ value: Any?) -> String {
    guard let text = value as? NSString else { return "" }
    guard text.length > typedMax else { return text as String }
    return text.substring(to: text.rangeOfComposedCharacterSequence(at: typedMax).location)
  }
}
