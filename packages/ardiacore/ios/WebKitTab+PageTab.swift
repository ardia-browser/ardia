import AppKit
import WebKit

extension WebKitTab: PageTab {
  static let unsupported = "unsupported"

  var standalone: Bool { get { false } set {} }
  var temporary: Bool { get { false } set {} }
  var temporarySource: String? { get { nil } set {} }
  var extensionHost: String? { get { nil } set {} }
  var warm: Bool { get { false } set {} }
  var neighbour: Bool { get { false } set {} }
  var pageColor: String? { get { nil } set {} }
  var contentsBackgroundColor: NSColor? { get { nil } set {} }
  var shownURL: String? { get { nil } set {} }
  var frozen: Bool { get { false } set {} }
  var mediaCaptureSourceId: String? { nil }

  func startPage() { start() }

  func closePage() {
    if Thread.isMainThread { return close() }
    DispatchQueue.main.async { self.close() }
  }

  func navigationEntries(_ completion: @escaping ([[String: Any]]) -> Void) { completion(navigationEntries()) }

  func copyPicture(ofWindowArea area: NSRect, completion: @escaping (CGImage?) -> Void) {
    guard let view = webView, let window, !view.isHidden else { return completion(nil) }
    let top = window.contentView?.frame.height ?? 0
    let inWindow = NSRect(x: area.minX, y: top - area.minY - area.height, width: area.width, height: area.height)
    let inPage = view.convert(inWindow, from: nil).intersection(view.bounds)
    guard !inPage.isEmpty else { return completion(nil) }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = inPage
    view.takeSnapshot(with: configuration) { image, _ in
      completion(image?.cgImage(forProposedRect: nil, context: nil, hints: nil))
    }
  }

  func securityInfo(_ completion: @escaping ([String: Any]) -> Void) { completion(securityInfo()) }

  func showDevTools(panel: String?) {}

  func downloadImage(_ url: String, maxPixels: Int, completion: @escaping ([String: Any]?) -> Void) {
    downloadFavicon(url, completion: completion)
  }

  func requestPictureInPicture(clickAt: Double, control: Int, _ completion: @escaping (Bool) -> Void) {
    setPictureInPicture(true) { completion($0 == .opened) }
  }

  func takeControlPress(clickAt: Double, control: Int) -> Bool { true }

  func exitPictureInPicture() { setPictureInPicture(false) { _ in } }

  func pageCookies(_ urls: [String], completion: @escaping ([[String: Any]]?) -> Void) { completion([]) }

  func openBlockedPopup(_ popupId: String, always: Bool) {}

  func resolvePasswordPrompt(_ action: String, username: String?, password: String?) {}

  func resolveAutofillPrompt(_ promptId: Int, action: String) {}

  func executeExtensionAction(_ extensionId: String) -> String? { nil }

  func resolveDisplayMedia(_ requestId: String, sourceId: String?, audio: Bool) {}

  func notificationAction(_ notificationId: String, action: String) {}

  func resolveUnresponsive(terminate: Bool) {}

  func discard(unload: Bool) -> String { Self.unsupported }

  func sleepIfHidden(for seconds: Double) -> [NSNumber] { [-1] }
}
