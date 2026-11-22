import Foundation

enum ChromeTabCyclingPref {
  static func isMostRecentFirst(inProfileAt path: String) -> Bool? {
    let file = URL(fileURLWithPath: path).appendingPathComponent("Preferences")
    guard let data = try? Data(contentsOf: file),
      let prefs = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return nil }
    let browser = (prefs["helium"] as? [String: Any])?["browser"] as? [String: Any]
    return browser?["mru_tab_cycling"] as? Bool ?? false
  }
}
