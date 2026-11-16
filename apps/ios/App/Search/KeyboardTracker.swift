import UIKit

@MainActor
final class KeyboardTracker {
  private let minimumHeight: CGFloat
  private let onMove: (CGFloat) -> Void
  private var observers: [NSObjectProtocol] = []
  private var height: CGFloat = 0

  init(minimumHeight: CGFloat, onMove: @escaping (CGFloat) -> Void) {
    self.minimumHeight = minimumHeight
    self.onMove = onMove
  }

  func start() {
    guard observers.isEmpty else { return }
    for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
      let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] notification in
        let end = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        let hiding = notification.name == UIResponder.keyboardWillHideNotification
        MainActor.assumeIsolated { self?.keyboardWillMove(overlap: hiding ? 0 : Self.overlap(of: end)) }
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

  private func keyboardWillMove(overlap: CGFloat) {
    let target = overlap > minimumHeight ? overlap : 0
    guard target != height else { return }
    height = target
    onMove(target)
  }
}

struct KeyboardClock {
  let timing: UITimingCurveProvider
  let duration: TimeInterval

  @MainActor
  init?(layer: CALayer) {
    let running = (layer.animationKeys() ?? []).compactMap { layer.animation(forKey: $0) }
    if let spring = running.lazy.compactMap({ $0 as? CASpringAnimation }).first {
      timing = UISpringTimingParameters(
        mass: spring.mass,
        stiffness: spring.stiffness,
        damping: spring.damping,
        initialVelocity: .zero
      )
      duration = spring.settlingDuration
    } else if let basic = running.lazy.compactMap({ $0 as? CABasicAnimation }).first, let function = basic.timingFunction {
      var start: [Float] = [0, 0]
      var end: [Float] = [0, 0]
      function.getControlPoint(at: 1, values: &start)
      function.getControlPoint(at: 2, values: &end)
      timing = UICubicTimingParameters(
        controlPoint1: CGPoint(x: CGFloat(start[0]), y: CGFloat(start[1])),
        controlPoint2: CGPoint(x: CGFloat(end[0]), y: CGFloat(end[1]))
      )
      duration = basic.duration
    } else {
      return nil
    }
  }
}
