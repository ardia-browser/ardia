import AppKit
import ExpoModulesCore

final class WebKitTabView: PageTabHost, WebKitTabDelegate {
  let onPageEvent = EventDispatcher()

  override var pageEventDispatcher: EventDispatcher { onPageEvent }

  override class func makePage() -> PageTab { WebKitTab(frame: .zero) }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    (page as? WebKitTab)?.delegate = self
  }

  func webKitTab(_ tab: WebKitTab, event name: String, payload: [String: Any]) {
    ArdiaWebView.devNoteEvent(name, payload: payload, browser: tab.browserId)
    send(name, payload: payload)
  }
}
