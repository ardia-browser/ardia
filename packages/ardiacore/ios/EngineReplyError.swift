import Foundation

enum EngineReplyError {
  private static let openBrace: unichar = 0x7B
  private static let colon: unichar = 0x3A
  private static let errorKey = Array("\"error\"".utf16)
  private static let jsonWhitespace: Set<unichar> = [0x20, 0x09, 0x0A, 0x0D]

  static func message(_ json: String) -> String? {
    guard opensWithErrorKey(json as NSString) else { return nil }
    guard let reply = try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed]) else { return "the engine's reply isn't JSON" }
    guard let dict = reply as? [String: Any], let error = dict["error"] else { return nil }
    return error as? String ?? "\(error)"
  }

  static func opensWithErrorKey(_ text: NSString) -> Bool {
    let length = text.length
    var at = 0
    func skipWhitespace() {
      while at < length, jsonWhitespace.contains(text.character(at: at)) { at += 1 }
    }
    func take(_ unit: unichar) -> Bool {
      guard at < length, text.character(at: at) == unit else { return false }
      at += 1
      return true
    }
    skipWhitespace()
    guard take(openBrace) else { return false }
    skipWhitespace()
    for unit in errorKey where !take(unit) { return false }
    skipWhitespace()
    return take(colon)
  }
}
