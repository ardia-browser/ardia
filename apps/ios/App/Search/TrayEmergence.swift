import ArdiaDesign
import SwiftUI
import UIKit

@MainActor
final class TrayEmergence {
  private let pill: CGRect
  private let fieldCenter: CGFloat
  private let mask = UIView()
  private let cardLens = UIView()
  private let fieldLens = UIView()
  private let shadowLens = UIView()
  private let face: UIView?
  private var isOpening = false
  private var settling: Task<Void, Never>?

  private struct Span<Value> {
    let from: Value
    let to: Value
  }

  private static let shadowRoom: CGFloat = 18
  private static let fieldClearance: CGFloat = 1
  private static let settlePoll: Duration = .milliseconds(16)
  private static let settleDeadline: Duration = .seconds(1)

  private var isSettled: Bool {
    let lensesIdle = [cardLens, fieldLens, shadowLens].allSatisfy { ($0.layer.animationKeys() ?? []).isEmpty }
    guard isOpening, lensesIdle else { return false }
    guard let face else { return true }
    return face.layer.opacity == 0 && (face.layer.animationKeys() ?? []).isEmpty
  }

  init(pill: CGRect, fieldCenter: CGFloat, face: UIView?, on tray: UIView) {
    self.pill = pill
    self.fieldCenter = fieldCenter
    self.face = face
    mask.backgroundColor = .clear
    for lens in [shadowLens, cardLens, fieldLens] {
      lens.backgroundColor = .black
      lens.layer.cornerCurve = .continuous
      mask.addSubview(lens)
    }
    shadowLens.alpha = 0
    tray.mask = mask
    if let face { tray.addSubview(face) }
  }

  func restingOffset(trayHeight: CGFloat, stageBottom: CGFloat) -> CGFloat {
    pill.midY - fieldCenter + trayHeight - stageBottom
  }

  func place(on tray: UIView, in stage: UIView, card: CGRect, isOpen: Bool) {
    let closed = stage.convert(pill, to: tray)
    let cardWindow = isOpen ? card : closed
    let field = isOpen ? fieldFrame(in: card) : closed
    let before = (card: cardLens.frame, field: fieldLens.frame, radius: cardLens.layer.cornerRadius)
    UIView.performWithoutAnimation {
      mask.frame = tray.bounds
      cardLens.frame = cardWindow
      cardLens.layer.cornerRadius = isOpen ? BrowseLayout.panelRadius : closed.height / 2
      fieldLens.frame = field
      fieldLens.layer.cornerRadius = field.height / 2
      shadowLens.frame = card.insetBy(dx: -Self.shadowRoom, dy: -Self.shadowRoom)
      shadowLens.layer.cornerRadius = BrowseLayout.panelRadius + Self.shadowRoom
      face?.center = CGPoint(x: card.midX, y: fieldCenter)
    }
    guard isOpen, !isOpening else { return }
    isOpening = true
    unfold(card: Span(from: before.card, to: cardWindow), field: Span(from: before.field, to: field), radius: Span(from: before.radius, to: cardLens.layer.cornerRadius))
  }

  func whenSettled(_ settled: @escaping @MainActor () -> Void) {
    guard settling == nil else { return }
    settling = Task { [weak self] in
      guard await SettlePoll.until(every: Self.settlePoll, within: Self.settleDeadline, { self?.isSettled != false }) else { return }
      settled()
    }
  }

  func fadeFace(from base: CFTimeInterval) {
    guard let face, face.layer.opacity > 0 else { return }
    face.restartOpacityFade(to: 0, after: Motion.trayRevealFieldDelay - Motion.trayFaceLead, from: base, curve: Motion.trayFaceFade)
  }

  func shownSurface(of tray: UIView, card: CGRect, in stage: UIView) -> TrayMorph.Start {
    let cardNow = (cardLens.layer.presentation() ?? cardLens.layer).frame
    let fieldNow = (fieldLens.layer.presentation() ?? fieldLens.layer).frame
    let shown = tray.layer.presentation() ?? tray.layer
    let window = cardNow.union(fieldNow).intersection(card)
    let frame = shown.convert(window.isNull ? card : window, to: stage.layer.presentation() ?? stage.layer)
    return TrayMorph.Start(frame: frame, radius: min(BrowseLayout.panelRadius, frame.height / 2))
  }

  func end(on tray: UIView) {
    settling?.cancel()
    settling = nil
    if tray.mask === mask { tray.mask = nil }
    face?.removeFromSuperview()
  }

  private func fieldFrame(in card: CGRect) -> CGRect {
    let height = 2 * (fieldCenter - BrowseLayout.panelFieldInset) + 2 * Self.fieldClearance
    return CGRect(
      x: card.minX + BrowseLayout.panelFieldInset - Self.fieldClearance,
      y: fieldCenter - height / 2,
      width: card.width - 2 * BrowseLayout.panelFieldInset + 2 * Self.fieldClearance,
      height: height
    )
  }

  private func unfold(card: Span<CGRect>, field: Span<CGRect>, radius: Span<CGFloat>) {
    let needed = card.to.width > card.from.width ? (field.to.width - card.from.width) / (card.to.width - card.from.width) : 0
    let deepenAt = Motion.trayOpenWiden.time(toReach: needed)
    Self.group(on: fieldLens.layer, [
      Self.spring("bounds.size.width", field.from.width, field.to.width, on: Motion.trayOpenWiden),
      Self.spring("position.x", field.from.midX, field.to.midX, on: Motion.trayOpenWiden),
      Self.spring("bounds.size.height", field.from.height, field.to.height, on: Motion.trayOpenWiden),
      Self.spring("position.y", field.from.midY, field.to.midY, on: Motion.trayOpenWiden),
      Self.spring("cornerRadius", field.from.height / 2, field.to.height / 2, on: Motion.trayOpenWiden),
    ])
    Self.group(on: cardLens.layer, [
      Self.spring("bounds.size.width", card.from.width, card.to.width, on: Motion.trayOpenWiden),
      Self.spring("position.x", card.from.midX, card.to.midX, on: Motion.trayOpenWiden),
      Self.spring("bounds.size.height", card.from.height, card.to.height, on: Motion.trayDeepen, after: deepenAt),
      Self.spring("position.y", card.from.midY, card.to.midY, on: Motion.trayDeepen, after: deepenAt),
      Self.capsuleRadius(heights: Span(from: card.from.height, to: card.to.height), cap: radius.to, on: Motion.trayDeepen, after: deepenAt),
    ])
    let shadowFade = CABasicAnimation(keyPath: "opacity")
    shadowFade.fromValue = 0
    shadowFade.toValue = 1
    shadowFade.beginTime = deepenAt + Motion.trayDeepen.duration
    shadowFade.duration = Motion.trayShadowIn.duration
    shadowFade.timingFunction = Motion.trayShadowIn.mediaTimingFunction
    shadowFade.fillMode = .backwards
    UIView.performWithoutAnimation { shadowLens.alpha = 1 }
    Self.group(on: shadowLens.layer, [shadowFade])
  }

  private static func spring(_ keyPath: String, _ from: CGFloat, _ to: CGFloat, on timing: Spring, after delay: CFTimeInterval = 0) -> CAAnimation {
    let spring = CASpringAnimation(perceptualDuration: timing.duration, bounce: timing.bounce)
    spring.keyPath = keyPath
    spring.fromValue = from
    spring.toValue = to
    spring.duration = spring.settlingDuration
    spring.beginTime = delay
    spring.fillMode = .backwards
    return spring
  }

  private static func capsuleRadius(heights: Span<CGFloat>, cap: CGFloat, on timing: Spring, after delay: CFTimeInterval) -> CAAnimation {
    let steps = max(Int(timing.settlingDuration * 120), 2)
    var values: [CGFloat] = []
    var keyTimes: [NSNumber] = []
    for step in 0...steps {
      let fraction = Double(step) / Double(steps)
      let progress = timing.criticalProgress(at: fraction * timing.settlingDuration)
      let height = heights.from + (heights.to - heights.from) * CGFloat(progress)
      values.append(min(height / 2, cap))
      keyTimes.append(NSNumber(value: fraction))
    }
    let animation = CAKeyframeAnimation(keyPath: "cornerRadius")
    animation.values = values
    animation.keyTimes = keyTimes
    animation.calculationMode = .linear
    animation.duration = timing.settlingDuration
    animation.beginTime = delay
    animation.fillMode = .backwards
    return animation
  }

  private static func group(on layer: CALayer, _ animations: [CAAnimation]) {
    let group = CAAnimationGroup()
    group.animations = animations
    group.duration = animations.map { $0.beginTime + $0.duration }.max() ?? 0
    layer.add(group, forKey: "unfold")
  }
}
