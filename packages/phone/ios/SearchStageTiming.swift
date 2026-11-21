import ArdiaDesign
import QuartzCore
import SwiftUI
import UIKit

nonisolated extension Motion {
  static let stageDepartCurve = ArdiaDesign.MotionCurve(0.2, 0, 0, 1, duration: 0.2)
  static let stageWiden = Spring(response: 0.18, dampingRatio: 1)
  static let stageDeepen = Spring(response: 0.24, dampingRatio: 1)
  static let stageOpenWiden = Spring(response: 0.12, dampingRatio: 1)
  static let stageFold = Spring(response: 0.1, dampingRatio: 1)
  static let stageFoldBeforeNarrowing: CGFloat = 0.8
  static let stageFaceFade = ArdiaDesign.MotionCurve.easeOut(duration: 0.06)
  static let stageFaceLead: Double = 0.04
  static let stageFaceArrival = ArdiaDesign.MotionCurve.easeOut(duration: 0.1)
  static let stageFaceArrivalDelay: Double = 0.02
  static let stageContentFade = ArdiaDesign.MotionCurve.easeOut(duration: 0.035)
  static let stageTintFade = ArdiaDesign.MotionCurve(0.42, 0, 0.58, 1, duration: 0.16)
  static let stageShadowIn = ArdiaDesign.MotionCurve.easeOut(duration: 0.15)
  static let stageFoldLag: Double = 1.0 / 60
  static let stageHandOff = ArdiaDesign.MotionCurve.easeOut(duration: 0.1)
  static let stageRevealHold: Double = 0.25
  static let stageRevealFieldDelay: Double = 0.06
  static let stageRevealRowsDelay: Double = 0.09
  static let stageRevealCurve = ArdiaDesign.MotionCurve.easeOut(duration: 0.12)
  static let stageReduced = ArdiaDesign.MotionCurve.easeOut(duration: 0.2)
}

nonisolated extension BrowseLayout {
  static let stageDepartLift: CGFloat = 120

  static func stageFieldCenter(fieldHeight: CGFloat) -> CGFloat {
    panelFieldInset + fieldHeight / 2
  }
}

extension ArdiaDesign.MotionCurve {
  var stageTimingFunction: CAMediaTimingFunction {
    CAMediaTimingFunction(controlPoints: Float(start.x), Float(start.y), Float(end.x), Float(end.y))
  }

  func stageAnimator(_ changes: @escaping () -> Void) -> UIViewPropertyAnimator {
    UIViewPropertyAnimator(duration: duration, controlPoint1: start, controlPoint2: end, animations: changes)
  }
}

extension Spring {
  var stageTimingParameters: UISpringTimingParameters {
    UISpringTimingParameters(duration: duration, bounce: bounce)
  }

  func stageTimingParameters(initialVelocity: CGFloat) -> UISpringTimingParameters {
    UISpringTimingParameters(duration: duration, bounce: bounce, initialVelocity: CGVector(dx: 0, dy: initialVelocity))
  }
}

extension UIView {
  func restartStageOpacityFade(to opacity: Float, after delay: CFTimeInterval, from base: CFTimeInterval, curve: ArdiaDesign.MotionCurve) {
    let from = (layer.presentation() ?? layer).opacity
    UIView.performWithoutAnimation {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      layer.removeAllAnimations()
      layer.opacity = opacity
      CATransaction.commit()
    }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = from
    fade.toValue = opacity
    fade.beginTime = base + delay
    fade.duration = curve.duration
    fade.fillMode = .backwards
    fade.timingFunction = curve.stageTimingFunction
    layer.add(fade, forKey: "fade")
  }
}

@MainActor
enum StageSettlePoll {
  static func until(every interval: Duration, within limit: Duration, _ isDone: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + limit
    while !isDone(), ContinuousClock.now < deadline {
      try? await Task.sleep(for: interval)
      if Task.isCancelled { return false }
    }
    return !Task.isCancelled
  }
}

@MainActor
final class StageKeyboardTracker {
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

  func stop() {
    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
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

struct StageKeyboardClock {
  let timing: UITimingCurveProvider
  let duration: TimeInterval

  @MainActor
  init?(layer: CALayer) {
    let running = (layer.animationKeys() ?? []).compactMap { layer.animation(forKey: $0) }
    if let spring = running.lazy.compactMap({ $0 as? CASpringAnimation }).first {
      timing = UISpringTimingParameters(mass: spring.mass, stiffness: spring.stiffness, damping: spring.damping, initialVelocity: .zero)
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
