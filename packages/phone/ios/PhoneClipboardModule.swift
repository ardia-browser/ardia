import ExpoModulesCore
import UIKit

enum PasteboardOffers {
  static func offer(_ pasteboard: UIPasteboard, done: @escaping (String?) -> Void) {
    let hasURLs = pasteboard.hasURLs
    guard hasURLs || pasteboard.hasStrings else {
      done(nil)
      return
    }
    pasteboard.detectPatterns(for: [.probableWebURL]) { result in
      switch result {
      case .success(let found): done(found.contains(.probableWebURL) || hasURLs ? "link" : "text")
      case .failure: done(hasURLs ? "link" : "text")
      }
    }
  }

  static func read(_ pasteboard: UIPasteboard) -> String? {
    let pasted = pasteboard.hasStrings ? pasteboard.string : pasteboard.url?.absoluteString
    guard let text = pasted?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
    return text
  }
}

public final class PhoneClipboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneClipboard")

    AsyncFunction("offer") { (promise: Promise) in
      PasteboardOffers.offer(.general) { offer in promise.resolve(offer) }
    }.runOnQueue(.main)

    AsyncFunction("read") { () -> String? in
      PasteboardOffers.read(.general)
    }.runOnQueue(.main)
  }
}
