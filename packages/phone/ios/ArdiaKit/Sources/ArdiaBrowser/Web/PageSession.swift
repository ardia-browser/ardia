import Foundation
import WebKit

@MainActor
public enum PageSession {
  public static func toSave(from webView: WKWebView?, stored: Data?) -> Data? {
    guard let webView, webView.backForwardList.currentItem != nil, let live = webView.interactionState as? Data else { return stored }
    return live
  }

  public static func restore(_ session: Data, into webView: WKWebView, then navigation: (WKWebView) -> Void) {
    webView.interactionState = session
    navigation(webView)
  }

  public static func restore(_ session: Data, into webView: WKWebView, goingBy step: Int) -> Bool {
    webView.interactionState = session
    let list = webView.backForwardList
    guard let target = step < 0 ? list.backItem : list.forwardItem else { return false }
    webView.go(to: target)
    return true
  }
}
