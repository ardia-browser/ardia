import Foundation

struct CredentialVerbReport: @unchecked Sendable {
  var notifications: [String] = []
  var reply: [String: Any] = [:]
  var capturedKey: String?
  var succeeded = false
}

enum CredentialVerbOutput {
  static let hidden = "[hidden]"
  private static let escapeCodes = #"\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07"#
  private static let logPrefix = #"^\[[A-Za-z]+\]\s+\d{4}/\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2}\s+"#

  static func redactor(_ secrets: [String], shortest: Int = CredentialLimits.redactedShortest) -> [String] {
    Array(Set(secrets.filter { $0.count >= shortest })).sorted { $0.count > $1.count }
  }

  static func redact(_ text: String, _ secrets: [String]) -> String {
    var cleaned = text
    for secret in secrets where cleaned.contains(secret) { cleaned = cleaned.replacingOccurrences(of: secret, with: hidden) }
    return cleaned
  }

  static func redact(json value: Any, _ secrets: [String]) -> Any {
    guard !secrets.isEmpty else { return value }
    if let text = value as? String { return redact(text, secrets) }
    if let list = value as? [Any] { return list.map { redact(json: $0, secrets) } }
    if let table = value as? [String: Any] {
      var cleaned: [String: Any] = [:]
      for (key, entry) in table { cleaned[redact(key, secrets)] = redact(json: entry, secrets) }
      return cleaned
    }
    return value
  }

  static func cleanLine(_ line: Substring) -> String {
    var text = String(line).replacingOccurrences(of: escapeCodes, with: "", options: .regularExpression)
    text = text.replacingOccurrences(of: logPrefix, with: "", options: .regularExpression)
    if text.hasSuffix("\r") { text.removeLast() }
    return text
  }

  static func cleanStderr(_ raw: String, secrets: [String], stdinTexts: [String]) -> String {
    let lines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(cleanLine)
    var text = lines.joined(separator: "\n")
    text = redact(text, redactor(secrets))
    text = redact(text, redactor(stdinTexts, shortest: CredentialLimits.stdinRedactedShortest))
    return capped(text, bytes: CredentialLimits.stderrBytes)
  }

  static func capped(_ text: String, bytes: Int) -> String {
    guard text.utf8.count > bytes else { return text }
    var kept = ""
    var used = 0
    for character in text {
      let size = String(character).utf8.count
      if used + size > bytes { break }
      used += size
      kept.append(character)
    }
    return kept
  }

  static func hints(_ raw: String, of verb: CredentialVerb) -> [String] {
    let haystack = raw.lowercased()
    return verb.hintOrder.filter { id in (verb.hints[id] ?? []).contains { haystack.contains($0.lowercased()) } }
  }

  static func lines(of data: Data) -> [String] {
    var text = String(decoding: data, as: UTF8.self)
    if text.hasSuffix("\n") { text.removeLast() }
    if text.isEmpty { return [] }
    return text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
      var kept = String(line)
      if kept.hasSuffix("\r") { kept.removeLast() }
      return kept
    }
  }

  static func lastLineSecret(_ data: Data) -> String? {
    let text = String(decoding: data, as: UTF8.self)
    guard let last = text.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) }).last(where: { !$0.isEmpty }) else { return nil }
    guard (CredentialLimits.lastLineSecretShortest...CredentialLimits.secretBytes).contains(last.utf8.count),
      !last.unicodeScalars.contains(where: { $0.properties.isWhitespace || CredentialCatalogParser.isControlOrDirection($0) })
    else { return nil }
    return last
  }

  static func encoded(_ value: Any) -> Data? {
    try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes, .fragmentsAllowed])
  }

  static func quoted(_ text: String) -> String {
    String(decoding: encoded(text) ?? Data("\"\"".utf8), as: UTF8.self)
  }

  static func report(_ result: VaultCommandResult, verb: CredentialVerb, launch: CredentialVerbLaunch, verbOf: Int, streamed droppedLines: Int = 0) -> CredentialVerbReport {
    VaultOffMain.check()
    let secrets = redactor(launch.secretValues)
    var report = CredentialVerbReport()
    var overflowed = result.overflowed
    var json: Any = NSNull()
    var lines: [String] = []
    var items = 0
    var parts = 0
    if result.launched && !result.overflowed {
      switch verb.output {
      case .json(let itemsAt):
        if let parsed = VaultJSON.parse(result.stdout) {
          let cleaned = redact(json: parsed, secrets)
          if let itemsAt, let split = splitItems(cleaned, at: itemsAt) {
            var notifications: [String] = []
            for (index, element) in split.elements.enumerated() {
              guard let data = encoded(element), data.count <= CredentialLimits.outputItemBytes - 64 else {
                overflowed = true
                notifications = []
                break
              }
              notifications.append("{\"verbOf\":\(verbOf),\"item\":\(String(decoding: data, as: UTF8.self)),\"index\":\(index)}")
            }
            if !overflowed {
              report.notifications = notifications
              items = notifications.count
              json = split.emptied
            }
          } else if let data = encoded(cleaned) {
            if data.count > CredentialLimits.chunkBytes {
              let text = String(decoding: data, as: UTF8.self)
              for chunk in chunks(text, bytes: CredentialLimits.chunkBytes) {
                report.notifications.append("{\"verbOf\":\(verbOf),\"part\":\(quoted(chunk))}")
                parts += 1
              }
            } else {
              json = cleaned
            }
          }
        }
      case .lines:
        lines = Self.lines(of: result.stdout).map { redact($0, secrets) }
        if lines.reduce(0, { $0 + $1.utf8.count + 8 }) > CredentialLimits.inlineReplyBytes {
          overflowed = true
          lines = []
        }
      case .lastLineSecret:
        if result.succeeded { report.capturedKey = lastLineSecret(result.stdout) }
      case .stream:
        break
      }
    }
    let succeeded = result.succeeded && !overflowed
    report.succeeded = succeeded
    report.reply = [
      "verb": verb.id, "status": Int(result.status), "launched": result.launched, "timedOut": result.timedOut, "cancelled": result.cancelled,
      "overflowed": overflowed, "succeeded": succeeded, "stderr": cleanStderr(result.stderr, secrets: launch.secretValues, stdinTexts: launch.stdinTexts),
      "hints": hints(result.stderr, of: verb), "json": json, "parts": parts, "lines": lines, "items": items, "droppedLines": droppedLines,
    ]
    if overflowed { report.notifications = [] }
    return report
  }

  struct SplitItems {
    var elements: [Any]
    var emptied: Any
  }

  static func splitItems(_ value: Any, at key: String) -> SplitItems? {
    if key == "$" {
      guard let list = value as? [Any] else { return nil }
      return SplitItems(elements: list, emptied: [Any]())
    }
    guard var table = value as? [String: Any], let list = table[key] as? [Any] else { return nil }
    table[key] = [Any]()
    return SplitItems(elements: list, emptied: table)
  }

  static func chunks(_ text: String, bytes: Int) -> [String] {
    var pieces: [String] = []
    var current = ""
    var used = 0
    for scalar in text.unicodeScalars {
      let size = String(scalar).utf8.count
      if used + size > bytes {
        pieces.append(current)
        current = ""
        used = 0
      }
      current.unicodeScalars.append(scalar)
      used += size
    }
    if !current.isEmpty { pieces.append(current) }
    return pieces
  }

  static func streamLine(_ text: String, stream: String, verbOf: Int, secrets: [String]) -> String {
    let line = capped(redact(cleanLine(Substring(text)), redactor(secrets)), bytes: CredentialLimits.streamLineBytes)
    return "{\"verbOf\":\(verbOf),\"line\":{\"stream\":\(quoted(stream)),\"text\":\(quoted(line))}}"
  }
}
