import AppKit

final class WebKitPageContainer: NSView {
  func hold(_ page: NSView) {
    page.frame = bounds
    page.autoresizingMask = [.width, .height]
    addSubview(page)
  }

  func fill(_ tab: NSView) {
    guard frame != tab.bounds else { return }
    frame = tab.bounds
  }
}
