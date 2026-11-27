import XCTest

@testable import ArdiaPluginCore

final class PluginPageMessagesTests: XCTestCase {
  func decode(_ line: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: line) as? [String: Any]) ?? [:]
  }

  func testAPageSendsOnlyBoundedJSONTextTaggedWithItsView() throws {
    let line = try XCTUnwrap(PluginPageMessages.fromPage("{\"ask\":\"hi\"}", view: "v3"))
    XCTAssertEqual(line.last, 10)
    XCTAssertEqual(decode(line)["view"] as? String, "v3")
    XCTAssertEqual(decode(line)["pageMessage"] as? [String: String], ["ask": "hi"])
    XCTAssertNil(PluginPageMessages.fromPage(["ask": "hi"], view: "v3"), "only text crosses, never an object the page built")
    XCTAssertNil(PluginPageMessages.fromPage("{not json", view: "v3"))
    XCTAssertNil(PluginPageMessages.fromPage("\"" + String(repeating: "a", count: PluginPageMessages.maxFromPage) + "\"", view: "v3"))
  }

  func testAHelperPostsBoundedJSONToOneViewOrAll() {
    guard case .success(let post) = PluginPageMessages.toPage(["view": "v3", "message": ["reply": "hello"]]) else { return XCTFail() }
    XCTAssertEqual(post.view, "v3")
    XCTAssertEqual(post.json, "{\"reply\":\"hello\"}")
    guard case .success(let all) = PluginPageMessages.toPage(["message": 7]) else { return XCTFail() }
    XCTAssertNil(all.view)
    XCTAssertEqual(PluginPageMessages.toPage([:]), .failure(.init(reason: "page.post needs a message")))
    XCTAssertEqual(PluginPageMessages.toPage(["view": 3, "message": 1]), .failure(.init(reason: "view must be the id a page message came with")))
    XCTAssertEqual(PluginPageMessages.toPage(["message": String(repeating: "a", count: PluginPageMessages.maxToPage)]), .failure(.init(reason: "a message to a page can be at most 256 KB")))
  }

  func testAPageSendsABurstOfAHundredThenAHundredASecond() {
    let page = PluginPageMessages.Limit(burst: PluginPageMessages.pageBurst, perSecond: PluginPageMessages.perSecond)
    XCTAssertEqual((0..<150).filter { _ in page.allow(now: 10) }.count, 100)
    XCTAssertFalse(page.allow(now: 10))
    XCTAssertEqual((0..<150).filter { _ in page.allow(now: 10.5) }.count, 50)
    XCTAssertEqual((0..<150).filter { _ in page.allow(now: 20) }.count, 100, "a bucket never holds more than its burst")
  }

  func testArdiaAcceptsEverythingThePageMirrorAllowsWithHeadroomForDeliveryJitter() {
    let page = PluginPageMessages.Limit(burst: PluginPageMessages.pageBurst, perSecond: PluginPageMessages.perSecond)
    let native = PluginPageMessages.Limit()
    var sent = 0
    var taken = 0
    for step in 0..<400 {
      let at = 10 + Double(step) * 0.002
      for _ in 0..<3 where page.allow(now: at) {
        sent += 1
        if native.allow(now: 10 + Double(step / 50) * 0.1) { taken += 1 }
      }
    }
    XCTAssertGreaterThan(sent, 100)
    XCTAssertEqual(taken, sent)
    XCTAssertEqual((0..<1000).filter { _ in native.allow(now: 100) }.count, PluginPageMessages.nativeBurst)
  }
}

final class PluginPageAnswerTests: XCTestCase {
  func decode(_ line: Data?) -> [String: Any] {
    line.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
  }

  func testPagePostIsAnsweredTheSameHoweverItIsSpelledAndRefusedWithoutAPage() {
    let escaped = "{\"id\":1,\"method\":\"page\\u002epost\",\"params\":{\"message\":1}}"
    let refused = decode(PluginPageMessages.answer(escaped, hasPage: false) { _ in XCTFail("never posted"); return nil })
    XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "refused")
    var posted: PagePost?
    let ok = decode(PluginPageMessages.answer(escaped, hasPage: true) { posted = $0; return nil })
    XCTAssertEqual(ok["result"] as? [String: Bool], ["ok": true])
    XCTAssertEqual(posted?.json, "1")
    let full = decode(PluginPageMessages.answer(escaped, hasPage: true) { _ in "overloaded" })
    XCTAssertEqual((full["error"] as? [String: Any])?["code"] as? String, "overloaded")
    XCTAssertNil(PluginPageMessages.answer("{\"id\":2,\"method\":\"windows\"}", hasPage: true) { _ in nil }, "other methods go on to Ardia")
  }
}
