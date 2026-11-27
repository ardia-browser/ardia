import AppKit
import WebKit

extension WebKitTab {
  func listen(to view: WebKitWebView) {
    view.onFocus = { [weak self] in self?.pageFocused() }
    view.onPressRefused = { [weak self] in self?.pagePressRefused() }
    view.onNavigate = { [weak self] in self?.pageNavigated($0) }
  }

  func stopListening(to view: WebKitWebView) {
    view.onFocus = nil
    view.onPressRefused = nil
    view.onNavigate = nil
  }

  func noteShownChanged() {
    let shown = visible && selected
    if shown, !wasShown { takeFocusWhenShown() }
    wasShown = shown
  }

  private func takeFocusWhenShown(tries: Int = 20) {
    DispatchQueue.main.asyncAfter(deadline: .now() + (tries == 20 ? 0 : 0.05)) { [weak self] in
      guard let self, self.visible, self.selected, let view = self.webView, let window = view.window else { return }
      let responder = window.firstResponder
      if view.isHiddenOrHasHiddenAncestor {
        return tries > 0 ? self.takeFocusWhenShown(tries: tries - 1) : self.focusRestored("gaveUp")
      }
      if responder === view || (responder as? NSView)?.isDescendant(of: view) == true { return }
      let free = responder == nil || responder === window || (responder as? NSView)?.isHiddenOrHasHiddenAncestor == true
      guard free || Self.isOtherPage(responder, than: view) else { return self.focusRestored("kept") }
      self.focusRestored(window.makeFirstResponder(view) ? "focused" : "refused")
    }
  }

  private func focusRestored(_ outcome: String) { emit("focusRestore", ["outcome": outcome]) }

  private static func isOtherPage(_ responder: NSResponder?, than view: NSView) -> Bool {
    guard let held = responder as? NSView, held !== view, !held.isDescendant(of: view), !held.isHiddenOrHasHiddenAncestor else { return false }
    return held is WKWebView || String(describing: type(of: held)) == "RenderWidgetHostViewCocoa"
  }

  private func pageFocused() { emit("focus") }

  private func pagePressRefused() { emit("pagePress", ["refused": true]) }

  private func pageNavigated(_ direction: WebKitPagePresses.Navigation) {
    emit("command", ["command": direction == .back ? "back" : "forward", "text": ""])
  }
}
