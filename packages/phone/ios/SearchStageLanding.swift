import ArdiaDesign
import QuartzCore
import UIKit

extension SearchStageView {
  func traceOverAnchor(_ moment: String) {
    let anchorFrame = anchorNativeId.flatMap { id in window.flatMap { Self.find(nativeId: id, in: $0) } }.map { $0.convert($0.bounds, to: nil) }
    let pieces = subviews.map { piece -> String in
      let shown = piece.layer.presentation() ?? piece.layer
      let frame = piece.convert(piece.bounds, to: nil)
      let covers = anchorFrame.map { frame.intersects($0) } ?? false
      return "\(String(describing: type(of: piece))) hidden=\(piece.isHidden) alpha=\(String(format: "%.2f", piece.alpha)) shownAlpha=\(String(format: "%.2f", shown.opacity)) coversAnchor=\(covers)"
    }
    NSLog("PAGELAB stage %@ anchor=%@ stageHidden=%@ stageAlpha=%.2f at=%.3f [%@]", moment, anchorFrame.map { NSCoder.string(for: $0) } ?? "none", isHidden ? "yes" : "no", alpha, CACurrentMediaTime(), pieces.joined(separator: "; "))
  }

  func reportLanding(_ lands: Bool, path: String) {
    closingPath = path
    onLanding(["lands": lands, "path": path])
  }

  func watchSettling() {
    settleTask?.cancel()
    settleTask = Task { [weak self] in
      guard let self else { return }
      guard await StageSettlePoll.until(every: Self.settlePoll, within: Self.settleDeadline, { self.hasSettled }), self.isClosing else { return }
      self.reportSettled(landed: self.morph?.hasDestination == true)
    }
  }

  func reportSettled(landed: Bool) {
    guard !settledReported else { return }
    settledReported = true
    settleTask?.cancel()
    arrivalTask?.cancel()
    if PhoneTestBuild.isOn { traceOverAnchor("settled \(closingPath)") }
    onSettled(["landed": landed, "path": closingPath])
  }

  func reportArrival(after arrival: TimeInterval, of flying: StageMorph) {
    arrivalTask?.cancel()
    let deadline = ContinuousClock.now + .milliseconds(Int(max(0, arrival - Self.landingLead) * 1000))
    arrivalTask = Task { [weak self] in
      while ContinuousClock.now < deadline, !Task.isCancelled, !flying.isVisiblyLanded {
        try? await Task.sleep(for: Self.settlePoll)
      }
      guard let self, !Task.isCancelled, self.isClosing, self.morph === flying else { return }
      self.reportSettled(landed: true)
    }
  }

  func beginMorph(from shownSurface: StageMorph.Start?) {
    guard let panel else {
      reportLanding(false, path: "noPanel")
      return
    }
    morph = StageMorph(card: card, fieldCenter: fieldCenter, corners: corners, of: panel, in: self, look: look, from: shownSurface)
    move(.immediate) { [self] in
      isClosing = true
      if !keyboardUp { morph?.appear() }
    }
    pendingFlight = releaseVelocity
    DispatchQueue.main.async { [weak self] in self?.launchMorph() }
  }

  func launchMorph() {
    guard let velocity = pendingFlight else { return }
    guard keyboardUp else {
      flyMorph(velocity: velocity)
      return
    }
    pendingFallback?.cancel()
    pendingFallback = Task { [weak self] in
      try? await Task.sleep(for: Self.keyboardGrace)
      guard let self, !Task.isCancelled, let velocity = pendingFlight else { return }
      flyMorph(velocity: velocity)
    }
  }

  func flyMorph(velocity: CGFloat) {
    cancelPendingFlight()
    guard let morph else {
      reportLanding(false, path: "noMorph")
      return
    }
    guard let anchor = resolveAnchor() else {
      reportLanding(false, path: anchorMissReason)
      morph.vanish()
      hidePanelUnderMorph()
      return
    }
    reportLanding(true, path: "anchored")
    let target = convert(anchor.frame, from: nil)
    if let panel { morph.restart(fromCard: card, of: panel, in: self) }
    let carried = face.flatMap { $0.fits(anchor) ? $0 : nil }
    let arrival: TimeInterval
    if abs(velocity) < Self.stillReleaseSpeed, let clock = StageKeyboardClock(layer: keyboardSentinel.layer) {
      arrival = morph.fly(to: target, style: anchor.style, carrying: carried, timing: clock.timing, duration: clock.duration, direct: landsDirectly)
    } else {
      let distance = target.midY - morph.view.frame.midY
      let timing = Motion.smoothSpring.stageTimingParameters(initialVelocity: Motion.relativeVelocity(velocity, over: distance))
      arrival = morph.fly(to: target, style: anchor.style, carrying: carried, timing: timing, duration: Motion.smoothSpring.settlingDuration, direct: landsDirectly)
    }
    reportArrival(after: arrival, of: morph)
    hidePanelUnderMorph()
  }

  func cancelPendingFlight() {
    pendingFallback?.cancel()
    pendingFallback = nil
    pendingFlight = nil
  }

  func hidePanelUnderMorph() {
    UIView.performWithoutAnimation { panel?.alpha = 0 }
    if PhoneTestBuild.isOn { traceOverAnchor("panel hidden under morph") }
  }

  func handOffMorph() {
    cancelPendingFlight()
    fadingMorph?.remove()
    fadingMorph = morph
    morph?.handOff()
    morph = nil
  }

  func dropMorph() {
    cancelPendingFlight()
    morph?.remove()
    morph = nil
    fadingMorph?.remove()
    fadingMorph = nil
  }
}
