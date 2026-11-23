import Foundation

enum VaultExportFile {
  static func field(_ value: String) -> String {
    let needsQuotes = value.unicodeScalars.contains { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" }
    guard needsQuotes else { return value }
    return "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
  }

  static func csv(_ rows: [[String]]) -> String {
    rows.map { $0.map(field).joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
  }

  static func rows<Item>(_ items: [Item], stillOpen: () async -> Bool, row: (Item) async -> [String]) async -> [[String]]? {
    var rows: [[String]] = []
    rows.reserveCapacity(items.count)
    for item in items {
      guard await stillOpen() else { return nil }
      rows.append(await row(item))
    }
    return await stillOpen() ? rows : nil
  }

  static func write(_ text: String, to url: URL) -> Bool {
    let staged = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString)")
    guard VaultSealedFolder.writeNew(Data(text.utf8), to: staged) else { return false }
    guard rename(staged.path, url.path) == 0 else {
      unlink(staged.path)
      return false
    }
    return true
  }
}
