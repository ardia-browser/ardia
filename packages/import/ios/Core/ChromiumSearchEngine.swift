import Foundation

public enum ChromiumSearchEngine {
  public static func read(profile: URL) -> ImportedSearchEngine? {
    guard let data = try? Data(contentsOf: profile.appendingPathComponent("Preferences")),
          let prefs = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    if let guid = chosenGuid(prefs), let engine = try? keyword(guid: guid, webData: profile.appendingPathComponent("Web Data")) {
      return engine
    }
    return selectedTemplate(prefs)
  }

  static func chosenGuid(_ prefs: [String: Any]) -> String? {
    let provider = prefs["default_search_provider"] as? [String: Any]
    return ["guid", "synced_guid"].lazy.compactMap { nonEmpty(provider?[$0] as? String) }.first
  }

  static func keyword(guid: String, webData: URL) throws -> ImportedSearchEngine? {
    guard FileManager.default.fileExists(atPath: webData.path) else { return nil }
    let db = try SQLiteSnapshot(copying: webData)
    guard db.tableExists("keywords") else { return nil }
    var found: ImportedSearchEngine?
    try db.query("SELECT * FROM keywords WHERE sync_guid = ? LIMIT 1", [.text(guid)]) { row in
      found = engine(name: row.text("short_name"), keyword: row.text("keyword"), url: row.text("url"),
                     prepopulateId: row.int("prepopulate_id").map(Int.init))
      return false
    }
    return found
  }

  static func selectedTemplate(_ prefs: [String: Any]) -> ImportedSearchEngine? {
    guard let data = (prefs["default_search_provider_data"] as? [String: Any])?["template_url_data"] as? [String: Any] else { return nil }
    let prepopulate = (data["prepopulate_id"] as? NSNumber)?.intValue ?? (data["prepopulate_id"] as? String).flatMap { Int($0) }
    return engine(name: data["short_name"] as? String, keyword: data["keyword"] as? String, url: data["url"] as? String,
                  prepopulateId: prepopulate)
  }

  static func engine(name: String?, keyword: String?, url: String?, prepopulateId: Int?) -> ImportedSearchEngine? {
    guard let url = nonEmpty(url)?.replacingOccurrences(of: "{searchTerms?}", with: "{searchTerms}"), url.contains("{searchTerms}") else { return nil }
    return ImportedSearchEngine(name: nonEmpty(name) ?? "", keyword: nonEmpty(keyword) ?? "", url: url,
                                prepopulateId: prepopulateId.flatMap { $0 > 0 ? $0 : nil })
  }

  static func nonEmpty(_ s: String?) -> String? {
    guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
    return t
  }
}
