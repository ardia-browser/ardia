import Foundation

enum VaultJSON {
  private static let internetDates = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  private static let wholeSecondDates = Date.ISO8601FormatStyle()
  private static let civilDates = Date.ISO8601FormatStyle().year().month().day().dateTimeSeparator(.standard)
    .time(includingFractionalSeconds: false)
  private static let mostStarts = 64
  private static let noiseScanLimit = 64 * 1024

  static func parse(_ data: Data) -> Any? {
    if let value = try? JSONSerialization.jsonObject(with: data, options: []) { return value }
    guard let closing = data.lastIndex(where: { $0 == UInt8(ascii: "}") || $0 == UInt8(ascii: "]") }) else { return nil }
    var tried = 0
    let scanEnd = min(closing, data.startIndex + noiseScanLimit)
    for start in data.startIndex..<scanEnd where data[start] == UInt8(ascii: "{") || data[start] == UInt8(ascii: "[") {
      if let value = try? JSONSerialization.jsonObject(with: Data(data[start...closing]), options: []) { return value }
      tried += 1
      if tried >= mostStarts { break }
    }
    return nil
  }

  static func list(_ data: Data, from tool: String) throws -> [[String: Any]] {
    guard let list = parse(data) as? [Any] else { throw unreadable(tool) }
    return list.compactMap { $0 as? [String: Any] }
  }

  static func record(_ data: Data, from tool: String) throws -> [String: Any] {
    guard let record = parse(data) as? [String: Any] else { throw unreadable(tool) }
    return record
  }

  static func list(in record: [String: Any], at key: String, from tool: String) throws -> [[String: Any]] {
    guard let list = record[key] as? [Any] else { throw unreadable(tool) }
    return list.compactMap { $0 as? [String: Any] }
  }

  static func unreadable(_ tool: String) -> VaultError { .failed(unreadableMessage(tool)) }

  static func unreadableMessage(_ tool: String) -> String { "\(tool) sent a reply Ardia couldn't read. Update it and try again." }

  static func dict(_ value: Any?) -> [String: Any]? { value as? [String: Any] }

  static func dicts(_ value: Any?) -> [[String: Any]] {
    guard let list = value as? [Any] else { return [] }
    return list.compactMap { $0 as? [String: Any] }
  }

  static func strings(_ value: Any?) -> [String] {
    guard let list = value as? [Any] else { return [] }
    return list.compactMap { string($0) }
  }

  static func string(_ value: Any?) -> String? {
    if let text = value as? String { return text.isEmpty ? nil : text }
    if let number = value as? NSNumber, !isBoolean(number) { return number.stringValue }
    return nil
  }

  static func bool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber else { return nil }
    return number.boolValue
  }

  static func int(_ value: Any?) -> Int? {
    if let number = value as? NSNumber, !isBoolean(number), number.doubleValue.isFinite { return number.intValue }
    if let text = value as? String { return Int(text) }
    return nil
  }

  static func milliseconds(_ value: Any?) -> Double? {
    if let number = value as? NSNumber, !isBoolean(number) {
      let raw = number.doubleValue
      guard raw.isFinite, raw > 0 else { return nil }
      return raw > 100_000_000_000 ? raw : raw * 1000
    }
    guard let text = value as? String, !text.isEmpty else { return nil }
    let date = (try? internetDates.parse(text)) ?? (try? wholeSecondDates.parse(text)) ?? (try? civilDates.parse(String(text.prefix(19))))
    return date.map { ($0.timeIntervalSince1970 * 1000).rounded() }
  }

  static func object<T: Encodable>(_ value: T) -> [String: Any] {
    guard let data = try? JSONEncoder().encode(value), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return [:]
    }
    return object
  }

  static func data(_ value: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject(value) else { return nil }
    return try? JSONSerialization.data(withJSONObject: value)
  }

  static func text(_ value: Any) -> String {
    guard let data = data(value), let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
  }

  private static func isBoolean(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }
}
