import AppKit
import ArdiaCore
import ExpoModulesCore

final class PeekStage: ExpoView {
  let onPeekState = EventDispatcher()
  let onPeekDone = EventDispatcher()
  let onPeekPinch = EventDispatcher()
  var gestures = true
  var meshAllowed = false { didSet { refreshWarp() } }
  var reduceMotion = false { didSet { motion.reduce = reduceMotion || Self.forcedReduce } }

  static let stages = NSHashTable<PeekStage>.weakObjects()
  static let traceLimit = 1200
  static var lastDetached: [String: Any]?

  let motion = PeekMotion()
  let scrim = PeekContainer()
  let card = PeekContainer()
  let chrome = PeekContainer()
  let page = PeekContainer()
  private let pageMask = CAShapeLayer()
  private var link: CADisplayLink?
  private var backup: Timer?
  private var lastLinkTick = 0.0
  private var announced = ""
  private var meshFailure: String?
  private var meshShown = false
  var pressInPage = false
  var pressMapping: PeekAffine?
  private var donorWatch: CFRunLoopObserver?
  private(set) var lastFrame = PeekFrame()
  private(set) var trace: [[String: Any]] = []
  private(set) var events: [[String: Any]] = []
  private(set) var freezes: [[String: Any]] = []

  private static let testMesh: ArdiaPeekMeshTestMode = {
    switch LaunchConfig.shared.testValue("peekMesh") {
    case "unavailable": return .unavailable
    case "throws": return .throws
    default: return .none
    }
  }()
  private static let neverReady = LaunchConfig.shared.testValue("peekReady") == "never"
  private static let forcedReduce = LaunchConfig.shared.testFlag("peekReduceMotion")
  private static let slow = max(1, Double(LaunchConfig.shared.testValue("peekSlow") ?? "") ?? 1)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    ArdiaPeekMesh.testMode = Self.testMesh
    motion.reduce = Self.forcedReduce
    motion.slow = Self.slow
    wantsLayer = true
    addSubview(scrim)
    addSubview(card)
    card.addSubview(chrome)
    card.addSubview(page)
    page.layer?.mask = pageMask
    pageMask.fillColor = NSColor.black.cgColor
    _ = PeekInputRoute.install
    _ = installMagnifyMonitor
  }

  override var isFlipped: Bool { true }

  override func didUpdateReactSubviews() {
    let children: [NSView] = reactSubviews() ?? []
    scrim.hold(children.count > 0 ? children[0] : nil)
    chrome.hold(children.count > 1 ? children[1] : nil)
    page.hold(children.count > 2 ? children[2] : nil)
    render(at: CACurrentMediaTime())
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    scrim.frame = bounds
    card.frame = bounds
    chrome.frame = card.bounds
    page.frame = card.bounds
    render(at: CACurrentMediaTime())
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil {
      if donorWatch != nil, pageWebView?.showsPaintedFrame != true { note("donated", ["at": "detach"]) }
      #if DEBUG
      if motion.generation > 0 { Self.lastDetached = devState().merging(["detached": true]) { $1 } }
      #endif
      Self.stages.remove(self)
      stopWatchingDonor()
      if motion.animating { note("cancelled", ["reason": "window"]) }
      motion.cancel()
      stopTicking()
      clearMesh()
    } else {
      Self.stages.add(self)
    }
  }

  func setGeometry(_ dict: [String: Any]) {
    guard let next = PeekGeometry(dict) else { return }
    let now = CACurrentMediaTime()
    let before = motion.phase
    motion.setGeometry(next, at: now)
    if before != motion.phase { note("geometry", ["from": before.rawValue]) }
    render(at: now)
    deliver()
    if motion.animating { startTicking() }
  }

  func begin(_ generation: Int, animated: Bool = true) -> Bool {
    let now = CACurrentMediaTime()
    refreshWarp()
    guard motion.begin(generation, at: now, animated: animated) else { return false }
    pressInPage = false
    trace.removeAll()
    events.removeAll()
    freezes.removeAll()
    announced = ""
    note("begin", ["canWarp": motion.canWarp, "unavailable": unavailable as Any])
    render(at: now)
    announce()
    startTicking()
    return true
  }

  func settleEntrance() {
    let now = CACurrentMediaTime()
    guard motion.settleEntrance(at: now) else { return }
    note("settled", [:])
    render(at: now)
    announce()
  }

  func close(_ generation: Int) -> Bool { command(generation, "close") { motion.close(at: $0) } }

  func promote(_ generation: Int) -> Bool { command(generation, "promote") { motion.promote(at: $0) } }

  private func command(_ generation: Int, _ name: String, _ run: (Double) -> Bool) -> Bool {
    guard generation == motion.generation else { return false }
    let now = CACurrentMediaTime()
    let before = motion.warpingEntrance ? lastFrame : nil
    guard run(now) else { return false }
    if let before { recordFreeze(name, before: before, after: motion.frame(at: motion.lastCommitAt)) }
    note(name, [:])
    render(at: now)
    announce()
    deliver()
    startTicking()
    return true
  }

  static func under(_ location: NSPoint, in window: NSWindow) -> PeekStage? {
    stages.allObjects.first { stage in
      guard stage.window === window, !stage.isHiddenOrHasHiddenAncestor, stage.gestures, !stage.motion.terminal, stage.motion.phase != .waiting else { return false }
      let p = stage.convert(location, from: nil)
      return stage.shownCard.contains(p) || (stage.motion.warpingEntrance && stage.motion.geometry.card.contains(p))
    }
  }

  func magnify(phase: String, total: Double) {
    let now = CACurrentMediaTime()
    switch phase {
    case "began":
      let before = motion.warpingEntrance ? lastFrame : nil
      guard motion.gestureBegan(at: now) else { return }
      if let before { recordFreeze("pinch", before: before, after: motion.frame(at: motion.lastCommitAt)) }
      note("pinch", ["total": total])
      motion.gestureChanged(total, at: now)
    case "changed":
      motion.gestureChanged(total, at: now)
    default:
      let outcome = motion.gestureEnded(total, cancelled: phase == "cancelled", at: now)
      note("release", ["total": total, "outcome": outcome.rawValue])
      onPeekPinch(["generation": motion.generation, "outcome": outcome.rawValue])
    }
    render(at: now)
    announce()
    deliver()
    if motion.animating { startTicking() }
  }

  var shownCard: CGRect {
    if lastFrame.warping, let first = lastFrame.to.first {
      return lastFrame.to.reduce(CGRect(origin: first, size: .zero)) { $0.union(CGRect(origin: $1, size: .zero)) }
    }
    return motion.geometry.fullscreen ? bounds : lastFrame.card.apply(motion.geometry.card)
  }

  private func startTicking() {
    guard link == nil, let screen = window?.screen ?? NSScreen.main else { return tick() }
    let link = screen.displayLink(target: PeekStageFrames(self), selector: #selector(PeekStageFrames.frame(_:)))
    let fps = Float(max(60, screen.maximumFramesPerSecond))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: fps, preferred: fps)
    link.add(to: .main, forMode: .common)
    self.link = link
    lastLinkTick = CACurrentMediaTime()
    let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
      guard let self else { return timer.invalidate() }
      if CACurrentMediaTime() - self.lastLinkTick > 0.05 { self.tick() }
    }
    RunLoop.main.add(timer, forMode: .common)
    backup = timer
  }

  private func stopTicking() {
    link?.invalidate()
    link = nil
    backup?.invalidate()
    backup = nil
  }

  fileprivate func tick(fromLink: Bool = false) {
    let now = CACurrentMediaTime()
    if fromLink { lastLinkTick = now }
    if motion.phase == .waiting, !Self.neverReady, pageWebView?.showsPaintedFrame == true {
      note("painted", [:])
      motion.markReady(at: now)
    }
    motion.advance(to: now)
    render(at: now)
    announce()
    deliver()
    if !motion.animating { stopTicking() }
  }

  private var pageWebView: ArdiaWebView? {
    var queue: [NSView] = page.subviews
    while !queue.isEmpty {
      let view = queue.removeFirst()
      if let web = view as? ArdiaWebView { return web }
      queue.append(contentsOf: view.subviews)
    }
    return nil
  }

  private func render(at now: Double) {
    let f = motion.frame(at: now)
    lastFrame = f
    guard bounds.width > 0, bounds.height > 0 else { return }
    let topDown = page.topDown
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    scrim.layer?.opacity = Float(f.scrimAlpha)
    card.layer?.opacity = Float(f.cardAlpha)
    card.layer?.masksToBounds = true
    card.layer?.cornerRadius = motion.geometry.fullscreen ? 0 : motion.geometry.tabBottomRadius
    chrome.layer?.opacity = Float(f.chromeAlpha)
    if let layer = chrome.layer { layer.sublayerTransform = f.card.layerTransform(anchor: anchor(layer), height: bounds.height, topDown: chrome.topDown) }
    if let layer = page.layer {
      layer.sublayerTransform = f.page.layerTransform(anchor: anchor(layer), height: bounds.height, topDown: topDown)
      pageMask.frame = layer.bounds
      let scale = max(f.page.s, 1e-6)
      pageMask.path = Self.roundedPath(motion.geometry.page, top: f.topRadius / scale, bottom: f.bottomRadius / scale, height: bounds.height, topDown: topDown)
    }
    applyMesh(f, topDown: topDown, now: now)
    CATransaction.commit()
    motion.commit(lastFrame, at: now)
    record(lastFrame, now: now)
  }

  private func anchor(_ layer: CALayer) -> CGPoint {
    CGPoint(x: layer.bounds.minX + layer.anchorPoint.x * layer.bounds.width, y: layer.bounds.minY + layer.anchorPoint.y * layer.bounds.height)
  }

  private func applyMesh(_ f: PeekFrame, topDown: Bool, now: Double) {
    guard let layer = card.layer else { return }
    guard f.warping, meshFailure == nil else { return clearMesh() }
    let w = bounds.width, h = bounds.height
    let unit = { (p: CGPoint) in (p.x / w, topDown ? p.y / h : 1 - p.y / h) }
    var points = zip(f.from, f.to).map { from, to -> ArdiaPeekMeshPoint in
      let a = unit(from), b = unit(to)
      return ArdiaPeekMeshPoint(fromX: a.0, fromY: a.1, toX: b.0, toY: b.1)
    }
    let failure = points.withUnsafeMutableBufferPointer { buffer in
      ArdiaPeekMesh.apply(to: layer, points: buffer.baseAddress!, rows: UInt(PeekMotion.rows), columns: UInt(PeekMotion.columns))
    }
    if let failure {
      meshFailure = failure
      meshShown = false
      motion.canWarp = false
      note("fallback", ["reason": failure])
      motion.fallBack(at: now)
      lastFrame = motion.frame(at: now)
      card.layer?.opacity = Float(lastFrame.cardAlpha)
      if let pageLayer = page.layer { pageLayer.sublayerTransform = lastFrame.page.layerTransform(anchor: anchor(pageLayer), height: h, topDown: topDown) }
      if let chromeLayer = chrome.layer { chromeLayer.sublayerTransform = lastFrame.card.layerTransform(anchor: anchor(chromeLayer), height: h, topDown: topDown) }
    } else {
      meshShown = true
    }
  }

  private func refreshWarp() {
    motion.canWarp = meshAllowed && meshFailure == nil && ArdiaPeekMesh.unavailableReason() == nil
  }

  private var unavailable: String? { meshAllowed ? meshFailure ?? ArdiaPeekMesh.unavailableReason() : "switch" }

  private func watchDonor() {
    guard donorWatch == nil else { return }
    let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [weak self] _, _ in
      guard let self else { return }
      guard self.window != nil else { return self.stopWatchingDonor() }
      guard self.pageWebView?.showsPaintedFrame != true else { return }
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      self.page.layer?.opacity = 0
      CATransaction.commit()
      self.note("donated", [:])
      self.stopWatchingDonor()
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    donorWatch = observer
  }

  private func stopWatchingDonor() {
    if let donorWatch { CFRunLoopObserverInvalidate(donorWatch) }
    donorWatch = nil
  }

  private func clearMesh() {
    guard meshShown, let layer = card.layer else { return }
    ArdiaPeekMesh.clear(layer)
    meshShown = false
  }

  private static func roundedPath(_ r: CGRect, top: Double, bottom: Double, height: Double, topDown: Bool) -> CGPath {
    let rect = topDown ? r : CGRect(x: r.minX, y: height - r.maxY, width: r.width, height: r.height)
    let limit = min(rect.width, rect.height) / 2
    let t = min(max(top, 0), limit), b = min(max(bottom, 0), limit)
    let upper = topDown ? rect.minY : rect.maxY, lower = topDown ? rect.maxY : rect.minY
    let towardLower: CGFloat = topDown ? 1 : -1
    let path = CGMutablePath()
    path.move(to: CGPoint(x: rect.minX + t, y: upper))
    path.addLine(to: CGPoint(x: rect.maxX - t, y: upper))
    path.addQuadCurve(to: CGPoint(x: rect.maxX, y: upper + towardLower * t), control: CGPoint(x: rect.maxX, y: upper))
    path.addLine(to: CGPoint(x: rect.maxX, y: lower - towardLower * b))
    path.addQuadCurve(to: CGPoint(x: rect.maxX - b, y: lower), control: CGPoint(x: rect.maxX, y: lower))
    path.addLine(to: CGPoint(x: rect.minX + b, y: lower))
    path.addQuadCurve(to: CGPoint(x: rect.minX, y: lower - towardLower * b), control: CGPoint(x: rect.minX, y: lower))
    path.addLine(to: CGPoint(x: rect.minX, y: upper + towardLower * t))
    path.addQuadCurve(to: CGPoint(x: rect.minX + t, y: upper), control: CGPoint(x: rect.minX, y: upper))
    path.closeSubpath()
    return path
  }

  private func announce() {
    let key = "\(motion.generation):\(motion.phase.rawValue):\(motion.entrance.rawValue)"
    guard key != announced else { return }
    announced = key
    note("state", ["entrance": motion.entrance.rawValue, "canWarp": motion.canWarp, "valid": motion.geometry.valid, "interrupted": motion.interrupted])
    var payload: [String: Any] = [
      "generation": motion.generation, "phase": motion.phase.rawValue, "entrance": motion.entrance.rawValue,
      "interrupted": motion.interrupted, "readyTimedOut": motion.readyTimedOut,
    ]
    if let fallback = unavailable { payload["fallback"] = fallback }
    onPeekState(payload)
  }

  private func deliver() {
    guard let outcome = motion.takeOutcome() else { return }
    note("done", ["outcome": outcome.rawValue])
    clearMesh()
    if outcome == .promoted { watchDonor() }
    onPeekDone(["generation": motion.generation, "outcome": outcome.rawValue])
  }

  private func note(_ name: String, _ detail: [String: Any]) {
    #if DEBUG
    var entry = detail
    entry["event"] = name
    entry["t"] = CACurrentMediaTime()
    entry["phase"] = motion.phase.rawValue
    events.append(entry)
    #endif
  }

  private func record(_ f: PeekFrame, now: Double) {
    #if DEBUG
    if trace.count >= Self.traceLimit { trace.removeFirst(trace.count - Self.traceLimit + 1) }
    let s = f.shownPage
    trace.append([
      "t": now, "phase": motion.phase.rawValue, "entrance": motion.entrance.rawValue, "m": motion.expansion,
      "card": [f.card.s, f.card.tx, f.card.ty], "page": [f.page.s, f.page.tx, f.page.ty], "shown": [s.minX, s.minY, s.width, s.height],
      "alpha": f.cardAlpha, "chrome": f.chromeAlpha, "scrim": f.scrimAlpha, "warping": f.warping, "residual": f.residual,
      "mesh": meshShown, "vertices": f.to.isEmpty ? [] : [f.to[0].x, f.to[0].y, f.to[f.to.count - 1].x, f.to[f.to.count - 1].y],
      "bbox": f.to.isEmpty ? [] : { let b = f.to.reduce(CGRect(origin: f.to[0], size: .zero)) { $0.union(CGRect(origin: $1, size: .zero)) }; return [b.minX, b.minY, b.width, b.height] }(),
    ])
    #endif
  }

  private func recordFreeze(_ name: String, before: PeekFrame, after: PeekFrame) {
    #if DEBUG
    let flat = { (f: PeekFrame) in f.to.flatMap { [$0.x, $0.y] } }
    freezes.append(["event": name, "before": flat(before), "after": flat(after), "alphaBefore": before.cardAlpha, "alphaAfter": after.cardAlpha, "scrimBefore": before.scrimAlpha, "scrimAfter": after.scrimAlpha])
    #endif
  }

  private func topLeft(_ r: CGRect) -> CGRect {
    let height = window?.contentView?.frame.height ?? 0
    return CGRect(x: r.minX, y: height - r.maxY, width: r.width, height: r.height)
  }

  private func devLayers() -> [[String: Any]] {
    var widget: NSView?
    var queue: [NSView] = [page]
    while !queue.isEmpty, widget == nil {
      let view = queue.removeFirst()
      if NSStringFromClass(type(of: view)).contains("RenderWidgetHostView") { widget = view }
      queue.append(contentsOf: view.subviews)
    }
    var out: [[String: Any]] = []
    var layer = widget?.layer
    while let current = layer {
      let t = current.transform, st = current.sublayerTransform
      out.append([
        "class": NSStringFromClass(type(of: current)), "delegate": current.delegate.map { NSStringFromClass(type(of: $0)) } ?? "",
        "frame": [current.frame.minX, current.frame.minY, current.frame.width, current.frame.height],
        "t": [t.m11, t.m22, t.m41, t.m42], "st": [st.m11, st.m22, st.m41, st.m42], "flipped": current.isGeometryFlipped,
      ])
      if current === layer?.superlayer, current === self.layer { break }
      layer = current.superlayer
      if out.count > 40 { break }
    }
    return out
  }

  func devState() -> [String: Any] {
    let g = motion.geometry
    let rect = { (r: CGRect) in ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
    return [
      "generation": motion.generation, "phase": motion.phase.rawValue, "entrance": motion.entrance.rawValue, "windowNumber": window?.windowNumber ?? 0,
      "meshFailure": unavailable as Any, "meshShown": meshShown, "meshAllowed": meshAllowed, "meshInspected": ArdiaPeekMesh.inspected,
      "layerHasMesh": meshAllowed ? card.layer.map { ArdiaPeekMesh.hasMesh($0) } ?? false : false,
      "topDown": page.topDown, "geometry": ["page": rect(g.page), "rest": rect(g.rest), "card": rect(g.card), "source": rect(g.source)],
      "stageInWindow": rect(topLeft(convert(bounds, to: nil))),
      "pageInWindow": rect(topLeft(page.subviews.first.map { $0.convert($0.bounds, to: nil) } ?? .zero)),
      "trace": trace, "events": events, "freezes": freezes, "layers": devLayers(),
    ]
  }
}

private final class PeekStageFrames: NSObject {
  weak var stage: PeekStage?

  init(_ stage: PeekStage) { self.stage = stage }

  @objc func frame(_ link: CADisplayLink) {
    guard let stage else { return link.invalidate() }
    stage.tick(fromLink: true)
  }
}
