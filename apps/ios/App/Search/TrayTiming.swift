import ArdiaDesign
import SwiftUI
import UIKit

extension MotionCurve {
  var mediaTimingFunction: CAMediaTimingFunction {
    CAMediaTimingFunction(controlPoints: Float(start.x), Float(start.y), Float(end.x), Float(end.y))
  }

  func animator(_ changes: @escaping () -> Void) -> UIViewPropertyAnimator {
    UIViewPropertyAnimator(duration: duration, controlPoint1: start, controlPoint2: end, animations: changes)
  }
}

extension Spring {
  var timingParameters: UISpringTimingParameters {
    UISpringTimingParameters(duration: duration, bounce: bounce)
  }

  func timingParameters(initialVelocity: CGFloat) -> UISpringTimingParameters {
    UISpringTimingParameters(duration: duration, bounce: bounce, initialVelocity: CGVector(dx: 0, dy: initialVelocity))
  }
}

extension UIView {
  func restartOpacityFade(to opacity: Float, after delay: CFTimeInterval, from base: CFTimeInterval, curve: MotionCurve) {
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
    fade.timingFunction = curve.mediaTimingFunction
    layer.add(fade, forKey: "fade")
  }
}

@MainActor
enum SettlePoll {
  static func until(every interval: Duration, within limit: Duration, _ isDone: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + limit
    while !isDone(), ContinuousClock.now < deadline {
      try? await Task.sleep(for: interval)
      if Task.isCancelled { return false }
    }
    return !Task.isCancelled
  }
}
