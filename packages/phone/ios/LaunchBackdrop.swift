import ArdiaDesign
import os
import SwiftUI
import UIKit

@MainActor
public enum LaunchBackdrop {
  static let contentDidAppear = Notification.Name("RCTContentDidAppearNotification")
  static let holdAfterContent: TimeInterval = 0.1
  static let fadeOut: TimeInterval = 0.15

  private static var host: UIHostingController<AnyView>?
  private static var observer: NSObjectProtocol?
  private nonisolated static let shown = OSAllocatedUnfairLock<Double?>(initialState: nil)

  nonisolated static func shownAtEpochMilliseconds() -> Double? {
    shown.withLock { $0 }
  }

  public static func install(in rootView: UIView) {
    guard host == nil else { return }
    let look = LaunchLook.recalled().look
    let host = UIHostingController(rootView: AnyView(ProfileBackdrop(look: look, themed: true).ignoresSafeArea()))
    host.view.backgroundColor = .clear
    host.view.frame = rootView.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    host.view.isUserInteractionEnabled = false
    host.view.accessibilityElementsHidden = true
    rootView.insertSubview(host.view, at: 0)
    self.host = host
    shown.withLock { $0 = Date().timeIntervalSince1970 * 1000 }
    observer = NotificationCenter.default.addObserver(forName: contentDidAppear, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated { contentAppeared() }
    }
  }

  private static func contentAppeared() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    guard let view = host?.view else { return }
    UIView.animate(withDuration: fadeOut, delay: holdAfterContent, options: [.curveEaseOut]) {
      view.alpha = 0
    } completion: { _ in
      view.removeFromSuperview()
      host = nil
    }
  }
}
