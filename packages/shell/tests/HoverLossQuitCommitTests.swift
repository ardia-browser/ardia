import XCTest
@testable import ArdiaUpdaterCore

final class HoverLossQuitCommitTests: XCTestCase {
  private let prefix = "hover-lost-at-quit-committed-"

  private func heldRecord(uuid: String, lostSeconds: Int = 5) -> String {
    #"{"serial":1,"uuid":"\#(uuid)","at":1000,"epoch":"e1","properties":{"ended_by":"quit","lost_seconds":\#(lostSeconds)},"context":{"$app_version":"0.3.1"}}"#
  }

  private func seededFiles(_ count: Int, start: Int = 1) -> [String: String] {
    var store: [String: String] = [:]
    for i in start..<(start + count) {
      let name = String(format: "%@01900000-0000-7000-8000-%012d.json", prefix, i)
      store[name] = "{}"
    }
    return store
  }

  func testWritesDurablyBeforePruningAndCapsDuration() {
    var store = seededFiles(20)
    var events: [String] = []
    let newId = "01900000-0000-7000-8000-000000000021"
    let expectedTarget = "\(prefix)\(newId).json"

    let ok = HoverLossQuitCommit.commit(
      held: heldRecord(uuid: newId),
      seconds: 99_999,
      prefix: prefix,
      write: { name, body in
        events.append("write:\(name)")
        store[name] = body
        return true
      },
      list: { p in
        events.append("list")
        return store.keys.filter { $0.hasPrefix(p) }.sorted()
      },
      remove: { name in
        events.append("remove:\(name)")
        store.removeValue(forKey: name)
      },
      markCommitted: { events.append("markCommitted") },
      removeHeld: { events.append("removeHeld") }
    )

    XCTAssertTrue(ok)
    XCTAssertEqual(store.count, 20)
    XCTAssertNotNil(store[expectedTarget])
    XCTAssertNil(store["\(prefix)01900000-0000-7000-8000-000000000001.json"])
    XCTAssertEqual(
      events,
      [
        "write:\(expectedTarget)",
        "markCommitted",
        "removeHeld",
        "list",
        "remove:\(prefix)01900000-0000-7000-8000-000000000001.json",
      ]
    )
    let saved = try? JSONSerialization.jsonObject(with: Data(store[expectedTarget]!.utf8)) as? [String: Any]
    let props = saved?["properties"] as? [String: Any]
    XCTAssertEqual(props?["lost_seconds"] as? Int, 86_400)
  }

  func testFailedWriteAtCapPreservesAllTwentyExistingRecords() {
    var store = seededFiles(20)
    let originalKeys = Set(store.keys)
    var removed: [String] = []
    var marked = false
    var heldRemoved = false

    let ok = HoverLossQuitCommit.commit(
      held: heldRecord(uuid: "01900000-0000-7000-8000-000000000021"),
      seconds: 12,
      prefix: prefix,
      write: { _, _ in false },
      list: { p in store.keys.filter { $0.hasPrefix(p) }.sorted() },
      remove: { name in
        removed.append(name)
        store.removeValue(forKey: name)
      },
      markCommitted: { marked = true },
      removeHeld: { heldRemoved = true }
    )

    XCTAssertFalse(ok)
    XCTAssertEqual(store.count, 20)
    XCTAssertEqual(Set(store.keys), originalKeys)
    XCTAssertTrue(removed.isEmpty)
    XCTAssertFalse(marked)
    XCTAssertFalse(heldRemoved)
  }

  func testPruningNeverRemovesNewlyWrittenRecordEvenWhenItSortsFirst() {
    var store = seededFiles(20, start: 10)
    let earlyId = "00000000-0000-7000-8000-000000000001"
    let newTarget = "\(prefix)\(earlyId).json"

    let ok = HoverLossQuitCommit.commit(
      held: heldRecord(uuid: earlyId),
      seconds: 4,
      prefix: prefix,
      write: { name, body in
        store[name] = body
        return true
      },
      list: { p in store.keys.filter { $0.hasPrefix(p) }.sorted() },
      remove: { store.removeValue(forKey: $0) },
      markCommitted: {},
      removeHeld: {}
    )

    XCTAssertTrue(ok)
    XCTAssertEqual(store.count, 20)
    XCTAssertNotNil(store[newTarget])
    XCTAssertNil(store["\(prefix)01900000-0000-7000-8000-000000000010.json"])
  }

  func testRewritingExistingUuidAtCapPrunesNothing() {
    var store = seededFiles(20)
    var removed: [String] = []
    let existingId = "01900000-0000-7000-8000-000000000005"

    let ok = HoverLossQuitCommit.commit(
      held: heldRecord(uuid: existingId),
      seconds: 30,
      prefix: prefix,
      write: { name, body in
        store[name] = body
        return true
      },
      list: { p in store.keys.filter { $0.hasPrefix(p) }.sorted() },
      remove: { name in
        removed.append(name)
        store.removeValue(forKey: name)
      },
      markCommitted: {},
      removeHeld: {}
    )

    XCTAssertTrue(ok)
    XCTAssertEqual(store.count, 20)
    XCTAssertTrue(removed.isEmpty)
  }

  func testInvalidHeldJsonReturnsFalseWithoutTouchingStore() {
    var touched = false
    let ok = HoverLossQuitCommit.commit(
      held: "not json",
      seconds: 10,
      prefix: prefix,
      write: { _, _ in
        touched = true
        return true
      },
      list: { _ in
        touched = true
        return []
      },
      remove: { _ in touched = true },
      markCommitted: { touched = true },
      removeHeld: { touched = true }
    )
    XCTAssertFalse(ok)
    XCTAssertFalse(touched)
  }
}
