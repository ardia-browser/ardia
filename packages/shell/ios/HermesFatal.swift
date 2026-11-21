import Foundation

public enum HermesFatal {
  private static let name = "hermes-fatal.txt"
  private static let settledName = "hermes-fatal-last.txt"
  private static let longest = 200
  static let unmatchedLifetime: TimeInterval = 60 * 60

  public static func install() {
    guard let url = try? DocumentStore.url(name) else { return }
    ArdiaHermesFatalInstall(url.path)
  }

  static func pending() -> (written: Date, reason: String?)? {
    guard let url = try? DocumentStore.url(name),
      let written = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date else { return nil }
    let data = (try? Data(contentsOf: url)) ?? Data()
    let text = String(decoding: data.prefix(longest * 4), as: UTF8.self)
    let line = text.split(whereSeparator: \.isNewline).first.map { String($0.prefix(longest)).trimmingCharacters(in: .whitespaces) } ?? ""
    return (written, line.isEmpty ? nil : line)
  }

  static func settle() {
    guard let url = try? DocumentStore.url(name), let settled = try? DocumentStore.url(settledName) else { return }
    try? FileManager.default.removeItem(at: settled)
    if (try? FileManager.default.moveItem(at: url, to: settled)) == nil { try? FileManager.default.removeItem(at: url) }
  }
}
