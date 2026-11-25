import Foundation
import QuartzCore

final class GlowPlateLayer: CALayer {
  let fill = CAGradientLayer()
  let fadeMask = CAGradientLayer()
  let rim = CALayer()
  private let stroke = CALayer()
  private let taper = CAGradientLayer()

  override init() {
    super.init()
    masksToBounds = true
    addSublayer(fill)
    rim.anchorPoint = .zero
    rim.masksToBounds = true
    stroke.cornerCurve = .continuous
    rim.addSublayer(stroke)
    addSublayer(rim)
    mask = fadeMask
  }

  override init(layer: Any) { super.init(layer: layer) }

  required init?(coder: NSCoder) { nil }

  func paint(_ plate: FieldGlowPlateStops, flipped: Bool, field: CGSize, radius: CGFloat, line: CGFloat = 0) {
    let colors = plate.colors.map { CGColor(srgbRed: $0.red, green: $0.green, blue: $0.blue, alpha: $0.alpha) }
    let softCount = line > 0 ? max(0, colors.count - 2) : colors.count
    fill.frame = bounds
    fill.colors = Array(colors.prefix(softCount))
    fill.locations = plate.stops.count == colors.count ? plate.stops.prefix(softCount).map { NSNumber(value: $0) } : nil
    fill.startPoint = CGPoint(x: 0.5, y: flipped ? 0 : 1)
    fill.endPoint = CGPoint(x: 0.5, y: flipped ? 1 : 0)
    fill.isHidden = softCount < 2
    let corner = min(max(radius, 0), min(field.width, field.height) / 2)
    let depth = min(field.height, max(corner, line))
    rim.bounds = CGRect(x: 0, y: 0, width: field.width, height: depth)
    rim.position.y = flipped ? field.height - depth : 0
    stroke.frame = CGRect(x: 0, y: flipped ? depth - field.height : 0, width: field.width, height: field.height)
    stroke.cornerRadius = corner
    stroke.borderWidth = line
    stroke.borderColor = colors.last
    taper.frame = rim.bounds
    taper.colors = [CGColor(gray: 0, alpha: 0), CGColor(gray: 0, alpha: 1)]
    taper.startPoint = CGPoint(x: 0.5, y: flipped ? 0 : 1)
    taper.endPoint = CGPoint(x: 0.5, y: flipped ? 1 - min(line / max(depth, 1), 1) : min(line / max(depth, 1), 1))
    rim.mask = corner > line ? taper : nil
    rim.isHidden = line <= 0 || depth <= 0
    fadeMask.frame = bounds
    fadeMask.colors = plate.fade.map { CGColor(gray: 0, alpha: $0) }
    fadeMask.locations = plate.fadeStops.count == plate.fade.count ? plate.fadeStops.map { NSNumber(value: $0) } : nil
    fadeMask.startPoint = CGPoint(x: 0, y: 0.5)
    fadeMask.endPoint = CGPoint(x: 1, y: 0.5)
    mask = plate.fade.count >= 2 ? fadeMask : nil
  }
}

private final class GlowAnimationDelegate: NSObject, CAAnimationDelegate {
  weak var owner: FieldGlowLayers?

  init(_ owner: FieldGlowLayers) { self.owner = owner }

  func animationDidStop(_ anim: CAAnimation, finished done: Bool) {
    owner?.animationStopped(anim, finished: done)
  }
}

struct GlowRun {
  let from: Double
  let to: Double
  let start: CFTimeInterval
  let duration: Double
  let curve: FieldGlowCurve

  func value(at time: CFTimeInterval) -> Double {
    guard duration > 0 else { return to }
    return from + (to - from) * curve.eased((time - start) / duration)
  }

  func progress(at time: CFTimeInterval) -> Double { duration > 0 ? min(max((time - start) / duration, 0), 1) : 1 }

  func active(at time: CFTimeInterval) -> Bool { time < start + duration }
}

public final class FieldGlowLayers: NSObject, FieldGlowTarget {
  public let clip = CALayer()
  public let slide = CALayer()
  public let steady = CALayer()
  public let comet = CALayer()
  let tailPlate = GlowPlateLayer()
  let capPlate = GlowPlateLayer()
  let cometPlate = GlowPlateLayer()

  public var look = FieldGlowLook() { didSet { if look != oldValue { repaint() } } }
  public var radius: Double = 0 {
    didSet {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      clip.cornerRadius = radius
      CATransaction.commit()
      if radius != oldValue { repaint() }
    }
  }
  public var animates: () -> Bool = { true }
  public var finishingGeneration: () -> Int? = { nil }
  public var onFinished: (Int) -> Void = { _ in }
  public var now: () -> CFTimeInterval = { CACurrentMediaTime() }

  public private(set) var size: CGSize = .zero
  private var flipped = false
  private var filled: Double = 0
  private var rawProgress: Double?
  private var finishing: Int?
  private var filledRun: GlowRun?
  private var opacityRun: GlowRun?
  private lazy var delegate = GlowAnimationDelegate(self)

  public override init() {
    super.init()
    for layer in [clip, slide, steady, comet] { layer.anchorPoint = .zero }
    clip.masksToBounds = true
    clip.cornerCurve = .continuous
    steady.addSublayer(tailPlate)
    steady.addSublayer(capPlate)
    comet.addSublayer(cometPlate)
    slide.addSublayer(steady)
    slide.addSublayer(comet)
    clip.addSublayer(slide)
    slide.opacity = 0
    slide.isHidden = true
    comet.opacity = 0
  }

  public var running: [String] {
    [clip, slide, steady, comet].flatMap { $0.animationKeys() ?? [] }
  }

  public func resize(_ size: CGSize, flipped: Bool) {
    guard size != self.size || flipped != self.flipped else { return }
    self.size = size
    self.flipped = flipped
    repaint()
  }

  private func repaint() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let width = Double(size.width)
    let height = Double(size.height)
    let plates = FieldGlowGeometry.plates(look, width: width, height: height)
    clip.frame = CGRect(origin: .zero, size: size)
    slide.bounds = CGRect(x: 0, y: 0, width: width + plates.tail.extra, height: height)
    steady.frame = slide.bounds
    comet.frame = slide.bounds
    tailPlate.frame = CGRect(x: 0, y: 0, width: width + plates.tail.extra, height: height)
    capPlate.frame = CGRect(x: 0, y: 0, width: width + plates.cap.extra, height: height)
    cometPlate.frame = CGRect(x: 0, y: 0, width: width + plates.comet.extra, height: height)
    tailPlate.paint(plates.tail, flipped: flipped, field: size, radius: radius)
    capPlate.paint(plates.cap, flipped: flipped, field: size, radius: radius, line: look.line)
    cometPlate.paint(plates.comet, flipped: flipped, field: size, radius: radius, line: look.line)
    let time = now()
    if let run = filledRun, run.active(at: time), slide.animation(forKey: "filled") != nil {
      let target = rawProgress.map { FieldGlowGeometry.filled(progress: $0, look: look, width: width) } ?? run.to
      filled = target
      let remaining = run.start + run.duration - time
      let current = run.value(at: time)
      let resumed = GlowRun(from: current, to: target, start: time, duration: remaining, curve: run.curve)
      let t0 = run.progress(at: time)
      let base = run.curve.eased(t0)
      let count = max(2, Int((remaining * 120).rounded(.up)) + 1)
      let samples = (0..<count).map { i -> Double in
        let eased = run.curve.eased(t0 + (1 - t0) * Double(i) / Double(count - 1))
        let share = base < 1 ? (eased - base) / (1 - base) : 1
        return current + (target - current) * share
      }
      moveSlide(to: target, samples: samples, duration: remaining)
      filledRun = resumed
    } else {
      if let rawProgress { filled = FieldGlowGeometry.filled(progress: rawProgress, look: look, width: width) }
      moveSlide(to: filled)
    }
    CATransaction.commit()
  }

  private func offset(_ filled: Double) -> CGFloat { -size.width * CGFloat(1 - filled) }

  private func moveSlide(to target: Double, samples: [Double] = [], duration: Double = 0) {
    for (layer, direction) in [(slide, 1.0), (capPlate.rim, -1.0), (cometPlate.rim, -1.0)] {
      layer.removeAnimation(forKey: "filled")
      layer.position.x = offset(target) * direction
      guard !samples.isEmpty else { continue }
      let animation = CAKeyframeAnimation(keyPath: "position.x")
      animation.values = samples.map { NSNumber(value: Double(offset($0) * direction)) }
      animation.calculationMode = .linear
      animation.duration = duration
      layer.add(animation, forKey: "filled")
    }
  }

  public func cancel() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    clearAnimations()
    finishing = nil
    filledRun = nil
    opacityRun = nil
    slide.opacity = 0
    slide.isHidden = true
    CATransaction.commit()
  }

  public func settle(at model: FieldGlowModel) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    clearAnimations()
    finishing = nil
    filledRun = nil
    opacityRun = nil
    let shown = model.phase == .loading
    rawProgress = shown ? model.progress : nil
    filled = rawProgress.map { FieldGlowGeometry.filled(progress: $0, look: look, width: Double(size.width)) } ?? (model.targets[.filled] ?? 0)
    moveSlide(to: filled)
    slide.opacity = shown ? Float(model.targets[.opacity] ?? 0) : 0
    let cometValue = Float(model.targets[.comet] ?? 0)
    comet.opacity = cometValue
    steady.opacity = 1 - cometValue
    slide.isHidden = !shown
    syncPulse(model.pulse)
    CATransaction.commit()
    if model.phase == .finishing { onFinished(model.generation) }
  }

  public func run(_ moves: [FieldGlowMove], model: FieldGlowModel) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if model.phase != .idle { slide.isHidden = false }
    if model.phase != .loading { rawProgress = nil }
    syncPulse(model.pulse)
    for move in moves { apply(move) }
    if model.phase == .finishing {
      finishing = model.generation
      if slide.animation(forKey: "opacity") == nil { completeFinish(model.generation) }
    } else {
      finishing = nil
      if model.phase == .idle {
        clearAnimations()
        filledRun = nil
        opacityRun = nil
        slide.isHidden = true
      }
    }
    CATransaction.commit()
  }

  func animationStopped(_ anim: CAAnimation, finished done: Bool) {
    guard done, let generation = anim.value(forKey: "glowGeneration") as? Int, generation == finishing else { return }
    completeFinish(generation)
  }

  private func completeFinish(_ generation: Int) {
    guard finishing == generation else { return }
    finishing = nil
    clearAnimations()
    filledRun = nil
    opacityRun = nil
    slide.isHidden = true
    onFinished(generation)
  }

  private func current(_ run: GlowRun?, key: String, on layer: CALayer, model: Double) -> Double {
    guard layer.animation(forKey: key) != nil, let run, run.active(at: now()) else { return model }
    return run.value(at: now())
  }

  private func clearAnimations() {
    clip.removeAnimation(forKey: "pulse")
    for layer in [slide, steady, comet, capPlate.rim, cometPlate.rim] { layer.removeAllAnimations() }
  }

  public func syncPulse(_ pulse: FieldGlowPulse?) {
    guard let pulse, animates() else {
      clip.removeAnimation(forKey: "pulse")
      return
    }
    let duration = pulse.period / 2
    if let current = clip.animation(forKey: "pulse") as? CABasicAnimation,
       current.duration == duration, current.toValue as? Double == pulse.low { return }
    let animation = CABasicAnimation(keyPath: "opacity")
    animation.fromValue = 1
    animation.toValue = pulse.low
    animation.duration = duration
    animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    animation.autoreverses = true
    animation.repeatCount = .infinity
    clip.add(animation, forKey: "pulse")
  }

  private func apply(_ move: FieldGlowMove) {
    let time = now()
    switch move.property {
    case .filled:
      rawProgress = move.clamped ? move.to : nil
      let from = current(filledRun, key: "filled", on: slide, model: filled)
      filled = move.clamped ? FieldGlowGeometry.filled(progress: move.to, look: look, width: Double(size.width)) : move.to
      moveSlide(to: filled)
      filledRun = nil
      guard move.duration > 0, animates() else { return }
      let run = GlowRun(from: from, to: filled, start: time, duration: move.duration, curve: move.curve)
      moveSlide(to: filled, samples: fieldGlowSamples(from: from, to: filled, duration: move.duration, curve: move.curve), duration: move.duration)
      filledRun = run
    case .opacity:
      let from = current(opacityRun, key: "opacity", on: slide, model: Double(slide.opacity))
      let entrance = opacityRun.flatMap { $0.active(at: time) && slide.animation(forKey: "opacity") != nil ? $0 : nil }
      slide.removeAnimation(forKey: "opacity")
      slide.opacity = Float(move.to)
      opacityRun = nil
      guard move.duration > 0, animates() else { return }
      var values: [Double] = []
      var times: [Double] = []
      if move.delay > 0 {
        let total = move.delay + move.duration
        if let entrance {
          let remaining = entrance.start + entrance.duration - time
          let count = max(2, Int((remaining * 120).rounded(.up)) + 1)
          let t0 = entrance.progress(at: time)
          for i in 0..<count {
            let share = Double(i) / Double(count - 1)
            values.append(entrance.from + (entrance.to - entrance.from) * entrance.curve.eased(t0 + (1 - t0) * share))
            times.append(remaining * share / total)
          }
        } else {
          values.append(from)
          times.append(0)
        }
        let held = values.last ?? from
        values.append(held)
        times.append(move.delay / total)
        let fade = fieldGlowSamples(from: held, to: move.to, duration: move.duration, curve: move.curve)
        for (i, v) in fade.enumerated().dropFirst() {
          values.append(v)
          times.append((move.delay + move.duration * Double(i) / Double(fade.count - 1)) / total)
        }
        let animation = CAKeyframeAnimation(keyPath: "opacity")
        animation.values = values.map { NSNumber(value: $0) }
        animation.keyTimes = times.map { NSNumber(value: min(max($0, 0), 1)) }
        animation.calculationMode = .linear
        animation.duration = total
        attachCompletion(animation, to: move)
        slide.add(animation, forKey: "opacity")
        opacityRun = nil
      } else {
        let animation = CAKeyframeAnimation(keyPath: "opacity")
        animation.values = fieldGlowSamples(from: from, to: move.to, duration: move.duration, curve: move.curve).map { NSNumber(value: $0) }
        animation.calculationMode = .linear
        animation.duration = move.duration
        attachCompletion(animation, to: move)
        slide.add(animation, forKey: "opacity")
        opacityRun = GlowRun(from: from, to: move.to, start: time, duration: move.duration, curve: move.curve)
      }
    case .comet:
      let cometFrom = comet.animation(forKey: "comet") != nil ? Double((comet.presentation() ?? comet).opacity) : Double(comet.opacity)
      for layer in [comet, steady] { layer.removeAnimation(forKey: "comet") }
      comet.opacity = Float(move.to)
      steady.opacity = Float(1 - move.to)
      guard move.duration > 0, animates() else { return }
      for (layer, invert) in [(comet, false), (steady, true)] {
        let animation = CAKeyframeAnimation(keyPath: "opacity")
        animation.values = fieldGlowSamples(from: cometFrom, to: move.to, duration: move.duration, curve: move.curve).map { NSNumber(value: invert ? 1 - $0 : $0) }
        animation.calculationMode = .linear
        animation.duration = move.duration
        layer.add(animation, forKey: "comet")
      }
    }
  }

  private func attachCompletion(_ animation: CAAnimation, to move: FieldGlowMove) {
    guard move.to == 0, let generation = finishingGeneration() else { return }
    animation.setValue(generation, forKey: "glowGeneration")
    animation.delegate = delegate
  }
}
