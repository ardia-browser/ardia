import XCTest

@testable import ArdiaPluginCore

final class PluginPageOutboxTests: XCTestCase {
  let view = PageBinding(plugin: "ai", approved: "h1", run: 2, view: "v1")

  func testAFullViewAnswersOverloadedInsteadOfGrowing() {
    let outbox = PluginPageOutbox()
    outbox.bind(view)
    for i in 0..<PluginPageOutbox.maxPending { XCTAssertEqual(outbox.post(plugin: "ai", approved: "h1", run: 2, view: "v1", json: "\(i)"), .queued([view])) }
    XCTAssertEqual(outbox.post(plugin: "ai", approved: "h1", run: 2, view: "v1", json: "more"), .overloaded)
    let big = PluginPageOutbox()
    big.bind(view)
    XCTAssertEqual(big.post(plugin: "ai", approved: "h1", run: 2, view: nil, json: String(repeating: "a", count: PluginPageOutbox.maxBytes)), .queued([view]))
    XCTAssertEqual(big.post(plugin: "ai", approved: "h1", run: 2, view: nil, json: "a"), .overloaded, "bytes are capped too")
  }

  func testMessagesDrainInOrderWithAFewInFlight() {
    let outbox = PluginPageOutbox()
    outbox.bind(view)
    for i in 0..<6 { _ = outbox.post(plugin: "ai", approved: "h1", run: 2, view: "v1", json: "\(i)") }
    let first = (0..<10).compactMap { _ in outbox.take(view) }
    XCTAssertEqual(first, ["0", "1", "2", "3"], "four in flight at most, in order")
    outbox.delivered(view)
    XCTAssertEqual(outbox.take(view), "4")
  }

  func testARevokedViewDropsWhatWaitsAndGetsNothingMore() {
    let outbox = PluginPageOutbox()
    outbox.bind(view)
    _ = outbox.post(plugin: "ai", approved: "h1", run: 2, view: nil, json: "old")
    outbox.revoke(view)
    XCTAssertNil(outbox.take(view))
    XCTAssertFalse(outbox.isBound(view))
    XCTAssertEqual(outbox.post(plugin: "ai", approved: "h1", run: 2, view: "v1", json: "late"), .queued([]))
    let next = PageBinding(plugin: "ai", approved: "h1", run: 3, view: "v1")
    outbox.bind(next)
    XCTAssertEqual(outbox.post(plugin: "ai", approved: "h1", run: 2, view: nil, json: "from run 2"), .queued([]), "a message from the old run never reaches the new binding")
    XCTAssertEqual(outbox.post(plugin: "ai", approved: "h1", run: 3, view: nil, json: "from run 3"), .queued([next]))
  }

  func testANewBridgeOnTheSameViewNeverSharesTheOldOnesSlots() {
    let outbox = PluginPageOutbox()
    let first = PageBinding.fresh(plugin: "ai", approved: "h1", run: 2)
    let second = PageBinding.fresh(plugin: "ai", approved: "h1", run: 2)
    XCTAssertNotEqual(first, second, "a rebuilt bridge on the same tab is never the old one")
    outbox.bind(first)
    for i in 0..<4 { _ = outbox.post(plugin: "ai", approved: "h1", run: 2, view: first.view, json: "\(i)") }
    for _ in 0..<4 { _ = outbox.take(first) }
    outbox.revoke(first)
    outbox.bind(second)
    for i in 0..<5 { _ = outbox.post(plugin: "ai", approved: "h1", run: 2, view: second.view, json: "\(i)") }
    for _ in 0..<4 { outbox.delivered(first) }
    XCTAssertEqual((0..<10).compactMap { _ in outbox.take(second) }.count, 4, "the old bridge's completions free nothing in the new one")
  }
}
