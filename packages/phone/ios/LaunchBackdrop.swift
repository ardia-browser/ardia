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
    let host = UIHostingController(rootView: AnyView(LaunchProfileBackdrop(recalled: LaunchLook.recalled()).ignoresSafeArea()))
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

private struct LaunchProfileBackdrop: View {
  let recalled: LaunchLook.Recalled

  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let drawn = recalled.drawn(appDark: colorScheme == .dark)
    ProfileBackdrop(look: drawn.colors.look, themeLook: drawn.colors.themeLook, themed: true)
      .environment(\.colorScheme, drawn.dark.map { $0 ? .dark : .light } ?? colorScheme)
  }
}
