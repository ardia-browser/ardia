import Foundation

enum LocalReportLines {
  static let countEvents: Set<String> = ["usage_counts", "tab_presses", "perf_omnibox", "perf_memory", "telemetry_local_store", "password_import"]

  static func isUnsentCount(_ line: Data) -> Bool {
    guard let record = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
      let sent = record["sent"] as? Bool, !sent,
      let event = record["event"] as? String
    else { return false }
    return countEvents.contains(event)
  }

  static func withoutUnsentCounts(_ data: Data) -> (data: Data, lines: Int) {
    var out = Data()
    var lines = 0
    for line in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
      if isUnsentCount(Data(line)) { continue }
      out.append(line)
      out.append(0x0A)
      lines += 1
    }
    return (out, lines)
  }
}
