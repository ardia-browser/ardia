import AppKit
import WebKit

enum WebKitFullscreenPage {
  private static let registerAdapter = NSSelectorFromString("registerScrollViewSeparatorTrackingAdapter:")
  private static let unregisterAdapter = NSSelectorFromString("unregisterScrollViewSeparatorTrackingAdapter:")
  private typealias RegisterAdapter = @convention(c) (AnyObject, Selector, AnyObject) -> ObjCBool
  private typealias UnregisterAdapter = @convention(c) (AnyObject, Selector, AnyObject) -> Void

  static func isOn(_ state: WKWebView.FullscreenState) -> Bool {
    state == .enteringFullscreen || state == .inFullscreen
  }

  static func reportsChange(was shownFullscreen: Bool, now state: WKWebView.FullscreenState) -> Bool {
    isOn(state) != shownFullscreen
  }

  static func isPlaceholder(_ view: NSView) -> Bool {
    NSStringFromClass(type(of: view)).contains("FullScreenPlaceholder")
  }

  static func hidesPage(_ page: NSView, in tab: NSView, visible: Bool) -> Bool {
    !visible && page.superview === tab
  }

  static func heldElsewhere(_ page: NSView, from tab: NSView, inFullscreen: Bool) -> Bool {
    inFullscreen && page.superview != nil && page.superview !== tab
  }

  static func seen(visible: Bool, heldInFullscreen: Bool, windowSeen: Bool, fullscreenWindowSeen: Bool) -> Bool {
    heldInFullscreen ? fullscreenWindowSeen : visible && windowSeen
  }

  static func placeholders(in tab: NSView) -> [NSView] {
    tab.subviews.filter(isPlaceholder)
  }

  static func takePlaceholders(from tab: NSView) -> [NSView] {
    let found = placeholders(in: tab)
    unregister(found, from: tab.window)
    for view in found { view.removeFromSuperview() }
    return found
  }

  static func give(_ placeholders: [NSView], to tab: NSView) {
    for view in placeholders {
      view.frame = tab.bounds
      tab.addSubview(view)
    }
    register(placeholders, with: tab.window)
  }

  static func register(_ placeholders: [NSView], with window: NSWindow?) {
    guard let window, window.responds(to: registerAdapter) else { return }
    let call = unsafeBitCast(window.method(for: registerAdapter), to: RegisterAdapter.self)
    for view in placeholders { _ = call(window, registerAdapter, view) }
  }

  static func unregister(_ placeholders: [NSView], from window: NSWindow?) {
    guard let window, window.responds(to: unregisterAdapter) else { return }
    let call = unsafeBitCast(window.method(for: unregisterAdapter), to: UnregisterAdapter.self)
    for view in placeholders { call(window, unregisterAdapter, view) }
  }

  static func reclaims(_ page: NSView, into tab: NSView, inFullscreen: Bool, settled: Bool) -> Bool {
    !inFullscreen && page.superview !== tab && (settled || page.window == nil)
  }
}

struct WebKitFullscreenExits {
  private(set) var generation = 0

  mutating func changed() -> Int {
    generation += 1
    return generation
  }
}

struct WebKitFullscreenReclaim {
  let generation: Int
  let epoch: String
  weak var page: NSView?

  func belongs(to current: Int, page shown: NSView?) -> Bool {
    generation == current && page != nil && page === shown
  }

  func counts(under currentEpoch: String) -> Bool { epoch == currentEpoch }
}
