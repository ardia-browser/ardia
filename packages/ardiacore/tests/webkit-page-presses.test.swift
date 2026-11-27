import AppKit

final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

final class PageView: NSView {
  var gated = true
  var presses = WebKitPagePresses()
  var received: [String] = []
  var navigated: [WebKitPagePresses.Navigation] = []
  var refused = 0

  private func take(_ name: String, _ event: NSEvent) {
    if gated {
      switch presses.verdict(for: event, on: self) {
      case .pass: break
      case .drop, .swallow: return
      case .refuse:
        refused += 1
        return
      case .navigate(let direction):
        navigated.append(direction)
        return
      }
    }
    received.append(name)
  }

  override func mouseDown(with event: NSEvent) { take("down", event) }
  override func mouseDragged(with event: NSEvent) { take("dragged", event) }
  override func mouseUp(with event: NSEvent) { take("up", event) }
  override func rightMouseDown(with event: NSEvent) { take("rightDown", event) }
  override func rightMouseUp(with event: NSEvent) { take("rightUp", event) }
  override func otherMouseDown(with event: NSEvent) { take("otherDown(\(event.buttonNumber))", event) }
  override func otherMouseDragged(with event: NSEvent) { take("otherDragged(\(event.buttonNumber))", event) }
  override func otherMouseUp(with event: NSEvent) { take("otherUp(\(event.buttonNumber))", event) }
}

struct Scene {
  let window: NSWindow
  let page: PageView
  let overlay: NSView
  let pageChild: NSView

  init() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
    window.contentView = root
    page = PageView(frame: root.bounds)
    root.addSubview(page)
    pageChild = NSView(frame: NSRect(x: 300, y: 200, width: 80, height: 80))
    page.addSubview(pageChild)
    overlay = FlippedView(frame: NSRect(x: 0, y: 0, width: 100, height: 300))
    root.addSubview(overlay)
  }

  func event(_ type: NSEvent.EventType, _ at: NSPoint) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
      pressure: [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) ? 0 : 1)!
  }

  func otherEvent(_ type: NSEvent.EventType, _ at: NSPoint, button: Int, modifiers: NSEvent.ModifierFlags = []) -> NSEvent {
    let base = NSEvent.mouseEvent(
      with: type, location: at, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
      pressure: type == .otherMouseUp ? 0 : 1)!
    let cg = base.cgEvent!.copy()!
    cg.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button))
    return NSEvent(cgEvent: cg)!
  }

  func hit(_ at: NSPoint) -> NSView? { window.contentView?.superview?.hitTest(at) }
}

@main
struct WebKitPagePressesTests {
  static var failures = 0

  static func check(_ ok: Bool, _ name: String, _ detail: @autoclosure () -> String = "") {
    if ok { return }
    failures += 1
    print("FAIL \(name) \(detail())")
  }

  static func expect(_ actual: [String], _ wanted: [String], _ name: String) {
    check(actual == wanted, name, "got \(actual), wanted \(wanted)")
  }

  static let underOverlay = NSPoint(x: 37, y: 251)
  static let underOverlayHigh = NSPoint(x: 88, y: 12)
  static let onPage = NSPoint(x: 173, y: 64)
  static let onPageChild = NSPoint(x: 342, y: 241)

  static func main() {
    NSApplication.shared.setActivationPolicy(.prohibited)

    var s = Scene()
    check(s.hit(underOverlay) === s.overlay, "the overlay point hits the overlay", "\(String(describing: s.hit(underOverlay)))")
    check(s.hit(onPageChild) === s.pageChild, "the child point hits the page's child view", "\(String(describing: s.hit(onPageChild)))")

    s = Scene()
    s.page.gated = false
    s.overlay.mouseDown(with: s.event(.leftMouseDown, underOverlay))
    s.overlay.mouseUp(with: s.event(.leftMouseUp, underOverlay))
    s.overlay.rightMouseDown(with: s.event(.rightMouseDown, underOverlayHigh))
    s.overlay.rightMouseUp(with: s.event(.rightMouseUp, underOverlayHigh))
    expect(s.page.received, ["down", "up", "rightDown", "rightUp"], "AppKit forwards a click the overlay doesn't take to the page beneath (the old WebKit page took it)")

    s = Scene()
    s.overlay.mouseDown(with: s.event(.leftMouseDown, underOverlay))
    s.overlay.mouseUp(with: s.event(.leftMouseUp, underOverlay))
    expect(s.page.received, [], "a click on the sidebar drawn over the page never reaches the page")
    check(s.page.refused == 1, "the overlay press counts once as refused", "\(s.page.refused)")

    s = Scene()
    s.overlay.mouseDown(with: s.event(.leftMouseDown, underOverlayHigh))
    s.overlay.mouseUp(with: s.event(.leftMouseUp, underOverlayHigh))
    expect(s.page.received, [], "an off-centre click near the overlay's top edge stays off the page")

    s = Scene()
    s.overlay.mouseDown(with: s.event(.leftMouseDown, underOverlay))
    s.page.isHidden = true
    s.overlay.mouseUp(with: s.event(.leftMouseUp, underOverlay))
    s.page.mouseUp(with: s.event(.leftMouseUp, underOverlay))
    s.page.isHidden = false
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    s.page.mouseUp(with: s.event(.leftMouseUp, onPage))
    expect(s.page.received, ["down", "up"], "a sidebar press that hides the page on mouse down: its release is dropped, and the next click on the page goes through")
    check(s.page.refused == 1, "the press that switched tabs counts once as refused", "\(s.page.refused)")

    s = Scene()
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    let root = s.page.superview!
    s.page.removeFromSuperview()
    root.addSubview(s.page, positioned: .below, relativeTo: s.overlay)
    s.overlay.mouseDown(with: s.event(.leftMouseDown, underOverlay))
    s.overlay.mouseUp(with: s.event(.leftMouseUp, underOverlay))
    expect(s.page.received, ["down"], "a page that lost the release of its press while out of the window still refuses the next sidebar click")

    s = Scene()
    s.page.rightMouseDown(with: s.event(.rightMouseDown, onPage))
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    s.page.mouseUp(with: s.event(.leftMouseUp, onPage))
    s.page.rightMouseDown(with: s.event(.rightMouseDown, onPage))
    s.page.rightMouseUp(with: s.event(.rightMouseUp, onPage))
    expect(s.page.received, ["rightDown", "down", "up", "rightDown", "rightUp"], "a page press whose release a menu took doesn't eat the next click on the page")

    s = Scene()
    s.overlay.mouseUp(with: s.event(.leftMouseUp, underOverlay))
    expect(s.page.received, [], "a release from a press that began on an overlay is dropped")

    s = Scene()
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    s.page.mouseUp(with: s.event(.leftMouseUp, onPage))
    expect(s.page.received, ["down", "up"], "a click on the page itself goes through")

    s = Scene()
    s.pageChild.mouseDown(with: s.event(.leftMouseDown, onPageChild))
    s.pageChild.mouseUp(with: s.event(.leftMouseUp, onPageChild))
    expect(s.page.received, ["down", "up"], "a click that hits a view inside the page goes through")

    s = Scene()
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    s.page.mouseDragged(with: s.event(.leftMouseDragged, underOverlay))
    s.page.mouseUp(with: s.event(.leftMouseUp, underOverlay))
    expect(s.page.received, ["down", "dragged", "up"], "a press that began on the page keeps its drag and release over the overlay")

    s = Scene()
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    s.page.isHidden = true
    s.page.mouseUp(with: s.event(.leftMouseUp, onPage))
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    expect(s.page.received, ["down", "up"], "a page hidden mid-press still gets that release, and no new press while hidden")

    s = Scene()
    s.overlay.rightMouseDown(with: s.event(.rightMouseDown, underOverlay))
    s.overlay.rightMouseUp(with: s.event(.rightMouseUp, underOverlay))
    s.page.rightMouseDown(with: s.event(.rightMouseDown, onPage))
    s.page.rightMouseUp(with: s.event(.rightMouseUp, onPage))
    expect(s.page.received, ["rightDown", "rightUp"], "a right click over the overlay is refused, one on the page goes through")

    s = Scene()
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 3))
    s.page.otherMouseDragged(with: s.otherEvent(.otherMouseDragged, onPage, button: 3))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 3))
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 4))
    s.page.otherMouseDragged(with: s.otherEvent(.otherMouseDragged, onPage, button: 4))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 4))
    expect(s.page.received, [], "back and forward mouse buttons never reach the page view")
    check(s.page.navigated == [.back, .forward], "back and forward mouse buttons navigate on release", "\(s.page.navigated)")

    s = Scene()
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 2))
    s.page.otherMouseDragged(with: s.otherEvent(.otherMouseDragged, onPage, button: 2))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 2))
    expect(s.page.received, ["otherDown(2)", "otherDragged(2)", "otherUp(2)"], "middle click still passes through to the page")
    check(s.page.navigated.isEmpty, "middle click does not trigger history navigation", "\(s.page.navigated)")

    s = Scene()
    s.overlay.otherMouseDown(with: s.otherEvent(.otherMouseDown, underOverlay, button: 3))
    s.overlay.otherMouseUp(with: s.otherEvent(.otherMouseUp, underOverlay, button: 3))
    s.overlay.otherMouseDown(with: s.otherEvent(.otherMouseDown, underOverlay, button: 4))
    s.overlay.otherMouseUp(with: s.otherEvent(.otherMouseUp, underOverlay, button: 4))
    expect(s.page.received, [], "back and forward mouse presses over an overlay stay off the page")
    check(s.page.navigated.isEmpty, "back and forward mouse presses over an overlay do not navigate", "\(s.page.navigated)")
    check(s.page.refused == 2, "overlay back/forward presses count as refused", "\(s.page.refused)")

    s = Scene()
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 3))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 4))
    expect(s.page.received, [], "orphan back/forward releases stay off the page")
    check(s.page.navigated.isEmpty, "orphan back/forward releases do not navigate", "\(s.page.navigated)")

    s = Scene()
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 3))
    s.page.isHidden = true
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 3))
    expect(s.page.received, [], "back release after the page hides stays off the page")
    check(s.page.navigated.isEmpty, "back release after the page hides does not navigate", "\(s.page.navigated)")

    s = Scene()
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 3))
    s.page.removeFromSuperview()
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 3))
    expect(s.page.received, [], "back release after the page detaches from its window stays off the page")
    check(s.page.navigated.isEmpty, "back release after detachment does not navigate", "\(s.page.navigated)")

    s = Scene()
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 3, modifiers: [.shift]))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 3, modifiers: [.shift]))
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 4, modifiers: [.command]))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 4, modifiers: [.command]))
    expect(s.page.received, [], "modifier-held back and forward buttons still stay off the page")
    check(s.page.navigated == [.back, .forward], "modifier-held back and forward buttons still navigate when unbound", "\(s.page.navigated)")

    s = Scene()
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 3))
    s.page.otherMouseDragged(with: s.otherEvent(.otherMouseDragged, underOverlay, button: 3))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, underOverlay, button: 3))
    expect(s.page.received, [], "a back press that drifts onto an overlay before release stays off the page")
    check(s.page.navigated == [.back], "a back press that began on the page still navigates when released over an overlay", "\(s.page.navigated)")

    s = Scene()
    s.page.mouseDown(with: s.event(.leftMouseDown, onPage))
    s.page.otherMouseDown(with: s.otherEvent(.otherMouseDown, onPage, button: 3))
    s.page.otherMouseUp(with: s.otherEvent(.otherMouseUp, onPage, button: 3))
    s.page.mouseUp(with: s.event(.leftMouseUp, onPage))
    expect(s.page.received, ["down", "up"], "back button press does not disturb an independent left-button press")
    check(s.page.navigated == [.back], "back button navigates while left button is held", "\(s.page.navigated)")

    if failures > 0 { exit(1) }
    print("ok")
  }
}
