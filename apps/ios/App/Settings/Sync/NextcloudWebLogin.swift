import AuthenticationServices
import UIKit

final class NextcloudWebLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?
  private var anchor: ASPresentationAnchor?

  func open(_ url: URL, onClose: @escaping @MainActor () -> Void) -> Bool {
    close()
    guard let anchor = Self.window() else { return false }
    self.anchor = anchor
    let session = ASWebAuthenticationSession(url: url, callback: .customScheme("ardia-nextcloud")) { _, _ in
      Task { @MainActor in onClose() }
    }
    session.prefersEphemeralWebBrowserSession = true
    session.presentationContextProvider = self
    self.session = session
    return session.start()
  }

  func close() {
    let open = session
    session = nil
    open?.cancel()
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      anchor ?? Self.window() ?? ASPresentationAnchor()
    }
  }

  private static func window() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
  }
}
