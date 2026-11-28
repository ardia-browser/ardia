import AppKit

struct LoginListField {
  enum Trigger { case press, typing }
  enum Kind { case login, identifier, code, newPassword }

  static let lengthMax = 1024

  let frameOrigin: String
  let screenRect: NSRect
  let trigger: Trigger
  let typed: String
  var kind: Kind = .login
  var rules = StrongPassword.Rules()

  static func rules(maxLength: Any?, minLength: Any?, patterned: Any? = nil) -> StrongPassword.Rules {
    let length = { (value: Any?) -> Int in
      guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return 0 }
      return Int(max(0, min(Double(lengthMax), number.doubleValue.rounded(.down))))
    }
    let flag = (patterned as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
    return StrongPassword.Rules(minLength: length(minLength), maxLength: length(maxLength), patterned: flag)
  }
}
