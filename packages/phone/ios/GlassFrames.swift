import ArdiaDesign
import Metal
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassFrames: NSObject {
  static let shared = GlassFrames()

  private let surfaces = NSHashTable<LiquidGlassSurface>.weakObjects()
  private let captures = NSMapTable<AnyObject, GlassCapture>.weakToStrongObjects()
  private let cooldowns = NSMapTable<AnyObject, GlassCooldownBox>.weakToStrongObjects()
  private var link: CADisplayLink?
  private var slowTimer: Timer?
  private var stats = FrameStats()
  private var lastTimestamp: CFTimeInterval = 0
  private var flight = GlassFlight()
  private var stillsWaiting = false
  private var framing = false
  private var framedStills: [LiquidGlassSurface] = []

  var inFlight: Int { flight.inFlight }

  override init() {
    super.init()
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(releaseCaptures), name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(self, selector: #selector(releaseCaptures), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
  }

  func attach(_ surface: LiquidGlassSurface) {
    surfaces.add(surface)
    GlassMetal.shared.prepare()
    schedule()
  }

  func detach(_ surface: LiquidGlassSurface) {
    surfaces.remove(surface)
    captures.removeObject(forKey: surface)
    cooldowns.removeObject(forKey: surface)
    schedule()
  }

  func metalChanged() {
    for surface in surfaces.allObjects { surface.metalChanged() }
    schedule()
  }

  func sourcesChanged() {
    for surface in surfaces.allObjects { surface.needsPath() }
    schedule()
  }

  func isOverBudget(_ owner: AnyObject?) -> Bool {
    guard let owner, let box = cooldowns.object(forKey: owner) else { return false }
    return box.cooldown.isCooling(now: CACurrentMediaTime())
  }

  func retryBudget() {
    guard cooldowns.count > 0 else { return }
    cooldowns.removeAllObjects()
    for surface in surfaces.allObjects { surface.needsPath() }
  }

  private let warmedOwners = NSHashTable<AnyObject>.weakObjects()

  func submitStill(_ surface: LiquidGlassSurface) {
    guard let pipeline = GlassMetal.shared.pipeline, let commands = GlassMetal.shared.queue else { return }
    guard flight.reserve() else {
      surface.stillPending = true
      stillsWaiting = true
      return
    }
    surface.stillPending = false
    let jobs = surface.plan(with: nil, space: nil)
    guard !jobs.isEmpty else {
      flight.finish()
      return
    }
    GlassRenderer.shared.run(blurs: [], draws: jobs, pipeline: pipeline, commands: commands) { GlassFrames.shared.finished() }
  }

  func drawsInThisFrame(_ surface: LiquidGlassSurface) -> Bool {
    guard framing else { return false }
    if !framedStills.contains(where: { $0 === surface }) { framedStills.append(surface) }
    return true
  }

  private func finished() {
    flight.finish()
    stillsWaiting = false
    for surface in surfaces.allObjects where surface.window != nil && (surface.stillPending || surface.needsRetry) && !surface.wantsFrames {
      surface.drawPendingStill()
    }
  }

  @objc func releaseCaptures() {
    let enumerator = captures.objectEnumerator()
    while let capture = enumerator?.nextObject() as? GlassCapture { capture.release() }
    captures.removeAllObjects()
    GlassMetal.shared.flushTextures()
    for surface in surfaces.allObjects { surface.invalidate() }
  }

  func schedule() {
    let attached = surfaces.allObjects.filter { $0.window != nil }
    let wantsFrames = attached.contains { $0.wantsFrames }
    if wantsFrames, link == nil {
      let made = CADisplayLink(target: self, selector: #selector(frame(_:)))
      made.add(to: .main, forMode: .common)
      link = made
      lastTimestamp = 0
    } else if !wantsFrames, let link {
      link.invalidate()
      self.link = nil
      trimCaptures(keeping: [])
    }
    let wantsSlow = attached.contains { $0.wantsPathChecks }
    if wantsSlow, slowTimer == nil {
      let timer = Timer(timeInterval: LiquidGlassRules.pageCheckInterval, repeats: true) { _ in
        MainActor.assumeIsolated { GlassFrames.shared.checkPaths() }
      }
      RunLoop.main.add(timer, forMode: .common)
      slowTimer = timer
    } else if !wantsSlow, let timer = slowTimer {
      timer.invalidate()
      slowTimer = nil
    }
  }

  private func trimCaptures(keeping owners: [AnyObject]) {
    let keys = captures.keyEnumerator().allObjects as [AnyObject]
    for key in keys where !owners.contains(where: { $0 === key }) {
      captures.object(forKey: key)?.release()
      captures.removeObject(forKey: key)
    }
    if owners.isEmpty { GlassMetal.shared.flushTextures() }
  }

  private func checkPaths() {
    for surface in surfaces.allObjects where surface.window != nil && surface.wantsPathChecks { surface.needsPath() }
    schedule()
  }

  @objc private func frame(_ link: CADisplayLink) {
    let started = CACurrentMediaTime()
    let now = link.timestamp
    let frameMs = max(link.targetTimestamp - link.timestamp, 1.0 / 120) * 1000
    if PhoneTestBuild.isOn, lastTimestamp > 0 {
      stats.note(interval: now - lastTimestamp, target: frameMs / 1000)
    }
    lastTimestamp = now
    let live = surfaces.allObjects.filter { $0.window != nil && $0.wantsFrames }
    guard !live.isEmpty else {
      schedule()
      return
    }
    guard let pipeline = GlassMetal.shared.pipeline, let commands = GlassMetal.shared.queue else { return }
    guard flight.reserve() else {
      if PhoneTestBuild.isOn { stats.dropped += 1 }
      return
    }
    framing = true
    var blurs: [GlassBlurJob] = []
    var draws: [GlassDrawJob] = []
    var groups: [ObjectIdentifier: (owner: AnyObject, space: UIView, members: [LiquidGlassSurface])] = [:]
    var still: [LiquidGlassSurface] = []
    for surface in live {
      surface.followPresentation()
      if LiquidGlassRules.acceptsCapture(surface.choice.path), let owner = surface.captureOwner, let space = GlassBackdrop.space(for: surface) {
        groups[ObjectIdentifier(owner), default: (owner, space, [])].members.append(surface)
      } else {
        still.append(surface)
      }
    }
    for entry in groups.values {
      let capture = captures.object(forKey: entry.owner) ?? GlassCapture(warmed: warmedOwners.contains(entry.owner))
      captures.setObject(capture, forKey: entry.owner)
      if capture.page.onMainWork == nil {
        capture.page.onMainWork = { [weak capture] ms in capture?.noteMainThread(ms: ms, now: CACurrentMediaTime(), captured: false) }
      }
      collect(capture, entry.space, entry.members, owner: entry.owner, blurs: &blurs, now: now, frameMs: frameMs)
      for surface in entry.members {
        draws += surface.plan(with: LiquidGlassRules.acceptsCapture(surface.choice.path) ? capture : nil, space: entry.space)
      }
    }
    for surface in still { draws += surface.plan(with: nil, space: nil) }
    if PhoneTestBuild.isOn {
      for surface in live where surface.choice.path == .live {
        if surface.showsLens {
          stats.lensFrames += 1
        } else {
          stats.clearFrames += 1
          stats.clearReasons[surface.clearReason, default: 0] += 1
        }
      }
    }
    framing = false
    let stills = framedStills
    framedStills.removeAll()
    for surface in stills where surface.window != nil { draws += surface.plan(with: nil, space: nil) }
    if blurs.isEmpty, draws.isEmpty {
      flight.finish()
    } else {
      GlassRenderer.shared.run(blurs: blurs, draws: draws, pipeline: pipeline, commands: commands) { GlassFrames.shared.finished() }
    }
    trimCaptures(keeping: groups.values.map(\.owner))
    if PhoneTestBuild.isOn {
      stats.noteTick(ms: (CACurrentMediaTime() - started) * 1000)
      if let line = stats.report(now: now, surfaces: live.count) { NSLog("%@", line) }
    }
    schedule()
  }

  private func collect(_ capture: GlassCapture, _ space: UIView, _ members: [LiquidGlassSurface], owner: AnyObject, blurs: inout [GlassBlurJob], now: CFTimeInterval, frameMs: Double) {
    let started = CACurrentMediaTime()
    var capturedNow = false
    var marks: [String] = []
    func mark(_ name: String) { if PhoneTestBuild.isOn { marks.append("\(name)=\(String(format: "%.1f", (CACurrentMediaTime() - started) * 1000))") } }
    defer {
      let spent = (CACurrentMediaTime() - started) * 1000
      if PhoneTestBuild.isOn, spent > frameMs { NSLog("PAGELAB look glass slow pass %@ %.1f ms: %@", members.map(\.label).joined(separator: ","), spent, marks.joined(separator: " ")) }
      capture.noteMainThread(ms: spent, now: now, captured: capturedNow)
      if capturedNow { warmedOwners.add(owner) }
      if PhoneTestBuild.isOn { stats.mainMs.append(spent) }
      if capture.overBudget(now: now, frameMs: frameMs), !isOverBudget(owner) {
        let box = cooldowns.object(forKey: owner) ?? GlassCooldownBox()
        box.cooldown.trip(now: CACurrentMediaTime())
        cooldowns.setObject(box, forKey: owner)
        capture.forgetSamples()
        PendingCounts.add(PendingCounts.glassCapturesOverBudget)
        NSLog("PAGELAB look glass capture over budget: %@ turns to clear glass for %.0f s (trip %d, last %.1f ms)", members.map(\.label).joined(separator: ","), LiquidGlassRules.budgetCooldown(trips: box.cooldown.trips), box.cooldown.trips, spent)
        members.forEach { $0.needsPath() }
      }
    }
    var wanted = CGRect.null
    var sigma = 0.0
    var pixelsPerPoint: CGFloat = 1
    for surface in members {
      guard let region = surface.region(in: space) else { continue }
      wanted = wanted.union(region.insetBy(dx: -surface.marginPoints, dy: -surface.marginPoints))
      sigma = max(sigma, surface.blurSigma)
      pixelsPerPoint = surface.capturePixelsPerPoint
    }
    let strip = wanted.intersection(space.bounds)
    guard !strip.isNull, !strip.isEmpty else { return }
    let method = GlassLaunch.capture
    let sourceWhole = members[0].backdropMode == .source
    let pieces: [GlassLayerPiece]
    let web: WKWebView?
    if sourceWhole {
      web = method == .auto ? GlassSources.page(in: space) : nil
      if method == .auto, web == nil, GlassSources.holdsPage(in: space) || members.contains(where: \.waitsForPage) {
        capture.drop()
        return
      }
      let reach = GlassLaunch.pageShot == .pdf ? GlassFlowRules.captureReach(speed: hypot(capture.page.velocity.x, capture.page.velocity.y)) : GlassFlowRules.scrollReach
      wanted = web == nil ? space.bounds : strip.insetBy(dx: 0, dy: -reach)
      pieces = GlassBackdrop.pieces(of: space, covering: wanted, web: web)
    } else if let root = members[0].backdropRoot {
      wanted = strip
      let found = method == .auto ? GlassSources.page(in: root) : nil
      web = found.flatMap { candidate in members.contains { $0.isDescendant(of: candidate) } ? nil : candidate }
      pieces = GlassBackdrop.pieces(under: members[0], root: root, covering: wanted, web: web)
    } else {
      return
    }
    mark("pieces\(pieces.count)")
    capture.strikes = sourceWhole && web == nil ? LiquidGlassRules.backdropStrikes : 1
    let pageIndex = pieces.firstIndex { $0.page != nil }
    let page = pageIndex.map { pieces[$0] }
    let near = strip.insetBy(dx: 0, dy: -GlassFlowRules.scrollReach)
    let pageFrame = page.map { $0.bounds.applying($0.transform) } ?? .null
    let shiftable = sourceWhole && GlassLaunch.pageMode == .shift && pageFrame.contains(strip) && GlassFlowRules.shiftable(pageIndex: pageIndex, overlapsAbove: pieces.map { $0.bounds.applying($0.transform).intersects(near) })
    if PhoneTestBuild.isOn, sourceWhole, web != nil, !shiftable {
      let reason = GlassLaunch.pageMode != .shift ? "mode" : !pageFrame.contains(strip) ? "frame" : page == nil ? "nopage" : "overlap"
      stats.unshifted[reason, default: 0] += 1
    }
    if let web, page != nil, capture.page.observe(web, now: now) {
      capture.drop()
      if capture.page.arrived { capture.motion.arrive(now: now) }
      capture.tone = GlassToneGate()
      NotificationCenter.default.post(name: GlassTone.changed, object: web)
    }
    capture.motion.observe(pieces.map { $0.bounds.applying($0.transform) }, in: space.bounds, now: now)
    capture.page.heldUntil = capture.motion.heldUntil
    let held = capture.motion.holds(now: now)
    if held != capture.wasHeld {
      capture.wasHeld = held
      if PhoneTestBuild.isOn { NSLog("PAGELAB time glass hold %@ %.0f", held ? "on" : "off", Date().timeIntervalSince1970 * 1000) }
    }
    if held {
      if PhoneTestBuild.isOn { stats.heldFrames += 1 }
      return
    }
    if let landed = capture.land(sigma: sigma, blurs: &blurs, now: now) { finish(landed, capture: capture, members: members, pieces: pieces.count, sourceWhole: sourceWhole, page: web != nil) }
    if capture.dropsPageCapture(shiftable: shiftable) {
      capture.drop()
      if PhoneTestBuild.isOn { NSLog("PAGELAB look glass %@ page capture dropped: the page no longer shifts under it", members.map(\.label).joined(separator: ",")) }
    }
    capture.survey(pieces, rect: shiftable ? strip : wanted, shiftable: shiftable)
    mark("survey")
    if let web, let page {
      let under = strip.applying(page.transform.inverted())
      capture.page.request(web, around: under, pixelsPerPoint: pixelsPerPoint, now: now)
      if let luminance = capture.page.luminance(under: under, of: web), capture.tone.observe(luminance: luminance, now: now), let dark = capture.tone.dark {
        NotificationCenter.default.post(name: GlassTone.changed, object: web, userInfo: [GlassTone.darkKey: dark])
        if PhoneTestBuild.isOn {
          stats.toneFlips += 1
          NSLog("PAGELAB glass tone %@ (under the bar %.2f)", dark ? "dark" : "light", luminance)
        }
      }
    }
    mark("request")
    var need: CGRect?
    var pageOnly: (steps: GlassSteps, drawn: CGRect)?
    if shiftable, let web, let page {
      guard let placed = capture.page.placed(web) else { return }
      let drawing = GlassSteps.page(placed.image, in: placed.rect, across: web.bounds, transform: page.transform)
      wanted = wanted.intersection(drawing.drawn)
      guard !wanted.isNull, !wanted.isEmpty else { return }
      pageOnly = drawing
      need = GlassFlowRules.captureNeed(footprint: strip, velocity: capture.page.velocity)
    } else {
      wanted = sourceWhole && web != nil ? near : wanted
    }
    guard capture.wants(wanted, need: need, now: now, gap: sourceWhole && web == nil ? LiquidGlassRules.backdropRefresh : 0) else { return }
    if !shiftable, let web, let page, !capture.page.covers(wanted.applying(page.transform.inverted()), of: web) { return }
    if let pageOnly {
      let outcome: GlassCapture.Outcome
      if GlassLaunch.offMain {
        outcome = capture.start(rect: wanted, pixelsPerPoint: pixelsPerPoint, now: now, steps: pageOnly.steps, follow: web)
      } else {
        outcome = capture.capture(rect: wanted, pixelsPerPoint: pixelsPerPoint, sigma: sigma, blurs: &blurs, now: now) { context in
          pageOnly.steps.draw(in: context)
          return true
        }
        if outcome == .captured { capture.follow(web) }
      }
      mark("page")
      if outcome != .waiting { capturedNow = true }
      if outcome == .captured || outcome == .failed { finish(outcome, capture: capture, members: members, pieces: 1, sourceWhole: sourceWhole, page: true) }
      return
    }
    let pieceMethod: GlassLaunch.Capture = method == .auto ? (sourceWhole && web == nil ? capture.wholeMethod : .layer) : method
    if GlassLaunch.offMain, pieceMethod == .layer, !pieces.isEmpty {
      let made = GlassSteps.make(pieces, page: capture.page, pixelsPerPoint: pixelsPerPoint)
      if made == nil, PhoneTestBuild.isOn { NSLog("PAGELAB look glass copy refused for %@: %@", members.map(\.label).joined(separator: ","), GlassLayerCopy.refused) }
      if let steps = made {
        mark("copy\(steps.layers)")
        if GlassLaunch.copyProbe { GlassCopyProbe.arm(capture, pieces: pieces, rect: wanted, pixelsPerPoint: pixelsPerPoint) }
        let outcome = capture.start(rect: wanted, pixelsPerPoint: pixelsPerPoint, now: now, steps: steps, follow: shiftable ? web : nil)
        if outcome == .started { capturedNow = true }
        if outcome == .failed { finish(.failed, capture: capture, members: members, pieces: pieces.count, sourceWhole: sourceWhole, page: web != nil) }
        return
      }
    }
    let outcome = capture.capture(rect: wanted, pixelsPerPoint: pixelsPerPoint, sigma: sigma, blurs: &blurs, now: now) { context in
      guard method != .none, !pieces.isEmpty else { return false }
      var drew = true
      for piece in pieces {
        let pieceStarted = CACurrentMediaTime()
        if !GlassBackdrop.draw(piece, method: pieceMethod, page: capture.page, in: context) { drew = false }
        let pieceMs = (CACurrentMediaTime() - pieceStarted) * 1000
        if PhoneTestBuild.isOn, pieceMs > 2 { marks.append("\(piece.page != nil ? "page" : piece.view.map { String(describing: type(of: $0)) } ?? "fill")=\(String(format: "%.1f", pieceMs))") }
      }
      return drew
    }
    mark("capture")
    if outcome == .captured || outcome == .failed { capturedNow = true }
    if outcome == .captured { capture.follow(shiftable ? web : nil) }
    finish(outcome, capture: capture, members: members, pieces: pieces.count, sourceWhole: sourceWhole, page: web != nil)
  }

  private func finish(_ outcome: GlassCapture.Outcome, capture: GlassCapture, members: [LiquidGlassSurface], pieces: Int, sourceWhole: Bool, page: Bool) {
    switch outcome {
    case .captured:
      if PhoneTestBuild.isOn {
        let timing = capture.lastTiming
        stats.noteCapture(ms: timing.offMain ? nil : timing.ms, pieces: pieces)
        if timing.offMain { stats.offMainMs.append(timing.ms) }
        stats.snapshotMs += capture.page.takeLatencies()
        let counts = capture.page.takeCounts()
        stats.rejected += counts.rejected
        stats.uncovered += counts.uncovered
        stats.moving += counts.moving
      }
    case .failed:
      if GlassLaunch.capture == .auto, sourceWhole, !page, capture.wholeMethod == .layer {
        capture.wholeMethod = .hierarchy
        if PhoneTestBuild.isOn { NSLog("PAGELAB look glass %@ backdrop is blank to the layer tree; drawing its view hierarchy instead", members.map(\.label).joined(separator: ",")) }
      }
      if PhoneTestBuild.isOn {
        stats.failed += 1
        if capture.failures == 1 { NSLog("PAGELAB look glass capture failed: %@ shows clear glass and tries again", members.map(\.label).joined(separator: ",")) }
      }
    case .started, .waiting:
      break
    }
  }

  struct FrameStats {
    var frames = 0
    var late = 0
    var dropped = 0
    var failed = 0
    var rejected = 0
    var uncovered = 0
    var moving = 0
    var lensFrames = 0
    var clearFrames = 0
    var clearReasons: [String: Int] = [:]
    var unshifted: [String: Int] = [:]
    var toneFlips = 0
    var heldFrames = 0
    var offMainMs: [Double] = []
    var mainMs: [Double] = []
    var worstInterval = 0.0
    var captures = 0
    var pieces = 0
    var captureMs: [Double] = []
    var snapshotMs: [Double] = []
    var tickMs: [Double] = []
    var since: CFTimeInterval = 0

    mutating func note(interval: CFTimeInterval, target: CFTimeInterval) {
      frames += 1
      if interval > target * 1.5 { late += 1 }
      worstInterval = max(worstInterval, interval)
    }

    mutating func noteCapture(ms: Double?, pieces: Int) {
      captures += 1
      self.pieces += pieces
      if let ms { captureMs.append(ms) }
    }

    mutating func noteTick(ms: Double) {
      tickMs.append(ms)
    }

    mutating func report(now: CFTimeInterval, surfaces: Int) -> String? {
      if since == 0 { since = now }
      guard now - since >= 1, frames > 0 else { return nil }
      func fixed(_ value: Double) -> String { String(format: "%.2f", value) }
      let line = "PAGELAB glass frames method=\(GlassLaunch.capture.rawValue) surfaces=\(surfaces) frames=\(frames) late=\(late) dropped=\(dropped) worst_frame_ms=\(fixed(worstInterval * 1000)) captures=\(captures) failed=\(failed) rejected=\(rejected) uncovered=\(uncovered) moving_snapshots=\(moving)  lens_frames=\(lensFrames) clear_frames=\(clearFrames) tone_flips=\(toneFlips) held_frames=\(heldFrames) unshifted=\(unshifted.map { "\($0.key):\($0.value)" }.joined(separator: ",")) clear_why=\(clearReasons.sorted { $0.value > $1.value }.prefix(3).map { "\($0.key):\($0.value)" }.joined(separator: ",")) off_main_ms_p50=\(fixed(LiquidGlassRules.median(offMainMs))) off_main_ms_max=\(fixed(offMainMs.max() ?? 0)) main_ms_p50=\(fixed(LiquidGlassRules.median(mainMs))) main_ms_max=\(fixed(mainMs.max() ?? 0)) snapshots=\(snapshotMs.count) snapshot_ms_p50=\(fixed(LiquidGlassRules.median(snapshotMs))) pieces_avg=\(fixed(captures > 0 ? Double(pieces) / Double(captures) : 0)) capture_ms_p50=\(fixed(LiquidGlassRules.median(captureMs))) capture_ms_max=\(fixed(captureMs.max() ?? 0)) tick_ms_p50=\(fixed(LiquidGlassRules.median(tickMs))) tick_ms_max=\(fixed(tickMs.max() ?? 0))"
      self = FrameStats()
      since = now
      return line
    }
  }
}

final class GlassCooldownBox {
  var cooldown = GlassBudgetCooldown()
}

enum GlassTone {
  static let changed = Notification.Name("ArdiaGlassToneChanged")
  static let darkKey = "dark"
}
