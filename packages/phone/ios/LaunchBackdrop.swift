import ArdiaDesign
import os
import SwiftUI
import UIKit

@MainActor
public enum LaunchBackdrop {
  static let contentDidAppear = Notification.Name("RCTContentDidAppearNotification")
  static let holdAfterReady: TimeInterval = 0.05
  static let fadeOut: TimeInterval = 0.15
  static let readyCap: Duration = .seconds(4)

  private static var host: UIHostingController<AnyView>?
  private static var observer: NSObjectProtocol?
  private static var contentShown = false
  private static var interfaceReady = false
  private static var fading = false
  private static var capTask: Task<Void, Never>?
  private nonisolated static let shown = OSAllocatedUnfairLock<Double?>(initialState: nil)

  nonisolated static func shownAtEpochMilliseconds() -> Double? {
    shown.withLock { $0 }
  }

  public static func install(in rootView: UIView) {
    guard host == nil else { return }
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    capTask?.cancel()
    capTask = nil
    contentShown = false
    fading = false
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

  public static func interfaceDrawn() {
    interfaceReady = true
    if contentShown { fade() }
  }

  private static func contentAppeared() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    contentShown = true
    if interfaceReady {
      fade()
      return
    }
    capTask = Task { @MainActor in
      try? await Task.sleep(for: readyCap)
      guard !Task.isCancelled else { return }
      fade()
    }
  }

  private static func fade() {
    capTask?.cancel()
    capTask = nil
    guard !fading, let view = host?.view else { return }
    fading = true
    UIView.animate(withDuration: fadeOut, delay: holdAfterReady, options: [.curveEaseOut]) {
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
