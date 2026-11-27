import ArdiaBrowser
import Foundation
import LinkPresentation
import UIKit

extension PhonePages {
  func share(_ pageID: String, address: String, title: String) async -> String? {
    guard BrowserURL.isSyncable(address), let target = URL(string: address) else { return nil }
    var items: [Any] = [SharedPageLink(url: target, title: title)]
    if let webView = page(pageID)?.webView {
      let info = UIPrintInfo.printInfo()
      info.outputType = .general
      info.jobName = title.isEmpty ? (BrowserURL.host(of: address) ?? address) : title
      items.append(info)
      items.append(webView.viewPrintFormatter())
    }
    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
    return await withCheckedContinuation { continuation in
      let answer = ShareAnswer(continuation)
      controller.completionWithItemsHandler = { activity, completed, _, _ in
        guard completed || activity == nil else { return }
        answer.give(completed ? activity?.rawValue : nil)
      }
      if !Self.presentAnchored(controller) { answer.give(nil) }
    }
  }

  @discardableResult
  static func presentAnchored(_ controller: UIViewController) -> Bool {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard var top = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { return false }
    while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
    if let popover = controller.popoverPresentationController {
      popover.sourceView = top.view
      popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY, width: 0, height: 0)
      popover.permittedArrowDirections = .down
    }
    top.present(controller, animated: true)
    return true
  }

  func watchShareRequests(generation: Int) {
    let request = withObservationTracking {
      engine.shareRequest
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.shareGeneration == generation else { return }
        self.shareGeneration += 1
        self.watchShareRequests(generation: self.shareGeneration)
      }
    }
    guard let request else { return }
    engine.shareRequest = nil
    Self.present(UIActivityViewController(activityItems: [request], applicationActivities: nil))
  }

  static func present(_ controller: UIViewController) {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard var top = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { return }
    while let presented = top.presentedViewController { top = presented }
    top.present(controller, animated: true)
  }
}

final class ShareAnswer: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<String?, Never>?

  init(_ continuation: CheckedContinuation<String?, Never>) {
    self.continuation = continuation
  }

  func give(_ activity: String?) {
    lock.lock()
    let waiting = continuation
    continuation = nil
    lock.unlock()
    waiting?.resume(returning: activity)
  }
}

final class SharedPageLink: NSObject, UIActivityItemSource {
  let url: URL
  let title: String

  init(url: URL, title: String) {
    self.url = url
    self.title = title
  }

  func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any { url }

  func activityViewController(_ activityViewController: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?) -> Any? { url }

  func activityViewController(_ activityViewController: UIActivityViewController, subjectForActivityType activityType: UIActivity.ActivityType?) -> String { title }

  func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
    let metadata = LPLinkMetadata()
    metadata.originalURL = url
    metadata.url = url
    metadata.title = title.isEmpty ? nil : title
    return metadata
  }
}
