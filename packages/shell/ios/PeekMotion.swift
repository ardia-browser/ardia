import QuartzCore

final class PeekMotion {
  enum Phase: String { case idle, waiting, entering, open, gesture, settling, closing, promoting, finished }
  enum Entrance: String { case genie, affine, fade }
  enum Outcome: String { case closed, promoted }
  enum PinchOutcome: String { case open, close, stay }

  static let openAt = 0.3
  static let closeAt = -0.25
  static let spreadToTab = 0.4
  static let fullAt = 1.2
  static var promoted: Double { spreadToTab * fullAt }
  static let readyTimeout = 0.15
  static let fadeSeconds = 0.15
  static let rows = 36
  static let columns = 4
  static let genieResponse = 0.2
  static let genieCloseResponse = 0.17
  static let scrimResponse = 0.26
  static let restWithin = 1.0
  static let neckWidth = 0.12
  static let bottomLinkStagger = 0.75
  static let closeFadeSpan = 0.4
  static let startScale = 0.12
  static let smallestScale = 0.5

  private(set) var phase = Phase.idle
  private(set) var generation = 0
  private(set) var entrance = Entrance.genie
  private(set) var interrupted = false
  private(set) var readyTimedOut = false
  private(set) var geometry = PeekGeometry.empty
  var reduce = false
  var canWarp = true
  var slow = 1.0
  private var animatedEntrance = true

  private var m = PeekSpring(value: 0, response: 0.2)
  private var presence = PeekSpring(value: 1, response: 0.26)
  private var warp = PeekSpring(value: 0, response: 0.22)
  private var residual: [CGPoint] = []
  private var alphaResidual = 0.0
  private var scrimResidual = 0.0
  private var fade = (from: 1.0, to: 1.0, start: 0.0)
  private var genieStart = 0.0
  private var closeStart = 0.0
  private var closeCard = PeekAffine.identity
  private var closeFrom: [CGPoint] = []
  private var closeOffsets: [CGPoint] = []
  private var closeAlpha = 1.0
  private var closeScrim = 1.0
  private var closeChrome = 1.0
  private var committed: PeekFrame?
  private var committedAt = 0.0
  private var waitingSince = 0.0
  private var gestureBase = 0.0
  private var gestureSample = (t: 0.0, m: 0.0)
  private var outcome: Outcome?
  private var reported = false
  private var clock = 0.0

  var animating: Bool { [.waiting, .entering, .gesture, .settling, .closing, .promoting].contains(phase) }
  var terminal: Bool { [.idle, .closing, .promoting, .finished].contains(phase) }
  var warpingEntrance: Bool { phase == .entering && entrance == .genie }
  var warpingClose: Bool { phase == .closing && !closeFrom.isEmpty }
  var lastCommitAt: Double { committedAt }

  func commit(_ frame: PeekFrame, at now: Double) {
    committed = frame
    committedAt = now
  }
  var expansion: Double { m.value }

  func begin(_ generation: Int, at now: Double, animated: Bool = true) -> Bool {
    guard generation > self.generation else { return false }
    self.generation = generation
    animatedEntrance = animated
    phase = .waiting
    entrance = reduce ? .fade : .genie
    interrupted = false
    readyTimedOut = false
    m.jump(0)
    presence.jump(1)
    warp.jump(0)
    clearResidual()
    fade = (1, 1, now)
    outcome = nil
    reported = false
    committed = nil
    closeFrom = []
    closeOffsets = []
    waitingSince = now
    clock = now
    return true
  }

  func setGeometry(_ next: PeekGeometry, at now: Double) {
    guard next != geometry else { return }
    let first = !geometry.valid
    geometry = next
    if first { return }
    switch phase {
    case .entering, .gesture, .settling: snapOpen(at: now)
    case .closing: finish(.closed)
    case .promoting: finish(.promoted)
    default: break
    }
  }

  func markReady(at now: Double) {
    if phase == .waiting, geometry.valid { startEntrance(at: now) }
  }

  func fallBack(at now: Double) {
    guard warpingEntrance else { return }
    entrance = .affine
    presence.jump(0)
    presence.aim(1, response: 0.26)
    genieStart = now
  }

  func settleEntrance(at now: Double) -> Bool {
    guard phase == .waiting || phase == .entering, geometry.valid else { return false }
    clock = now
    interrupted = true
    snapOpen(at: now)
    return true
  }

  func cancel() {
    phase = .finished
    outcome = nil
    reported = true
  }

  func takeOutcome() -> Outcome? {
    guard !reported, let outcome else { return nil }
    reported = true
    return outcome
  }

  func close(at now: Double) -> Bool {
    if terminal { return false }
    clock = now
    if phase == .waiting {
      finish(.closed)
      return true
    }
    let shown = committed
    freeze(at: now)
    phase = .closing
    if reduce {
      fade = (fadeValue(now), 0, now)
    } else if canWarp, let shown, geometry.valid, !geometry.fullscreen {
      startGenieClose(from: shown, at: clock)
    } else {
      presence.aim(0, response: 0.2)
      m.aim(min(m.value, 0), response: 0.2)
    }
    return true
  }

  func promote(at now: Double) -> Bool {
    if terminal { return false }
    clock = now
    if phase == .waiting {
      entrance = .affine
      presence.jump(reduce ? 1 : 0)
    }
    freeze(at: now)
    phase = .promoting
    if reduce {
      m.jump(Self.promoted)
      presence.jump(1)
      warp.jump(0)
      clearResidual()
      fade = (1, 1, now)
    } else {
      m.aim(Self.promoted, response: 0.22)
      presence.aim(1, response: 0.22)
    }
    return true
  }

  func gestureBegan(at now: Double) -> Bool {
    switch phase {
    case .entering:
      clock = now
      freeze(at: now)
    case .open, .settling:
      clock = now
    case .gesture: break
    default: return false
    }
    phase = .gesture
    gestureBase = m.value
    m.aim(m.value)
    m.velocity = 0
    gestureSample = (now, m.value)
    return true
  }

  func gestureChanged(_ total: Double, at now: Double) {
    guard phase == .gesture, !reduce else { return }
    let value = min(max(gestureBase + total, -1), 1.2)
    let dt = now - gestureSample.t
    if dt > 0.001 { m.velocity = 0.6 * m.velocity + 0.4 * (value - gestureSample.m) / dt }
    m.value = value
    m.target = value
    gestureSample = (now, value)
  }

  func gestureEnded(_ total: Double, cancelled: Bool, at now: Double) -> PinchOutcome {
    guard phase == .gesture else { return .stay }
    let value = gestureBase + total
    let result: PinchOutcome = cancelled ? .stay : value >= Self.openAt ? .open : value <= Self.closeAt ? .close : .stay
    switch result {
    case .open: _ = promote(at: now)
    case .close: _ = close(at: now)
    case .stay:
      phase = .settling
      m.aim(0, response: 0.2)
    }
    return result
  }

  func advance(to now: Double) {
    let dt = max(0, now - clock)
    clock = now
    switch phase {
    case .waiting:
      if geometry.valid, now - waitingSince >= Self.readyTimeout {
        readyTimedOut = true
        startEntrance(at: now)
      }
    case .entering:
      switch entrance {
      case .genie: if genieSettled(at: now - genieStart, opening: true) { snapOpen(at: now) }
      case .affine:
        presence.step(dt)
        if presence.settled(within: 1e-3) { snapOpen(at: now) }
      case .fade: if fadeValue(now) >= 1 { snapOpen(at: now) }
      }
    case .gesture:
      warp.step(dt)
      presence.step(dt)
    case .settling:
      warp.step(dt)
      presence.step(dt)
      m.step(dt)
      if m.settled(within: 5e-4), warp.settled(within: 1e-3), presence.settled(within: 1e-3) { snapOpen(at: now) }
    case .closing:
      if warpingClose {
        if genieSettled(at: now - closeStart, opening: false) { finish(.closed) }
      } else {
        warp.step(dt)
        m.step(dt)
        presence.step(dt)
        if reduce ? fadeValue(now) <= 0 : presence.value <= 0.02 { finish(.closed) }
      }
    case .promoting:
      if reduce {
        if now - fade.start >= Self.fadeSeconds { finish(.promoted) }
      } else {
        warp.step(dt)
        m.step(dt)
        presence.step(dt)
        if m.settled(within: 4e-4), presence.settled(within: 1e-3), warp.settled(within: 1e-3) {
          m.jump(Self.promoted)
          presence.jump(1)
          warp.jump(0)
          clearResidual()
          finish(.promoted)
        }
      }
    default: break
    }
    if warp.target == 0, abs(warp.value) < 1e-4, !residual.isEmpty {
      warp.jump(0)
      clearResidual()
    }
  }

  func frame(at now: Double) -> PeekFrame {
    var f = PeekFrame()
    let g = geometry
    guard g.valid else { return f }
    let base = PeekAffine.mapping(g.page, to: g.rest)
    if g.fullscreen || (phase == .finished && outcome == .promoted) {
      f.cardAlpha = 1
      f.chromeAlpha = 0
      f.topRadius = g.fullscreen ? 0 : g.tabTopRadius
      f.bottomRadius = g.fullscreen ? 0 : g.tabBottomRadius
      f.shownPage = g.page
      return f
    }
    f.topRadius = g.restRadius
    f.bottomRadius = g.restRadius
    if phase == .waiting || phase == .idle || (phase == .finished && outcome != .promoted) {
      f.page = base
      f.shownPage = g.rest
      return f
    }
    if warpingClose {
      let t = now - closeStart
      let shrink = closeCard.apply(g.card)
      f.card = closeCard
      f.page = base.then(closeCard)
      f.shownPage = f.page.apply(g.page)
      f.from = closeFrom
      let rows = rowAways(card: shrink, at: t, opening: false)
      let funnel = genieGrid(card: shrink, aways: rows)
      let stride = Self.columns + 1
      f.to = funnel.indices.map { i in
        let keep = 1 - rows[i / stride], o = closeOffsets[i]
        return CGPoint(x: funnel[i].x + o.x * keep, y: funnel[i].y + o.y * keep)
      }
      f.cardAlpha = closeAlpha * Self.smooth((1 - (rows.min() ?? 1)) / Self.closeFadeSpan)
      f.scrimAlpha = closeScrim * PeekSpring.remaining(t, response: Self.scrimResponse * slow)
      f.chromeAlpha = closeChrome
      f.residual = 1
      return f
    }
    if warpingEntrance {
      let t = now - genieStart
      f.page = base
      f.from = restGrid()
      f.to = genieGrid(card: g.card, aways: rowAways(card: g.card, at: t, opening: true))
      f.cardAlpha = 1
      f.scrimAlpha = 1 - PeekSpring.remaining(t, response: Self.scrimResponse * slow)
      f.residual = 1
      f.shownPage = g.rest
      return f
    }
    let mv = m.value
    let e = mv >= 0 ? Self.rubber(mv / Self.spreadToTab) : 0
    let expand: PeekAffine = mv >= 0 ? .mapping(g.rest, to: Self.lerp(g.rest, g.page, e)) : .scale(max(Self.smallestScale, 1 + mv), about: Self.center(g.card))
    let a = presence.value
    let cs = Self.center(g.card), ss = Self.center(g.source)
    let gs = Self.lerp(Self.startScale, 1, a)
    let to = CGPoint(x: Self.lerp(ss.x, cs.x, a), y: Self.lerp(ss.y, cs.y, a))
    let card = expand.then(PeekAffine(s: gs, tx: to.x - gs * cs.x, ty: to.y - gs * cs.y))
    f.card = card
    f.page = base.then(card)
    f.shownPage = f.page.apply(g.page)
    let ec = Self.unit(e)
    let presenceAlpha = a < 0.35 ? max(0, a) / 0.35 : 1
    let pinchAlpha = mv < 0 ? Self.unit(1 + 1.6 * mv) : 1
    let fv = fadeValue(now)
    f.cardAlpha = Self.unit(presenceAlpha * pinchAlpha * fv + alphaResidual * warp.value)
    f.chromeAlpha = Self.unit(1 - 1.6 * ec)
    f.scrimAlpha = Self.unit(Self.unit(a) * (mv >= 0 ? 1 - ec : Self.unit(1 + 2 * mv)) * fv + scrimResidual * warp.value)
    if reduce && phase == .promoting {
      let p = Self.unit((now - fade.start) / Self.fadeSeconds)
      f.cardAlpha = 1
      f.chromeAlpha = 0
      f.scrimAlpha = 1 - p
    }
    f.topRadius = Self.lerp(g.restRadius, g.tabTopRadius, ec)
    f.bottomRadius = Self.lerp(g.restRadius, g.tabBottomRadius, ec)
    if warp.value > 1e-4, residual.count == (Self.rows + 1) * (Self.columns + 1) {
      let rest = restGrid()
      let w = warp.value
      f.from = rest.map(card.apply)
      f.to = zip(rest, residual).map { card.apply(CGPoint(x: $0.x + $1.x * w, y: $0.y + $1.y * w)) }
      f.residual = w
    }
    return f
  }

  private func startEntrance(at now: Double) {
    guard animatedEntrance else { return snapOpen(at: now) }
    phase = .entering
    if reduce {
      entrance = .fade
      fade = (0, 1, now)
    } else if canWarp, geometry.valid, !geometry.fullscreen {
      entrance = .genie
      genieStart = now
    } else {
      entrance = .affine
      presence.jump(0)
      presence.aim(1, response: 0.26)
    }
  }

  private func freeze(at now: Double) {
    guard phase == .entering else { return }
    interrupted = true
    guard entrance == .genie else { return }
    let at = committed != nil ? committedAt : now
    let t = at - genieStart
    let rest = restGrid()
    let shown = committed.flatMap { $0.to.count == rest.count ? $0 : nil }
    let aways = rowAways(card: geometry.card, at: t, opening: true)
    residual = zip(shown?.to ?? genieGrid(card: geometry.card, aways: aways), rest).map { CGPoint(x: $0.x - $1.x, y: $0.y - $1.y) }
    alphaResidual = (shown?.cardAlpha ?? 1) - 1
    scrimResidual = (shown?.scrimAlpha ?? 1 - PeekSpring.remaining(t, response: Self.scrimResponse * slow)) - 1
    clock = at
    let step = 1.0 / 240
    let earlier = rowAways(card: geometry.card, at: max(0, t - step), opening: true)
    let total = aways.reduce(0, +)
    let rate = total > 1e-6 ? (total - earlier.reduce(0, +)) / step / total : 0
    warp.jump(1)
    warp.velocity = rate
    warp.aim(0, response: 0.22)
    entrance = .affine
    presence.jump(1)
  }

  private func startGenieClose(from shown: PeekFrame, at now: Double) {
    let rest = restGrid()
    let card = shown.card
    closeCard = card
    closeFrom = rest.map(card.apply)
    let presented = shown.to.count == rest.count ? shown.to : closeFrom
    closeOffsets = zip(presented, closeFrom).map { CGPoint(x: $0.x - $1.x, y: $0.y - $1.y) }
    closeAlpha = shown.cardAlpha
    closeScrim = shown.scrimAlpha
    closeChrome = shown.chromeAlpha
    closeStart = now
    warp.jump(0)
    clearResidual()
  }

  private func target(for c: CGRect) -> CGRect {
    let s = geometry.source
    let w = max(s.width, c.width * Self.neckWidth)
    return CGRect(x: s.midX - w / 2, y: s.minY, width: w, height: s.height)
  }

  static func rowResponse(row k: Double, stagger g: Double, base: Double) -> Double {
    let up = 1 - k
    let n = g < 0 ? 1 - (1 - up).squareRoot() : up.squareRoot()
    return base * (1 - 0.5 * g + g * n)
  }

  static func stagger(card c: CGRect, source s: CGRect) -> Double {
    let lift = 1 - 2 * unit((s.midY - c.minY) / max(c.height, 1))
    return lift >= 0 ? lift : bottomLinkStagger * lift
  }

  private func rowAways(card c: CGRect, at t: Double, opening: Bool) -> [Double] {
    let g = Self.stagger(card: c, source: geometry.source) * (opening ? 1 : -1)
    return (0...Self.rows).map { r in
      let left = PeekSpring.remaining(t, response: Self.rowResponse(row: Double(r) / Double(Self.rows), stagger: g, base: (opening ? Self.genieResponse : Self.genieCloseResponse) * slow))
      return opening ? left : 1 - left
    }
  }

  private func genieSettled(at t: Double, opening: Bool) -> Bool {
    let c = geometry.card
    let rows = rowAways(card: c, at: t, opening: opening)
    let span = max(c.width, c.height, 1)
    return opening ? (rows.max() ?? 0) * span <= Self.restWithin : (1 - (rows.min() ?? 1)) * span <= Self.restWithin
  }

  private func genieGrid(card c: CGRect, aways: [Double]) -> [CGPoint] {
    let t = target(for: c)
    var ys = aways.indices.map { r in
      let k = Double(r) / Double(Self.rows)
      return Self.lerp(c.minY + k * c.height, t.minY + k * t.height, aways[r])
    }
    for r in ys.indices.dropFirst() { ys[r] = max(ys[r], ys[r - 1]) }
    return Self.grid { k, j in
      let r = Int((k * Double(Self.rows)).rounded())
      return CGPoint(x: Self.lerp(c.minX + j * c.width, t.minX + j * t.width, aways[r]), y: ys[r])
    }
  }

  static func smooth(_ v: Double) -> Double { let x = unit(v); return x * x * (3 - 2 * x) }

  private func snapOpen(at now: Double) {
    phase = .open
    m.jump(0)
    presence.jump(1)
    warp.jump(0)
    clearResidual()
    fade = (1, 1, now)
  }

  private func finish(_ result: Outcome) {
    phase = .finished
    outcome = result
  }

  private func clearResidual() {
    residual = []
    alphaResidual = 0
    scrimResidual = 0
  }

  private func fadeValue(_ now: Double) -> Double {
    let p = Self.unit((now - fade.start) / Self.fadeSeconds)
    return Self.lerp(fade.from, fade.to, p)
  }

  private func restGrid() -> [CGPoint] {
    let c = geometry.card
    return Self.grid { k, j in CGPoint(x: c.minX + j * c.width, y: c.minY + k * c.height) }
  }

  private static func grid(_ point: (Double, Double) -> CGPoint) -> [CGPoint] {
    var points: [CGPoint] = []
    points.reserveCapacity((rows + 1) * (columns + 1))
    for k in 0...rows {
      for j in 0...columns { points.append(point(Double(k) / Double(rows), Double(j) / Double(columns))) }
    }
    return points
  }

  static func rubber(_ e: Double) -> Double {
    let knee = 2 - fullAt
    if e <= knee { return e }
    let u = unit((e - knee) / (2 * (fullAt - 1)))
    return knee + (1 - knee) * (2 * u - u * u)
  }
  static func unit(_ v: Double) -> Double { min(max(v, 0), 1) }
  static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
  static func center(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }
  static func lerp(_ a: CGRect, _ b: CGRect, _ t: Double) -> CGRect {
    CGRect(x: lerp(a.minX, b.minX, t), y: lerp(a.minY, b.minY, t), width: lerp(a.width, b.width, t), height: lerp(a.height, b.height, t))
  }
}
