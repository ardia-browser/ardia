import AppKit
import XCTest

@testable import ArdiaPluginCore

final class PluginPageGateTests: XCTestCase {
  private final class Page {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
    let tab = NSView()
    let view = NSView()
    let watcher = WindowWatcher()
    var events: [String] = []
    var bindings = 0
    lazy var gate = PluginPageGate(
      bind: { [weak self] in
        guard let self else { return }
        bindings += 1
        events.append("bind b\(bindings)")
      },
      unbind: { [weak self] in
        guard let self else { return }
        events.append("unbind b\(bindings)")
      },
      load: { [weak self] in self?.events.append("load") })

    init() {
      view.addSubview(watcher)
      tab.addSubview(view)
      window.contentView?.addSubview(tab)
      watcher.changed = { [weak self] inWindow in self?.gate.windowChanged(inWindow: inWindow) }
    }

    func rebuild() {
      gate.pageCreated(inWindow: view.window != nil)
      gate.wantsLoad()
    }

    func detachTab() { tab.removeFromSuperview() }
    func attachTab() { window.contentView?.addSubview(tab) }
  }

  func testAPageBuiltInAWindowBindsThenLoads() {
    let page = Page()
    page.rebuild()
    XCTAssertEqual(page.events, ["bind b1", "load"])
  }

  func testARebuildWhileAnAncestorIsDetachedBindsAndLoadsOnlyOnReturn() {
    let page = Page()
    page.rebuild()
    page.events = []
    page.detachTab()
    XCTAssertEqual(page.events, ["unbind b1"])
    page.rebuild()
    XCTAssertFalse(page.gate.bound, "a page built while its tab is out of the window has no bridge")
    XCTAssertEqual(page.events, ["unbind b1"], "nothing binds and nothing loads while the page is out of the window")
    page.attachTab()
    XCTAssertEqual(page.events, ["unbind b1", "bind b2", "load"], "on return the bridge is installed first, then the first load")
    XCTAssertTrue(page.gate.bound)
  }

  func testAReturningPageGetsAFreshBindingAndKeepsItsDocument() {
    let page = Page()
    page.rebuild()
    page.detachTab()
    page.attachTab()
    XCTAssertEqual(page.events, ["bind b1", "load", "unbind b1", "bind b2"], "a loaded page isn't reloaded, but its bridge is new")
  }

  func testALoadAskedForWhileDetachedWaitsForTheBridge() {
    let page = Page()
    page.rebuild()
    page.detachTab()
    page.events = []
    page.gate.wantsLoad()
    page.gate.wantsLoad()
    XCTAssertEqual(page.events, [])
    page.attachTab()
    XCTAssertEqual(page.events, ["bind b2", "load"], "one load, after the bridge")
  }

  func testRemovingThePageUnbindsAndForgetsAWaitingLoad() {
    let page = Page()
    page.detachTab()
    page.rebuild()
    page.gate.pageRemoved()
    page.attachTab()
    XCTAssertEqual(page.events, [], "no page, so nothing binds or loads on return")
  }
}
