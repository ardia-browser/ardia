import Foundation

enum PluginBase64 {
  static func encode(_ text: String) -> String? {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(text.utf16.count)
    for unit in text.utf16 {
      guard unit <= 0xff else { return nil }
      bytes.append(UInt8(unit))
    }
    return Data(bytes).base64EncodedString()
  }

  static func decode(_ text: String) -> String? {
    let asciiWhitespace: Set<Unicode.Scalar> = [" ", "\t", "\n", "\r", "\u{0C}"]
    var stripped = String(String.UnicodeScalarView(text.unicodeScalars.filter { !asciiWhitespace.contains($0) }))
    if stripped.count % 4 == 0, stripped.hasSuffix("=") { stripped.removeLast(stripped.hasSuffix("==") ? 2 : 1) }
    guard stripped.count % 4 != 1, !stripped.contains("=") else { return nil }
    stripped += String(repeating: "=", count: (4 - stripped.count % 4) % 4)
    guard let data = Data(base64Encoded: stripped) else { return nil }
    return String(data.map { Character(Unicode.Scalar($0)) })
  }
}
