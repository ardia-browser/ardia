import Foundation
import WebKit

@MainActor
public enum PageSession {
  public static func toSave(from webView: WKWebView?, stored: Data?) -> Data? {
    guard let webView, webView.backForwardList.currentItem != nil, let live = webView.interactionState as? Data else { return stored }
    return live
  }
}
