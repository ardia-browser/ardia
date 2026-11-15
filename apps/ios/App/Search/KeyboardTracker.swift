import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class KeyboardTracker {
  private(set) var animation: Animation? = KeyboardTracker.animation(duration: 0.25, curve: KeyboardTracker.systemCurve)
  private(set) var overlap: CGFloat = 0
  private(set) var changes = 0
  @ObservationIgnored private var observers: [NSObjectProtocol] = []

  static let systemCurve = 7

  func start() {
    guard observers.isEmpty else { return }
    for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
      let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] notification in
        let info = notification.userInfo ?? [:]
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int) ?? Self.systemCurve
        let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        let hiding = notification.name == UIResponder.keyboardWillHideNotification
        MainActor.assumeIsolated {
          guard let self else { return }
          self.animation = Self.animation(duration: duration, curve: curve)
          self.overlap = hiding ? 0 : Self.overlap(of: end)
          self.changes += 1
        }
      }
      observers.append(observer)
    }
  }

  static func overlap(of frame: CGRect?) -> CGFloat {
    guard let frame, !frame.isEmpty else { return 0 }
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
    guard let window else { return 0 }
    let local = window.convert(frame, from: window.screen.coordinateSpace)
    return max(0, window.bounds.maxY - local.minY)
  }

  static func animation(duration: Double, curve: Int) -> Animation? {
    guard duration > 0 else { return nil }
    if curve == systemCurve {
      return Animation(KeyboardCurve(rate: KeyboardCurve.rateTimesDuration / duration))
    }
    return .easeInOut(duration: duration)
  }
}
