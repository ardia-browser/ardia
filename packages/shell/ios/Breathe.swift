import AppKit
import ExpoModulesCore

final class Breathe: ExpoView {
  static let stepsPerCycle = 72
  private static let motionKey = "breathe"

  var running = false
  var cycleMs: Double = 1420
  var opacityRange: [Double] = [1, 1]
  var scaleRange: [Double] = [1, 1]

  private var startedAt: CFTimeInterval?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func setFrameSize(_ newSize: NSSize) {
    let changed = newSize != frame.size
    super.setFrameSize(newSize)
    if changed { apply() }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    apply()
  }

  func propsDidUpdate() {
    if !running { startedAt = nil }
    apply()
  }

  private var low: (opacity: Double, scale: Double) { (opacityRange.first ?? 1, scaleRange.first ?? 1) }
  private var high: (opacity: Double, scale: Double) { (opacityRange.last ?? 1, scaleRange.last ?? 1) }

  private func apply() {
    alphaValue = low.opacity
    transform3D = CATransform3DMakeScale(low.scale, low.scale, 1)
    guard let layer else { return }
    layer.removeAnimation(forKey: Self.motionKey)
    guard running, window != nil, cycleMs > 0, bounds.width > 0, bounds.height > 0 else { return }
    let origin = startedAt ?? CACurrentMediaTime()
    startedAt = origin
    layer.add(motion(in: layer, from: origin), forKey: Self.motionKey)
  }

  private func motion(in layer: CALayer, from origin: CFTimeInterval) -> CAAnimationGroup {
    let steps = Self.stepsPerCycle
    let levels = (0...steps).map { (1 - cos(2 * Double.pi * Double($0) / Double(steps))) / 2 }
    let dx = (0.5 - layer.anchorPoint.x) * bounds.width
    let dy = (0.5 - layer.anchorPoint.y) * bounds.height
    let center = CATransform3DMakeTranslation(dx, dy, 0)
    let lift = CATransform3DMakeTranslation(-dx, -dy, 0)
    let opacity = CAKeyframeAnimation(keyPath: "opacity")
    opacity.values = levels.map { low.opacity + (high.opacity - low.opacity) * $0 }
    let scale = CAKeyframeAnimation(keyPath: "transform")
    scale.values = levels.map { level -> NSValue in
      let s = low.scale + (high.scale - low.scale) * level
      return NSValue(caTransform3D: CATransform3DConcat(CATransform3DConcat(lift, CATransform3DMakeScale(s, s, 1)), center))
    }
    let group = CAAnimationGroup()
    group.animations = [opacity, scale]
    group.duration = cycleMs / 1000
    group.repeatCount = .infinity
    group.isRemovedOnCompletion = false
    group.beginTime = layer.convertTime(origin, from: nil)
    for keyframes in [opacity, scale] {
      keyframes.duration = group.duration
      keyframes.calculationMode = .linear
    }
    return group
  }
}
