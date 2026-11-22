import AppKit
import XCTest
@testable import ArdiaUpdaterCore

final class ApplicationIconNameTests: XCTestCase {
  private var named: NSImage? { NSImage(named: ApplicationIconName.name) }

  func testAPickedIconBecomesTheNamedApplicationIconAndTheBundleImageComesBack() {
    let bundle = ApplicationIconName.bundleImage
    let midnight = NSImage(size: NSSize(width: 8, height: 8))
    let noir = NSImage(size: NSSize(width: 8, height: 8))

    XCTAssertTrue(ApplicationIconName.register(midnight))
    XCTAssertTrue(named === midnight)

    XCTAssertTrue(ApplicationIconName.register(midnight))
    XCTAssertTrue(named === midnight)

    XCTAssertTrue(ApplicationIconName.register(noir))
    XCTAssertTrue(named === noir)
    XCTAssertNil(midnight.name())

    XCTAssertTrue(ApplicationIconName.register(bundle))
    XCTAssertNil(noir.name())
    if let bundle { XCTAssertTrue(named === bundle) }
  }

  func testNoIconStillTakesTheNameAwayFromThePickedOne() {
    let midnight = NSImage(size: NSSize(width: 8, height: 8))
    XCTAssertTrue(ApplicationIconName.register(midnight))
    XCTAssertTrue(ApplicationIconName.register(nil))
    XCTAssertNil(midnight.name())
    XCTAssertFalse(named === midnight)
    XCTAssertTrue(ApplicationIconName.register(ApplicationIconName.bundleImage))
  }
}
