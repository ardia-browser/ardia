import Foundation

enum EngineFatalNote {
  private static let place = "(?=\\S{1,80}(?: |$))[A-Za-z0-9_+-]{1,70}\\.(?:cc|cpp|cxx|c|h|hh|hpp|mm|m|swift|rs|ts|tsx|js|mjs):[1-9][0-9]{0,5}"
  private static let fatalAt = try! NSRegularExpression(pattern: "^ardia-fatal (\(place))$")
  private static let postedFrom = try! NSRegularExpression(
    pattern: "^ardia-posted-from (\\S{1,160}) (\\S+)(?:\\s+(.*))?$")
  private static let sourcePlace = try! NSRegularExpression(pattern: "^\(place)$")
  private static let frame = try! NSRegularExpression(pattern: "^([A-Za-z0-9_.%-]{1,192})\\+0x([0-9a-f]{1,16})$")
  private static let maxFrames = 17

  static func fields(_ body: [String: Any]) -> [String: Any] {
    var out: [String: Any] = [:]
    var frames: [[String: Any]] = []
    for case let messages as [String] in (body["asi"] as? [String: Any] ?? [:]).values {
      for line in messages.flatMap({ $0.split(whereSeparator: \.isNewline).map(String.init) }) {
        if let at = capture(fatalAt, line, 1) {
          out["fatalAt"] = at
        } else if let from = postedFrom.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) {
          if let place = capture(sourcePlace, group(from, 2, line) ?? "", 0) { out["postedFrom"] = place }
          frames = parsedFrames(group(from, 3, line) ?? "")
        } else if line.hasPrefix("ardia-task-trace") {
          frames += parsedFrames(String(line.dropFirst("ardia-task-trace".count)))
        }
      }
    }
    if !frames.isEmpty { out["postedFrames"] = Array(frames.prefix(maxFrames)) }
    return out
  }

  private static func parsedFrames(_ text: String) -> [[String: Any]] {
    text.split(separator: " ").compactMap { token -> [String: Any]? in
      let word = String(token)
      guard let match = frame.firstMatch(in: word, range: NSRange(word.startIndex..., in: word)),
        let encoded = group(match, 1, word), let image = encoded.removingPercentEncoding, !image.isEmpty, image.count <= 64,
        let hex = group(match, 2, word), let offset = Int(hex, radix: 16)
      else { return nil }
      return ["image": image, "offset": offset]
    }
  }

  private static func capture(_ pattern: NSRegularExpression, _ line: String, _ index: Int) -> String? {
    pattern.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)).flatMap { group($0, index, line) }
  }

  private static func group(_ match: NSTextCheckingResult, _ index: Int, _ line: String) -> String? {
    Range(match.range(at: index), in: line).map { String(line[$0]) }
  }
}
