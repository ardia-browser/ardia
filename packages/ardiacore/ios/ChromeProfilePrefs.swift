import Foundation

enum ChromeProfilePrefs {
  static func booleans(_ paths: [String], inProfileAt path: String) -> [String: Bool]? {
    let file = URL(fileURLWithPath: path).appendingPathComponent("Preferences")
    guard let data = try? Data(contentsOf: file),
      let prefs = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return nil }
    var found: [String: Bool] = [:]
    for dotted in paths {
      var node: Any? = prefs
      for part in dotted.split(separator: ".") { node = (node as? [String: Any])?[String(part)] }
      if let value = node as? Bool { found[dotted] = value }
    }
    return found
  }
}
