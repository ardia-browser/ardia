import Foundation
import Testing

@Suite("Field geometry from WebKit pages")
struct VaultFieldGeometryTests {
  static var measured: [String: Any] { [
    "kind": "password", "focused": true, "formHasPassword": true, "clicked": true, "auto": false, "email": false,
    "maxLength": 64, "webauthn": false, "brandColor": "#1a2b3c", "rtl": true, "darkField": true, "trailingTaken": true,
    "rect": ["x": 10, "y": 20, "width": 200, "height": 32], "inset": ["top": 2, "bottom": 3, "trailing": 4],
  ] }

  @Test func `a main frame field keeps its rect and badge hints`() throws {
    let field = try #require(VaultFieldGeometry(Self.measured, main: true))
    #expect(field.rect == .init(x: 10, y: 20, width: 200, height: 32))
    #expect(field.inset == .init(top: 2, bottom: 3, trailing: 4))
    #expect(field.rtl && field.trailingTaken && field.darkField == true && field.brandColor == "#1a2b3c")
    let payload = field.payload(frame: "f1", origin: "https://example.com", main: true)
    #expect(payload["kind"] as? String == "password")
    #expect(payload["maxLength"] as? Int == 64)
  }

  @Test func `a subframe field reports no geometry`() throws {
    let field = try #require(VaultFieldGeometry(Self.measured, main: false))
    #expect(field.rect == nil && field.inset == nil && field.brandColor == nil && field.darkField == nil)
    #expect(!field.rtl && !field.trailingTaken)
    #expect(field.focused)
  }

  @Test(arguments: ["", "card", "PASSWORD", "code"])
  func `unknown field kinds are dropped`(kind: String) {
    var raw = Self.measured
    raw["kind"] = kind
    #expect(VaultFieldGeometry(raw, main: true) == nil)
  }

  @Test func `hostile numbers and colors are rejected or clamped`() throws {
    var raw = Self.measured
    raw["rect"] = ["x": Double.nan, "y": 0, "width": 1, "height": 1]
    raw["inset"] = ["top": -5, "bottom": 9999, "trailing": 1]
    raw["maxLength"] = 1e12
    raw["brandColor"] = "#ABCDEF"
    #expect(VaultFieldGeometry(raw, main: true)?.rect == nil)
    raw["rect"] = ["x": 0, "y": 0, "width": 10, "height": 10]
    let field = try #require(VaultFieldGeometry(raw, main: true))
    #expect(field.inset == .init(top: 0, bottom: VaultFieldGeometry.widestInset, trailing: 1))
    #expect(field.maxLength == VaultFieldGeometry.longestValue)
    #expect(field.brandColor == nil)
  }

  @Test func `booleans posing as numbers and negative sizes are refused`() {
    #expect(VaultFieldGeometry.rect(["x": true, "y": 0, "width": 1, "height": 1]) == nil)
    #expect(VaultFieldGeometry.rect(["x": 0, "y": 0, "width": -1, "height": 1]) == nil)
    #expect(VaultFieldGeometry.maxLength(-3) == 0)
    #expect(VaultFieldGeometry.maxLength("12") == 0)
  }
}
