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
  var token = ""

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

  static let tokenMax = 16

  static func read(_ data: [String: Any]) -> WebKitLoginsReport? {
    guard let event = choice(data["event"], events), let token = token(data["token"]) else { return nil }
    var report: WebKitLoginsReport
    switch event {
    case "key":
      guard let key = choice(data["key"], keys) else { return nil }
      report = WebKitLoginsReport(event: event, key: key)
    case "show", "input": report = field(event, data)
    default: report = WebKitLoginsReport(event: event)
    }
    report.token = token
    return report
  }

  private static func token(_ value: Any?) -> String? {
    guard let token = value as? String, (1...tokenMax).contains(token.utf16.count), token.utf16.allSatisfy({ (48...57).contains($0) }) else { return nil }
    return token
  }

  private static func field(_ event: String, _ data: [String: Any]) -> WebKitLoginsReport {
    let password = flag(data["password"])
    let code = flag(data["code"])
    let fresh = password && flag(data["newPassword"])
    let identifier = !password && !code && flag(data["identifier"])
    var report = WebKitLoginsReport(event: event, password: password, kind: code ? .code : fresh ? .newPassword : identifier ? .identifier : .login)
    report.typed = password || code ? "" : typed(data["value"])
    report.rect = NSRect(
      x: coordinate(data["x"]), y: coordinate(data["y"]), width: max(1, coordinate(data["width"])), height: max(1, coordinate(data["height"])))
    if fresh { report.rules = LoginListField.rules(maxLength: data["maxLength"], minLength: data["minLength"], patterned: data["patterned"]) }
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
