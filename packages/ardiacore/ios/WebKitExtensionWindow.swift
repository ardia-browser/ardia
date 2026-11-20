import AppKit
import WebKit

@available(macOS 15.4, *)
final class WebKitExtensionWindow: NSObject, WKWebExtensionWindow {
  weak var window: NSWindow?
  private weak var hub: WebKitExtensionHub?

  init(window: NSWindow, hub: WebKitExtensionHub) {
    self.window = window
    self.hub = hub
  }

  private var tabs: [WebKitTab] {
    guard let window, let hub else { return [] }
    return hub.tabs(in: window)
  }

  private var appWindowId: String? { window.flatMap { hub?.appWindowId(of: $0) } }

  func tabs(for context: WKWebExtensionContext) -> [any WKWebExtensionTab] { tabs }

  func activeTab(for context: WKWebExtensionContext) -> (any WKWebExtensionTab)? {
    guard let window, let hub else { return nil }
    return hub.activeTab(in: window)
  }

  func windowType(for context: WKWebExtensionContext) -> WKWebExtension.WindowType { .normal }

  func windowState(for context: WKWebExtensionContext) -> WKWebExtension.WindowState { window.map(Self.state(of:)) ?? .normal }

  private static func state(of window: NSWindow) -> WKWebExtension.WindowState {
    if window.isMiniaturized { return .minimized }
    if window.styleMask.contains(.fullScreen) { return .fullscreen }
    return window.isZoomed ? .maximized : .normal
  }

  func isPrivate(for context: WKWebExtensionContext) -> Bool { hub.map { WebKitStores.isPrivate($0.profile) } ?? false }

  func frame(for context: WKWebExtensionContext) -> CGRect { window?.frame ?? .null }

  func screenFrame(for context: WKWebExtensionContext) -> CGRect { window?.screen?.frame ?? .null }

  func setFrame(_ frame: CGRect, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionWindowUpdate"]))
    place(frame: frame, state: nil)
    completionHandler(nil)
  }

  func setWindowState(_ state: WKWebExtension.WindowState, for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionWindowUpdate"]))
    place(frame: nil, state: state)
    completionHandler(nil)
  }

  func place(frame: CGRect?, state: WKWebExtension.WindowState?) {
    guard let window else { return }
    if let frame {
      let current = window.frame
      let pick = { (wanted: CGFloat, now: CGFloat) in wanted.isNaN ? now : wanted }
      let size = NSSize(width: pick(frame.size.width, current.width), height: pick(frame.size.height, current.height))
      let wanted = NSRect(origin: NSPoint(x: pick(frame.origin.x, current.minX), y: pick(frame.origin.y, current.minY)), size: size)
      if wanted != current { window.setFrame(wanted, display: true) }
    }
    guard let state, state != Self.state(of: window) else { return }
    if window.isMiniaturized { window.deminiaturize(nil) }
    if window.styleMask.contains(.fullScreen), state != .fullscreen { window.toggleFullScreen(nil) }
    switch state {
    case .minimized:
      if LaunchConfig.shared.background { NSLog("[webkit] extension asked to minimize a window (background mode, not minimized)") } else { window.miniaturize(nil) }
    case .maximized:
      if !window.isZoomed { window.zoom(nil) }
    case .fullscreen:
      window.toggleFullScreen(nil)
    case .normal:
      if window.isZoomed { window.zoom(nil) }
    @unknown default:
      break
    }
  }

  func focus(for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    guard let hub, let appWindowId else { return completionHandler(nil) }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionWindowUpdate"]))
    hub.ask("focusWindow", ["windowId": appWindowId]) { completionHandler(WebKitExtensionHub.failure($0)) }
  }

  func close(for context: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    guard let hub, let appWindowId else { return completionHandler(nil) }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "extensionWindowRemove"]))
    hub.ask("closeWindow", ["windowId": appWindowId]) { completionHandler(WebKitExtensionHub.failure($0)) }
  }
}
