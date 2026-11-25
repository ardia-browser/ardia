import ArdiaDesign
import Metal
import QuartzCore
import UIKit

final class LiquidGlassSurface: UIView {
  var source: String? { didSet { if source != oldValue { needsPath() } } }
  var capsule = true { didSet { if capsule != oldValue { invalidate() } } }
  var cornerRadius: CGFloat = 0 { didSet { if cornerRadius != oldValue { invalidate() } } }
  var dark: Bool? { didSet { if dark != oldValue { invalidate() } } }
  var tint: UIColor? { didSet { if !Self.same(tint, oldValue) { invalidate() } } }
  var solidFill: UIColor? { didSet { if !Self.same(solidFill, oldValue) { invalidate() } } }
  var classic = false { didSet { if classic != oldValue { needsPath() } } }
  var presentedRadius: (() -> CGFloat?)?
  var followsPresentation = false
  var label: String = "-"

  private let fillLayer = CALayer()
  private let clearLayer = CALayer()
  private let lens = GlassTarget(adds: false)
  private let rim = GlassTarget(adds: true)
  private var lensLayer: CAMetalLayer { lens.layer }
  private let bound = LiquidGlassSurfaceBound()
  private(set) var choice = LiquidGlassRules.choose(classic: false, metal: false, flat: false, lensFailed: false, rimFailed: false, holdsPage: false)
  private(set) var backdropMode: LiquidGlassRules.Backdrop?
  private(set) weak var backdropSource: FrostSourceView?
  private(set) weak var backdropRoot: UIView?
  var stillPending = false
  private var drawnUniforms: [Float]? {
    get { lens.drawn }
    set {
      lens.drawn = newValue
      rim.drawn = newValue
    }
  }
  private var reportedPath: String?
  private var batching = 0
  private var batchedPath = false
  private var batchedInvalidate = false
  private var laidOut: (size: CGSize, scale: CGFloat)?
  private var lensWanted = false
  private var lensOn: Bool?
  private var lastBridge: CFTimeInterval = 0
  private var toneDark: Bool?
  private var toneChangedAt: CFTimeInterval = -.infinity

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
    fillLayer.cornerCurve = .circular
    clearLayer.cornerCurve = .circular
    clearLayer.isHidden = true
    lens.layer.opacity = 0
    layer.addSublayer(fillLayer)
    layer.addSublayer(clearLayer)
    layer.addSublayer(lens.layer)
    layer.addSublayer(rim.layer)
    lens.onDrawn = { [weak self] in self?.updateVisibility() }
    rim.onDrawn = { [weak self] in self?.updateVisibility() }
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LiquidGlassSurface, _: UITraitCollection) in view.invalidate() }
  }

  required init?(coder: NSCoder) { nil }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      GlassFrames.shared.attach(self)
      laidOut = nil
      layoutLayers(size: bounds.size)
      needsPath()
    } else {
      backdropMode = nil
      backdropSource = nil
      backdropRoot = nil
      stillPending = false
      drawnUniforms = nil
      GlassFrames.shared.detach(self)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layoutLayers(size: bounds.size)
  }

  func batch(_ changes: () -> Void) {
    batching += 1
    changes()
    batching -= 1
    guard batching == 0 else { return }
    if batchedPath {
      batchedPath = false
      batchedInvalidate = false
      needsPath(force: true)
    } else if batchedInvalidate {
      batchedInvalidate = false
      invalidate()
    }
  }

  var wantsFrames: Bool {
    guard window != nil, !classic, GlassMetal.shared.isReady else { return false }
    if choice.path == .live { return isShownOnScreen }
    return followsPresentation && (hasRunningAnimations || lensLayer.bounds.size != bounds.size)
  }

  var waitsForPage: Bool { source == GlassSources.pageSource }

  var wantsPathChecks: Bool { window != nil && !classic && !wantsFrames }

  var captureOwner: AnyObject? {
    switch backdropMode {
    case .source: backdropSource
    case .beneath: backdropRoot == nil ? nil : self
    case nil: nil
    }
  }

  var isShownOnScreen: Bool {
    guard let window, var shown = region(in: window) else { return false }
    shown = shown.intersection(window.bounds)
    var view: UIView? = self
    while let current = view {
      if current.isHidden || current.alpha <= 0.01 { return false }
      if current !== self, current.clipsToBounds || current.layer.masksToBounds {
        shown = shown.intersection(current.convert(current.bounds, to: window))
      }
      if shown.isNull || shown.isEmpty { return false }
      view = current.superview
    }
    return true
  }

  private var hasRunningAnimations: Bool {
    var view: UIView? = self
    var depth = 0
    while let current = view, depth < 3 {
      if !(current.layer.animationKeys() ?? []).isEmpty { return true }
      view = current.superview
      depth += 1
    }
    return false
  }

  private var isDark: Bool { dark ?? (traitCollection.userInterfaceStyle == .dark) }

  private var scale: CGFloat { window?.screen.scale ?? traitCollection.displayScale }

  private var blurPixels: Double { GlassFrostStyle.glass.blur * Double(max(scale, 1)) }

  var capturePixelsPerPoint: CGFloat { scale / CGFloat(LiquidGlassRules.frostScale(blurPixels: blurPixels)) }

  var blurSigma: Double { LiquidGlassRules.blurSigma(radius: blurPixels / LiquidGlassRules.frostScale(blurPixels: blurPixels)) }

  var marginPoints: CGFloat {
    let shift = bound.measure(lensLayer.bounds.size).shift
    return CGFloat(LiquidGlassRules.marginPixels(blurPixels: blurPixels, shiftPixels: shift * Double(scale))) / max(scale, 1)
  }

  func needsPath(force: Bool = false) {
    if batching > 0 {
      batchedPath = true
      return
    }
    let metal = GlassMetal.shared
    let found = GlassSources.find(source)
    let inside = found.map { isDescendant(of: $0) } ?? false
    let mode = LiquidGlassRules.backdrop(hasSource: found != nil, insideSource: inside)
    backdropMode = window == nil ? nil : mode
    backdropSource = mode == .source ? found : nil
    backdropRoot = mode == .beneath ? window : nil
    let next = LiquidGlassRules.choose(
      classic: classic,
      metal: metal.device != nil,
      flat: GlassLaunch.flat,
      lensFailed: metal.failures > 0,
      rimFailed: metal.failures > 0,
      holdsPage: found.map(GlassSources.holdsPage) ?? false,
      solidPageAsked: GlassLaunch.solidPage,
      overBudget: GlassFrames.shared.isOverBudget(captureOwner),
      clearAsked: GlassLaunch.forceClear,
      onScreen: window != nil
    )
    let changed = next != choice
    if changed {
      choice = next
      drawnUniforms = nil
    }
    report()
    GlassFrames.shared.schedule()
    if changed || force { invalidate() }
  }

  func metalChanged() {
    drawnUniforms = nil
    needsPath(force: true)
  }

  func invalidate() {
    if batching > 0 {
      batchedInvalidate = true
      return
    }
    drawnUniforms = nil
    applyFallback()
    if !wantsFrames { drawStill() }
  }

  func followPresentation() {
    guard followsPresentation else { return }
    let shown = hasRunningAnimations ? (layer.presentation() ?? layer).bounds.size : bounds.size
    if shown != lensLayer.bounds.size { layoutLayers(size: shown) }
  }

  func region(in space: UIView) -> CGRect? {
    let shown = CGRect(origin: .zero, size: lensLayer.bounds.size)
    let region: CGRect
    if let mine = layer.presentation(), let theirs = space.layer.presentation() {
      region = mine.convert(shown, to: theirs)
    } else {
      region = layer.convert(shown, to: space.layer)
    }
    return region.isNull || region.isEmpty ? nil : region
  }

  var rimDisabled = false

  var needsRetry: Bool { lens.needsRetry || rim.needsRetry }

  var showsLens: Bool { lensOn == true }
  private(set) var clearReason = ""

  func plan(with capture: GlassCapture?, space: UIView?) -> [GlassDrawJob] {
    guard GlassMetal.shared.pipeline != nil else { return [] }
    let size = lensLayer.bounds.size
    guard size.width > 0, size.height > 0 else { return [] }
    var jobs: [GlassDrawJob] = []
    if choice.path.isGlassy {
      var drawing = false
      var shows = false
      if LiquidGlassRules.acceptsCapture(choice.path), let capture, let space, let captured = capture.texture, let shown = region(in: space), !capture.rect.isNull {
        let shift = capture.scrollShift
        let region = shown.offsetBy(dx: shift.x, dy: shift.y)
        let rect = capture.rect
        let footprint = GlassFlowRules.footprint(of: shown, margin: marginPoints).intersection(space.bounds).offsetBy(dx: shift.x, dy: shift.y)
        if PhoneTestBuild.isOn {
          let valid = capture.validRect
          clearReason = valid.contains(footprint) ? "lead" : footprint.minY < valid.minY ? "above\(Int((valid.minY - footprint.minY) / 100) * 100)" : footprint.maxY > valid.maxY ? "below\(Int((footprint.maxY - valid.maxY) / 100) * 100)" : "side"
        }
        if GlassFlowRules.lensDraws(footprint: footprint, capture: capture.validRect) {
          drawing = true
          shows = GlassFlowRules.lensShows(footprint: footprint, capture: capture.validRect, velocity: capture.velocity, travel: capture.travel)
          let uv = (Double((region.minX - rect.minX) / rect.width), Double((region.minY - rect.minY) / rect.height), Double(region.width / rect.width), Double(region.height / rect.height))
          if let job = lens.plan(makeFrame(size: size, live: true, uv: uv, rimOnly: false).uniforms, generation: capture.generation, size: size, texture: captured, live: true) { jobs.append(job) }
        }
      }
      if PhoneTestBuild.isOn, capture?.texture == nil { clearReason = "none" }
      if !drawing { lens.forget() }
      lensWanted = shows
    } else {
      lensWanted = false
      if let job = lens.plan(makeFrame(size: size, live: false, uv: (0, 0, 1, 1), rimOnly: false).uniforms, generation: -1, size: size, texture: nil) { jobs.append(job) }
    }
    if choice.rim, !rimDisabled, let job = rim.plan(makeFrame(size: size, live: false, uv: (0, 0, 1, 1), rimOnly: true).uniforms, generation: 0, size: size, texture: nil) { jobs.append(job) }
    updateVisibility()
    return jobs
  }

  func updateVisibility() {
    let metal = GlassMetal.shared.isReady && !classic
    let glassy = choice.path.isGlassy && !classic
    let rimShown = choice.rim && !rimDisabled && rim.hasDrawn && metal
    let lensDrawn = lens.hasDrawn && metal
    let on = glassy ? lensWanted && lens.drawnLive && lensDrawn : lensDrawn
    let fillShown = !glassy && !lensDrawn
    if lensLayer.isHidden == lensDrawn || rim.layer.isHidden == rimShown || fillLayer.isHidden == fillShown || clearLayer.isHidden == glassy {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      lensLayer.isHidden = !lensDrawn
      fillLayer.isHidden = !fillShown
      clearLayer.isHidden = !glassy
      rim.layer.isHidden = !rimShown
      CATransaction.commit()
    }
    setLens(on: on, fades: glassy)
  }

  private func setLens(on: Bool, fades: Bool) {
    guard on != lensOn else { return }
    let now = CACurrentMediaTime()
    if lensOn == true, !on, choice.path == .live, waitsForPage, now - lastBridge >= 1 {
      lastBridge = now
      PendingCounts.add(PendingCounts.glassLensBridged)
    }
    lensOn = on
    let target: Float = on ? 1 : 0
    let from = lensLayer.presentation()?.opacity ?? lensLayer.opacity
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    lensLayer.opacity = target
    if fades, from != target, !lensLayer.isHidden {
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = from
      fade.toValue = target
      fade.duration = GlassFlowRules.lensFade * Double(abs(target - from))
      fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      lensLayer.add(fade, forKey: "fade")
    } else {
      lensLayer.removeAnimation(forKey: "fade")
    }
    CATransaction.commit()
  }

  private func drawStill() {
    guard window != nil, GlassMetal.shared.isReady, !classic else { return }
    if GlassFrames.shared.drawsInThisFrame(self) { return }
    GlassFrames.shared.submitStill(self)
  }

  func drawPendingStill() {
    guard (stillPending || needsRetry), !wantsFrames else { return }
    drawStill()
  }

  private func makeFrame(size: CGSize, live: Bool, uv: (left: Double, top: Double, width: Double, height: Double), rimOnly: Bool) -> LiquidGlassShader.Frame {
    let dark = isDark
    let now = CACurrentMediaTime()
    if let toneDark, toneDark != dark { toneChangedAt = now }
    toneDark = dark
    let fill = choice.path == .solid ? (solidFill.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? GlassFrostStyle.glass.fallback(dark: dark)) : GlassFrostStyle.glass.fallback(dark: dark)
    var frame = LiquidGlassShader.Frame(
      width: Double(size.width),
      height: Double(size.height),
      scale: Double(lensLayer.contentsScale),
      radius: Double(radius(for: size)),
      live: live,
      lens: live && choice.lens,
      rim: choice.rim,
      dark: dark,
      uv: uv,
      fill: fill,
      tint: tint.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? .clear,
      bound: bound.measure(size)
    )
    frame.rimOnly = rimOnly
    frame.toneLimit = LiquidGlassRules.toneLimit(dark: dark, since: now - toneChangedAt)
    return frame
  }

  private func traits(_ dark: Bool) -> UITraitCollection { UITraitCollection(userInterfaceStyle: dark ? .dark : .light) }

  private func radius(for size: CGSize) -> CGFloat {
    if let presented = presentedRadius?() { return min(presented, min(size.width, size.height) / 2) }
    return CGFloat(LiquidGlassRules.radius(capsule: capsule, cornerRadius: Double(cornerRadius), width: Double(size.width), height: Double(size.height)))
  }

  private func layoutLayers(size: CGSize) {
    let scale = self.scale
    if let laidOut, laidOut.size == size, laidOut.scale == scale { return }
    laidOut = (size, scale)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let frame = CGRect(origin: .zero, size: size)
    fillLayer.frame = frame
    clearLayer.frame = frame
    for target in [lens, rim] { target.lay(out: frame, scale: scale) }
    CATransaction.commit()
    invalidate()
  }

  private func applyFallback() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let dark = isDark
    let corner = radius(for: bounds.size)
    let base = choice.path == .solid ? (solidFill.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? GlassFrostStyle.glass.fallback(dark: dark)) : GlassFrostStyle.glass.fallback(dark: dark)
    let tintInk = tint.map { GlassInk($0.resolvedColor(with: traits(dark))) }
    let edge = GlassFrostStyle.glass.edge(dark: dark).color
    let veil = tintInk.map { $0.over(GlassFrostStyle.glass.clear(dark: dark)) } ?? GlassFrostStyle.glass.clear(dark: dark)
    for (target, ink) in [(fillLayer, tintInk.map { $0.over(base) } ?? base), (clearLayer, LiquidGlassRules.readableVeil(veil, dark: dark))] {
      target.backgroundColor = ink.color
      target.cornerRadius = corner
      target.borderWidth = GlassFrostStyle.glass.edgeWidth
      target.borderColor = edge
    }
    CATransaction.commit()
    updateVisibility()
  }

  private func report() {
    let line = "path=\(choice.path.rawValue) (\(choice.reason)) lens=\(choice.lens ? "yes" : "no") rim=\(choice.rim ? "yes" : "no") source=\(source ?? "none")"
    guard PhoneTestBuild.isOn, line != reportedPath else { return }
    reportedPath = line
    NSLog("PAGELAB look glass %@ %@ %@", label, NSCoder.string(for: bounds.size), line)
  }

  private static func same(_ one: UIColor?, _ other: UIColor?) -> Bool {
    switch (one, other) {
    case (nil, nil): true
    case let (one?, other?): one.isEqual(other)
    default: false
    }
  }
}

@MainActor
final class LiquidGlassSurfaceBound {
  private var bound = LiquidGlassBound()

  func measure(_ size: CGSize) -> LiquidGlassBound {
    bound.measure(width: Double(size.width), height: Double(size.height))
    return bound
  }
}

@MainActor
enum GlassBlank {
  static let texture: MTLTexture? = {
    guard let device = GlassMetal.shared.device else { return nil }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false)
    descriptor.usage = .shaderRead
    let texture = device.makeTexture(descriptor: descriptor)
    var clear: UInt32 = 0
    texture?.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &clear, bytesPerRow: 4)
    return texture
  }()
}

extension GlassInk {
  init(_ color: UIColor) {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    self.init(red: Double(min(max(red, 0), 1)), green: Double(min(max(green, 0), 1)), blue: Double(min(max(blue, 0), 1)), alpha: Double(min(max(alpha, 0), 1)))
  }

  var color: CGColor { UIColor(red: red, green: green, blue: blue, alpha: alpha).cgColor }

  func over(_ under: GlassInk) -> GlassInk {
    let alpha = self.alpha + under.alpha * (1 - self.alpha)
    guard alpha > 0 else { return .clear }
    func mix(_ top: Double, _ bottom: Double) -> Double { (top * self.alpha + bottom * under.alpha * (1 - self.alpha)) / alpha }
    return GlassInk(red: mix(red, under.red), green: mix(green, under.green), blue: mix(blue, under.blue), alpha: alpha)
  }
}

@MainActor
final class GlassTarget {
  let layer = CAMetalLayer()
  var drawn: [Float]?
  private var drawnGeneration = -1
  private var drawnSize: CGSize = .zero
  private var epoch = 0
  private(set) var pending = 0
  private(set) var needsRetry = false
  private(set) var hasDrawn = false
  private(set) var drawnLive = false
  var onDrawn: (() -> Void)?

  init(adds: Bool) {
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = true
    layer.isOpaque = false
    layer.allowsNextDrawableTimeout = true
    layer.maximumDrawableCount = 3
    layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    layer.isHidden = true
    if adds { layer.compositingFilter = "plusL" }
  }

  func lay(out frame: CGRect, scale: CGFloat) {
    layer.frame = frame
    layer.contentsScale = scale
    layer.drawableSize = CGSize(width: (frame.width * scale).rounded(), height: (frame.height * scale).rounded())
    layer.device = GlassMetal.shared.device
  }

  func forget() {
    guard drawn != nil || drawnLive || needsRetry else { return }
    drawn = nil
    drawnLive = false
    needsRetry = false
    epoch += 1
  }

  func plan(_ uniforms: [Float], generation: Int, size: CGSize, texture: MTLTexture?, live: Bool = false) -> GlassDrawJob? {
    if !needsRetry, uniforms == drawn, generation == drawnGeneration, size == drawnSize { return nil }
    guard pending == 0, let source = texture ?? GlassBlank.texture else {
      needsRetry = true
      return nil
    }
    pending += 1
    needsRetry = false
    let epoch = self.epoch
    return GlassDrawJob(layer: layer, uniforms: uniforms, texture: source) { [weak self] drew in
      guard let self else { return }
      self.pending = max(self.pending - 1, 0)
      if drew {
        self.hasDrawn = true
        if epoch == self.epoch {
          self.drawn = uniforms
          self.drawnGeneration = generation
          self.drawnSize = size
          self.drawnLive = live
        }
      } else if epoch == self.epoch {
        self.needsRetry = true
      }
      self.onDrawn?()
    }
  }
}
