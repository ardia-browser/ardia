import XCTest

@testable import ArdiaPluginCore

final class PluginHostConformanceTests: XCTestCase {
  static let urlFields = ["protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"]
  static let componentsTheParserCantMatch: Set<String> = ["http://example.com/%zz"]

  func vectors() throws -> [String: Any] {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("vectors/host-conformance.json")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
  }

  func whatwg(_ section: String) throws -> Any? {
    try (vectors()["whatwg"] as? [String: Any])?[section]
  }

  func decodedInput(_ vector: [String: Any]) -> String? {
    guard let encoded = vector["input"] as? String else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(encoded.utf8), options: [.fragmentsAllowed])) as? String
  }

  func loneSurrogateAsJavaScriptCoreBridgesIt(_ vector: [String: Any]) throws -> String {
    let encoded = try XCTUnwrap(vector["input"] as? String)
    XCTAssertTrue(encoded.lowercased().contains("\\ud8"), "only a lone surrogate may fail to decode: \(encoded)")
    return "\u{FFFD}"
  }

  func bracketed(_ host: String) -> String {
    host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
  }

  func testEveryUrlVectorParsesToTheWhatwgComponents() throws {
    let cases = try XCTUnwrap(whatwg("url") as? [[String: Any]])
    XCTAssertEqual(cases.count, 69)
    for vector in cases {
      let input = try XCTUnwrap(vector["input"] as? String)
      let base = vector["base"] as? String
      let label = base.map { "\(input) against \($0)" } ?? input
      let parsed = PluginURLParser.parse(input, base: base)
      guard vector["canParse"] as? Bool == true, let expected = vector["result"] as? [String: Any] else {
        XCTAssertNil(parsed, "\(label) should not parse")
        continue
      }
      guard let parsed else {
        XCTFail("\(label) should parse")
        continue
      }
      if Self.componentsTheParserCantMatch.contains(input) {
        let differs = Self.urlFields.contains { field in
          let actual = parsed[field] as? String ?? ""
          return (field == "hostname" ? bracketed(actual) : actual) != expected[field] as? String
        }
        XCTAssertTrue(differs, "\(label) now matches; take it off the list")
        continue
      }
      for field in Self.urlFields {
        let actual = parsed[field] as? String ?? ""
        XCTAssertEqual(field == "hostname" ? bracketed(actual) : actual, expected[field] as? String, "\(label) \(field)")
      }
    }
  }

  func testEveryBase64VectorMatchesWhatwg() throws {
    let sections = try XCTUnwrap(whatwg("base64") as? [String: [[String: Any]]])
    for (name, run) in [("atob", PluginBase64.decode), ("btoa", PluginBase64.encode)] as [(String, (String) -> String?)] {
      for vector in try XCTUnwrap(sections[name]) {
        let input = try decodedInput(vector) ?? loneSurrogateAsJavaScriptCoreBridgesIt(vector)
        let expected = try XCTUnwrap(vector["result"] as? [String: String])
        XCTAssertEqual(run(input), expected["ok"], "\(name)(\(vector["input"] ?? ""))")
      }
    }
  }

  func testTheCanonicalHostOfANumericLoopbackIsWhatThePolicyRefuses() throws {
    let parsed = try XCTUnwrap(PluginURLParser.parse("https://0x7f.1/", base: nil))
    XCTAssertEqual(parsed["hostname"] as? String, "127.0.0.1")
    for address in ["https://0x7f.1/", "https://127.0.0.1/", "https://2130706433/", "https://0177.0.0.1/"] {
      XCTAssertNotNil(PluginFetchPolicy.check(URL(string: address)!, allowedHosts: ["*"]), address)
    }
  }
}
