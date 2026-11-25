import AppKit
import XCTest

@testable import ArdiaPluginCore

final class PluginWindowWatcherTests: XCTestCase {
  func testRemovingAnAncestorTellsTheViewItLeftTheWindowAndAddingItBackTellsItItReturned() {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
    let tab = NSView()
    let page = NSView()
    let watcher = WindowWatcher()
    var seen: [Bool] = []
    watcher.changed = { seen.append($0) }
    page.addSubview(watcher)
    tab.addSubview(page)
    window.contentView?.addSubview(tab)
    tab.removeFromSuperview()
    window.contentView?.addSubview(tab)
    XCTAssertEqual(seen, [true, false, true], "the page's own removeFromSuperview never ran, but it still learns it left")
  }

  func testTheSnapshotLookupNeverKeepsAPageAlive() {
    let lookup = WeakLookup<NSView>()
    autoreleasepool {
      let page = NSView()
      lookup["example"] = page
      XCTAssertNotNil(lookup["example"])
    }
    XCTAssertNil(lookup["example"])
  }
}
