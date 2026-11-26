import ArdiaDesign
import UIKit
import WebKit

@MainActor
enum PageLastFrame {
  private struct Kept {
    weak var web: WKWebView?
    let view: UIView
    let document: Int
    let size: CGSize
  }

  private static var frames: [Kept] = []

  static func keep(_ web: WKWebView, document: Int) {
    guard web.window != nil, !web.bounds.isEmpty, let view = web.snapshotView(afterScreenUpdates: false) else { return }
    view.isUserInteractionEnabled = false
    frames.removeAll { $0.web == nil || $0.web === web }
    frames = PageLastFrameRule.trimmed(frames, adding: Kept(web: web, view: view, document: document, size: web.bounds.size))
  }

  static func take(_ web: WKWebView, document: Int, size: CGSize) -> UIView? {
    guard let index = frames.firstIndex(where: { $0.web === web }) else { return nil }
    let kept = frames.remove(at: index)
    return PageLastFrameRule.usable(savedDocument: kept.document, savedSize: kept.size, document: document, size: size) ? kept.view : nil
  }

  static func forget(_ web: WKWebView) {
    frames.removeAll { $0.web == nil || $0.web === web }
  }

  static func forgetAll() {
    frames.removeAll()
  }
}
