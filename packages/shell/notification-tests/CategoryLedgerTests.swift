import XCTest
@testable import ArdiaNotificationCore

final class CategoryLedgerTests: XCTestCase {
  private let own = ["ardia.dismissible"]
  private var registered: [String] = []
  private let ledger = CategoryLedger()

  private func engineSets(_ categories: [String]) {
    ledger.write { registered = CategoryLedger.merged(categories, keeping: own, id: { $0 }) }
  }

  func testTheInitialMergeWritesWhenNothingWroteDuringItsRead() {
    let mark = ledger.mark
    let snapshot = ["saved"]
    let wrote = ledger.writeUnlessWritten(since: mark) { engineSets(snapshot) }
    XCTAssertTrue(wrote)
    XCTAssertEqual(registered, ["saved", "ardia.dismissible"])
  }

  func testAnEngineWriteDuringTheReadIsNotOverwrittenByTheOlderSnapshot() {
    let mark = ledger.mark
    let snapshot = ["saved"]
    engineSets(["engine-buttons"])
    let wrote = ledger.writeUnlessWritten(since: mark) { engineSets(snapshot) }
    XCTAssertFalse(wrote)
    XCTAssertEqual(registered, ["engine-buttons", "ardia.dismissible"])
  }

  func testWritesFromManyThreadsAreCountedAndTheGuardSeesEveryOne() {
    let mark = ledger.mark
    DispatchQueue.concurrentPerform(iterations: 200) { i in ledger.write { _ = i } }
    XCTAssertEqual(ledger.mark, mark + 200)
    XCTAssertFalse(ledger.writeUnlessWritten(since: mark) {})
    XCTAssertTrue(ledger.writeUnlessWritten(since: ledger.mark) {})
  }

  func testAMergeKeepsTheGivenCategoriesAndAddsOnlyMissingOwnOnes() {
    XCTAssertEqual(CategoryLedger.merged(["a", "ardia.dismissible"], keeping: own, id: { $0 }), ["a", "ardia.dismissible"])
    XCTAssertEqual(CategoryLedger.merged([], keeping: own, id: { $0 }), ["ardia.dismissible"])
  }
}
