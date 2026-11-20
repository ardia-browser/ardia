import Foundation

struct VaultFieldGeometry: Equatable {
  static let kinds: Set<String> = ["username", "password", "newPassword", "otp"]
  static let longestValue = 4096
  static let widestInset = 256.0

  struct Rect: Equatable {
    var x, y, width, height: Double
  }

  struct Inset: Equatable {
    var top, bottom, trailing: Double
  }

  var kind: String
  var focused: Bool
  var rect: Rect?
  var formHasPassword: Bool
  var clicked: Bool
  var auto: Bool
  var email: Bool
  var maxLength: Int
  var webauthn: Bool
  var brandColor: String?
  var rtl: Bool
  var darkField: Bool?
  var trailingTaken: Bool
  var inset: Inset?

  init?(_ raw: [String: Any], main: Bool) {
    guard let kind = raw["kind"] as? String, Self.kinds.contains(kind) else { return nil }
    let flag = { (key: String) in raw[key] as? Bool == true }
    self.kind = kind
    focused = flag("focused")
    formHasPassword = flag("formHasPassword")
    clicked = flag("clicked")
    auto = flag("auto")
    email = flag("email")
    webauthn = flag("webauthn")
    maxLength = Self.maxLength(raw["maxLength"])
    rect = main ? Self.rect(raw["rect"]) : nil
    let measured = rect != nil
    rtl = measured && flag("rtl")
    trailingTaken = measured && flag("trailingTaken")
    darkField = measured ? raw["darkField"] as? Bool : nil
    brandColor = measured ? Self.brandColor(raw["brandColor"]) : nil
    inset = measured ? Self.inset(raw["inset"]) : nil
  }

  func payload(frame: String, origin: String, main: Bool) -> [String: Any] {
    [
      "frameId": frame,
      "origin": origin,
      "main": main,
      "kind": kind,
      "focused": focused,
      "rect": rect.map { ["x": $0.x, "y": $0.y, "width": $0.width, "height": $0.height] } ?? NSNull(),
      "formHasPassword": formHasPassword,
      "clicked": clicked,
      "auto": auto,
      "email": email,
      "maxLength": maxLength,
      "rtl": rtl,
      "darkField": darkField ?? NSNull(),
      "brandColor": brandColor ?? NSNull(),
      "trailingTaken": trailingTaken,
      "inset": inset.map { ["top": $0.top, "bottom": $0.bottom, "trailing": $0.trailing] } ?? NSNull(),
      "webauthn": webauthn,
    ]
  }

  private static func finite(_ raw: Any?) -> Double? {
    guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    return value.isFinite ? value : nil
  }

  static func rect(_ raw: Any?) -> Rect? {
    guard let dict = raw as? [String: Any], let x = finite(dict["x"]), let y = finite(dict["y"]),
      let width = finite(dict["width"]), let height = finite(dict["height"]), width >= 0, height >= 0
    else { return nil }
    return Rect(x: x, y: y, width: width, height: height)
  }

  static func inset(_ raw: Any?) -> Inset? {
    guard let dict = raw as? [String: Any], let top = finite(dict["top"]), let bottom = finite(dict["bottom"]),
      let trailing = finite(dict["trailing"])
    else { return nil }
    let clamp = { (value: Double) in min(max(value, 0), widestInset) }
    return Inset(top: clamp(top), bottom: clamp(bottom), trailing: clamp(trailing))
  }

  static func maxLength(_ raw: Any?) -> Int {
    guard let value = finite(raw), value > 0 else { return 0 }
    return Int(min(value, Double(longestValue)).rounded(.down))
  }

  static func brandColor(_ raw: Any?) -> String? {
    guard let text = raw as? String, text.utf8.count == 7, text.first == "#" else { return nil }
    let hex = text.utf8.dropFirst()
    return hex.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) } ? text : nil
  }
}
