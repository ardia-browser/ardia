import ArdiaDesign
import SwiftUI

nonisolated extension Motion {
  static let trayDimCurve = MotionCurve.easeOut(duration: 0.2)
  static let departCurve = MotionCurve(0.2, 0, 0, 1, duration: 0.2)
  static let trayWiden = Spring(response: 0.18, dampingRatio: 1)
  static let trayDeepen = Spring(response: 0.24, dampingRatio: 1)
  static let trayOpenWiden = Spring(response: 0.12, dampingRatio: 1)
  static let trayFold = Spring(response: 0.1, dampingRatio: 1)
  static let trayFoldBeforeNarrowing: CGFloat = 0.8
  static let trayFaceFade = MotionCurve.easeOut(duration: 0.06)
  static let trayFaceLead: Double = 0.04
  static let trayFaceArrival = MotionCurve.easeOut(duration: 0.1)
  static let trayFaceArrivalDelay: Double = 0.02
  static let trayContentFade = MotionCurve.easeOut(duration: 0.035)
  static let trayTintFade = MotionCurve(0.42, 0, 0.58, 1, duration: 0.16)
  static let trayShadowIn = MotionCurve.easeOut(duration: 0.15)
  static let trayFoldLag: Double = 1.0 / 60
  static let trayHandOff = MotionCurve.easeOut(duration: 0.1)
  static let trayRevealCurve = MotionCurve.easeOut(duration: 0.12)
  static let trayRevealFieldDelay: Double = 0.06
  static let trayRevealField = trayRevealCurve.animation.delay(trayRevealFieldDelay)
  static let trayRevealRows = trayRevealCurve.animation.delay(0.09)
}

nonisolated extension BrowseLayout {
  static let trayDim: Double = 0.28
  static let trayInvisibleDim: Double = 0.001
  static let trayDepartLift: CGFloat = 120

  static func panelFieldCenter(fieldHeight: CGFloat) -> CGFloat {
    panelFieldInset + fieldHeight / 2
  }
}
