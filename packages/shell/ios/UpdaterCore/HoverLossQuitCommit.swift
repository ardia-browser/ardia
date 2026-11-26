import Foundation

enum HoverLossQuitCommit {
  static let maxHoverLostSeconds = 86_400
  static let maxCommittedFiles = 20

  struct Prepared {
    let id: String
    let json: String
  }

  static func prepare(held: String, seconds: Int) -> Prepared? {
    guard let heldData = held.data(using: .utf8),
          var record = (try? JSONSerialization.jsonObject(with: heldData)) as? [String: Any] else { return nil }
    if seconds >= 0, var props = record["properties"] as? [String: Any] {
      props["lost_seconds"] = min(seconds, maxHoverLostSeconds)
      record["properties"] = props
    }
    let rawId = (record["uuid"] as? String) ?? ""
    let safeId = !rawId.isEmpty && rawId.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") } ? rawId : UUID().uuidString.lowercased()
    guard let out = try? JSONSerialization.data(withJSONObject: record),
          let json = String(data: out, encoding: .utf8) else { return nil }
    return Prepared(id: safeId, json: json)
  }

  @discardableResult
  static func commit(
    held: String,
    seconds: Int,
    prefix: String,
    maxFiles: Int = maxCommittedFiles,
    write: (String, String) -> Bool,
    list: (String) -> [String],
    remove: (String) -> Void,
    markCommitted: () -> Void,
    removeHeld: () -> Void
  ) -> Bool {
    guard let prepared = prepare(held: held, seconds: seconds) else { return false }
    let target = "\(prefix)\(prepared.id).json"
    guard write(target, prepared.json) else { return false }
    markCommitted()
    removeHeld()
    let committed = list(prefix).filter { $0.hasSuffix(".json") }
    if committed.count > maxFiles {
      let removable = committed.filter { $0 != target }
      for old in removable.prefix(committed.count - maxFiles) {
        remove(old)
      }
    }
    return true
  }
}
