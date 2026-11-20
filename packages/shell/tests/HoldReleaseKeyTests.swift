import XCTest
@testable import ArdiaUpdaterCore

final class HoldReleaseKeyTests: XCTestCase {
  private let browser = HoldReleaseKey.Candidate(visible: true, miniaturized: false, canBecomeKey: true, normalLevel: true, browser: true, onActiveSpace: true)
  private let hidden = HoldReleaseKey.Candidate(visible: false, miniaturized: false, canBecomeKey: true, normalLevel: true, browser: true, onActiveSpace: true)
  private let minimized = HoldReleaseKey.Candidate(visible: true, miniaturized: true, canBecomeKey: true, normalLevel: true, browser: true, onActiveSpace: true)
  private let panel = HoldReleaseKey.Candidate(visible: true, miniaturized: false, canBecomeKey: false, normalLevel: true, browser: true, onActiveSpace: true)
  private let floating = HoldReleaseKey.Candidate(visible: true, miniaturized: false, canBecomeKey: true, normalLevel: false, browser: true, onActiveSpace: true)

  private let popup = HoldReleaseKey.Candidate(visible: true, miniaturized: false, canBecomeKey: true, normalLevel: true, browser: false, onActiveSpace: true)
  private let elsewhere = HoldReleaseKey.Candidate(visible: true, miniaturized: false, canBecomeKey: true, normalLevel: true, browser: true, onActiveSpace: false)

  func testAPopupOrABrowserWindowOnAnotherSpaceIsNeverMadeKey() {
    XCTAssertEqual(HoldReleaseKey.pick(hasKey: false, frontToBack: [popup, elsewhere, browser]), 2)
    XCTAssertNil(HoldReleaseKey.pick(hasKey: false, frontToBack: [popup, elsewhere]))
  }

  func testAReleaseWithNoKeyWindowMakesTheFrontBrowserWindowKey() {
    XCTAssertEqual(HoldReleaseKey.pick(hasKey: false, frontToBack: [browser, browser]), 0)
  }

  func testAReleaseThatAlreadyHasAKeyWindowLeavesItAlone() {
    XCTAssertNil(HoldReleaseKey.pick(hasKey: true, frontToBack: [browser]))
  }

  func testHiddenMinimizedKeylessAndFloatingWindowsAreSkipped() {
    XCTAssertEqual(HoldReleaseKey.pick(hasKey: false, frontToBack: [hidden, minimized, panel, floating, browser]), 4)
  }

  func testNothingToMakeKeyPicksNothing() {
    XCTAssertNil(HoldReleaseKey.pick(hasKey: false, frontToBack: [hidden, panel]))
  }
}
