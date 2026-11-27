import ArdiaDesign
import Foundation
import Metal
import Testing

struct LiquidGlassTests {
  private static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../..").standardizedFileURL

  private static func android(_ path: String) throws -> String {
    try String(contentsOf: repo.appendingPathComponent(path), encoding: .utf8)
  }

  private static func number(_ name: String, in text: String) -> Double? {
    guard let range = text.range(of: "\(name) = ") else { return nil }
    let rest = text[range.upperBound...]
    let digits = rest.prefix { "-0123456789.".contains($0) }
    return Double(digits)
  }

  private static func block(_ start: String, in text: String) -> String {
    guard let range = text.range(of: start) else { return "" }
    let lines = text[range.upperBound...].components(separatedBy: "\n")
    return lines.prefix { $0.trimmingCharacters(in: .whitespaces) != ")" }.joined(separator: "\n")
  }

  @Test func `the parameters are Android's, read from its source`() throws {
    let kotlin = try Self.android("packages/phone/android/src/main/java/com/ardia/phone/LiquidGlass.kt")
    let defaults = Self.block("val defaults = Params(", in: kotlin)
    let params = LiquidGlassParams.defaults
    let pairs: [(String, Double)] = [
      ("ior", params.ior), ("dispersion", params.dispersion), ("bezelDp", params.bezel), ("depthDp", params.depth),
      ("maxSlope", params.maxSlope), ("specularWidthDp", params.specularWidth), ("specularStrength", params.specularStrength),
      ("oppositeStrength", params.oppositeStrength), ("specularFalloff", params.specularFalloff),
      ("specularSharpness", params.specularSharpness), ("specularOpacity", params.specularOpacity),
    ]
    for (name, value) in pairs {
      let theirs = try #require(Self.number(name, in: defaults), "\(name) is missing from LiquidGlass.kt")
      #expect(abs(theirs - value) < 1e-9, "\(name): Android \(theirs), iPhone \(value)")
    }
    #expect(defaults.contains("lightAngle = (-Math.PI / 4).toFloat()"))
    #expect(params.lightAngle == -Double.pi / 4)
    #expect(Self.number("const val DARK_RIM_SHARE", in: kotlin) == LiquidGlassRules.darkRimShare)
    #expect(Self.number("const val BEZEL_SHARE_OF_SHORT_SIDE", in: kotlin) == LiquidGlassRules.bezelShareOfShortSide)
    #expect(Self.number("const val EDGE_FEATHER_PX", in: kotlin) == LiquidGlassRules.edgeFeatherPixels)
    #expect(Self.number("const val CIRCULAR_CORNER_EXPONENT", in: kotlin) == LiquidGlassRules.circularCornerExponent)
  }

  @Test func `the frost under the glass is Android's glass frost`() throws {
    let kotlin = try Self.android("apps/phone/android/ardia-design/src/main/java/com/ardia/design/FrostedStyle.kt")
    let glass = Self.block("val glass = FrostedStyle(", in: kotlin)
    let style = GlassFrostStyle.glass
    #expect(glass.contains("blurRadius = \(Int(style.blur)).dp"))
    #expect(Self.number("saturation", in: glass) == style.saturation)
    func ink(_ match: Regex<(Substring, Substring?, Substring?, Substring?, Substring?)>.Match) -> GlassInk? {
      if let hex = match.output.1.flatMap({ UInt32($0, radix: 16) }), let alpha = match.output.2.flatMap({ Double($0) }) { return GlassInk(hex: hex, alpha: alpha) }
      guard let named = match.output.3, let alpha = match.output.4.flatMap({ Double($0) }) else { return nil }
      return GlassInk(hex: named == "White" ? 0xFFFFFF : 0x000000, alpha: alpha)
    }
    func pair(_ name: String) throws -> (light: GlassInk, dark: GlassInk) {
      let range = try #require(glass.range(of: "\(name) = adaptive("))
      let line = String(glass[range.upperBound...].prefix { $0 != "\n" })
      let inks = line.matches(of: /ardiaColor\(0x([0-9A-Fa-f]{6}), ([0-9.]+)f\)|Color\.(Black|White)\.copy\(alpha = ([0-9.]+)f\)/).compactMap(ink)
      try #require(inks.count == 2)
      return (inks[0], inks[1])
    }
    for (name, light, dark) in [("tint", style.tint(dark: false), style.tint(dark: true)), ("fallback", style.fallback(dark: false), style.fallback(dark: true)), ("edge", style.edge(dark: false), style.edge(dark: true))] {
      let android = try pair(name)
      #expect(android.light == light, "\(name) in light")
      #expect(android.dark == dark, "\(name) in dark")
    }
    #expect(style.opaqueFallback(dark: true) == GlassInk(hex: 0x3A3A3C, alpha: 1), "Reduce Transparency keeps the fallback's colour, opaque")
    #expect(style.edgeWidth == 0.5)
  }

  @Test func `the profile rises from the edge to flat`() {
    #expect(abs(LiquidGlassRules.profile(0) - 0.01) < 1e-9)
    #expect(LiquidGlassRules.profile(1) == 1)
    #expect(LiquidGlassRules.profile(0.5) > LiquidGlassRules.profile(0.25))
    #expect(LiquidGlassRules.profile(-1) == LiquidGlassRules.profile(0))
    #expect(LiquidGlassRules.slope(1, maxSlope: 5.67) == 0)
    #expect(LiquidGlassRules.slope(0, maxSlope: 5.67) == 5.67)
    #expect(LiquidGlassRules.slope(0.5, maxSlope: 5.67) < LiquidGlassRules.slope(0.1, maxSlope: 5.67))
  }

  @Test func `the bezel is 14 points, at most 30 percent of the shorter side`() {
    #expect(LiquidGlassRules.bezel(width: 300, height: 52) == 14)
    #expect(abs(LiquidGlassRules.bezel(width: 300, height: 40) - 12) < 1e-9)
    #expect(LiquidGlassRules.bezel(width: 0, height: 40) == 0)
    #expect(LiquidGlassRules.bezel(width: -5, height: 40) == 0)
  }

  @Test func `the largest shift is about 11 points for a 14 point bezel, and none for a flat glass`() {
    let shift = LiquidGlassRules.maxShift(bezel: 14)
    #expect(abs(shift - 11.448) < 0.01)
    #expect(LiquidGlassRules.shiftRatio(slope: 0, ior: 1.5) == 0)
    #expect(LiquidGlassRules.shiftRatio(slope: 1, ior: 1.5) > 0)
    #expect(LiquidGlassRules.shiftRatio(slope: 1, ior: 1.54) > LiquidGlassRules.shiftRatio(slope: 1, ior: 1.46))
    var bound = LiquidGlassBound()
    bound.measure(width: 300, height: 52)
    bound.measure(width: 300, height: 52)
    #expect(bound.computed == 1)
    #expect(abs(bound.shift - shift) < 1e-9)
    bound.measure(width: 48, height: 48)
    #expect(bound.computed == 2)
  }

  @Test func `the capture holds the blur and the shift, at a sixth of the pixels for the glass frost`() {
    #expect(LiquidGlassRules.marginPixels(blurPixels: 36, shiftPixels: 24) == 72)
    #expect(LiquidGlassRules.marginPixels(blurPixels: 2, shiftPixels: 24.2) == 26)
    #expect(LiquidGlassRules.frostScale(blurPixels: 36) == 6)
    #expect(LiquidGlassRules.frostScale(blurPixels: 3) == 1)
    #expect(LiquidGlassRules.frostScale(blurPixels: 200) == 8)
    #expect(LiquidGlassRules.blurSigma(radius: 0) == 0)
    #expect(abs(LiquidGlassRules.blurSigma(radius: 6) - 3.9641) < 1e-3)
  }

  @Test func `a live glass that shows clear glass for over three seconds is counted once per stretch, and a page loading is not`() {
    var withheld = LiquidGlassRules.LensWithheld()
    let frame = 1.0 / 60
    var counts = 0
    var now = 0.0
    while now < 2.9 {
      if withheld.note(path: .live, showsLens: false, now: now) { counts += 1 }
      now += frame
    }
    #expect(counts == 0, "the bar waits about a second and a quarter for a new page's first picture")
    while now < 6 {
      if withheld.note(path: .live, showsLens: false, now: now) { counts += 1 }
      now += frame
    }
    #expect(counts == 1)
    let shown = withheld.note(path: .live, showsLens: true, now: now)
    #expect(!shown)
    now += frame
    var early = 0
    for _ in 0..<30 {
      if withheld.note(path: .live, showsLens: false, now: now) { early += 1 }
      now += frame
    }
    #expect(early == 0)
    now += 2
    let afterGap = withheld.note(path: .live, showsLens: false, now: now)
    #expect(!afterGap, "a glass seen again after a gap starts a new stretch")
    var again = 0
    for _ in 0..<200 {
      now += frame
      if withheld.note(path: .live, showsLens: false, now: now) { again += 1 }
    }
    #expect(again == 1)
    var cooling = LiquidGlassRules.LensWithheld()
    let first = cooling.note(path: .clear, showsLens: false, now: 0)
    let later = cooling.note(path: .clear, showsLens: false, now: 5)
    #expect(!first && !later, "over-budget glass is counted by glass_captures_over_budget instead")
  }

  @Test func `glass behind an Incognito page is never counted, and privacy or consent changing starts the stretch again`() {
    let frame = 1.0 / 60
    var privateGlass = LiquidGlassRules.LensWithheld()
    var counted = 0
    var now = 0.0
    while now < 6 {
      if privateGlass.note(path: .live, showsLens: false, now: now, privately: true) { counted += 1 }
      now += frame
    }
    #expect(counted == 0)
    var leftPrivate = 0
    while now < 8.5 {
      if privateGlass.note(path: .live, showsLens: false, now: now, privately: false) { leftPrivate += 1 }
      now += frame
    }
    #expect(leftPrivate == 0, "clear glass seen while private doesn't carry over once the page is no longer private")
    var consent = LiquidGlassRules.LensWithheld()
    var beforeSharing = 0
    now = 0
    while now < 2.5 {
      if consent.note(path: .live, showsLens: false, now: now, consentWindow: nil) { beforeSharing += 1 }
      now += frame
    }
    var afterSharing = 0
    while now < 5 {
      if consent.note(path: .live, showsLens: false, now: now, consentWindow: 1) { afterSharing += 1 }
      now += frame
    }
    #expect(beforeSharing == 0 && afterSharing == 0, "time before sharing was turned on is not counted")
    #expect(!LiquidGlassRules.countsGlass(privately: true, consentWindow: 1))
    #expect(!LiquidGlassRules.countsGlass(privately: false, consentWindow: nil))
    #expect(LiquidGlassRules.countsGlass(privately: false, consentWindow: 1))
  }

  @Test func `a lens shown between frames starts the clear stretch again`() {
    let frame = 1.0 / 60
    var withheld = LiquidGlassRules.LensWithheld()
    var counted = 0
    var now = 0.0
    while now < 2 {
      if withheld.note(path: .live, showsLens: false, now: now) { counted += 1 }
      now += frame
    }
    withheld.lensShown()
    while now < 4.5 {
      if withheld.note(path: .live, showsLens: false, now: now) { counted += 1 }
      now += frame
    }
    #expect(counted == 0, "2 s and 2.5 s of clear glass either side of a lens are two short stretches, not one long one")
    while now < 5.2 {
      if withheld.note(path: .live, showsLens: false, now: now) { counted += 1 }
      now += frame
    }
    #expect(counted == 1)
  }

  @Test func `the shadow's fade settles whenever it is already where it is going`() {
    #expect(LiquidGlassRules.shadowFade(from: 1, to: 0, animated: true) == .fade(from: 1, to: 0))
    #expect(LiquidGlassRules.shadowFade(from: 1, to: 1, animated: true) == .settle, "a collapse undone before Core Animation draws must drop the collapse's fade, or the shadow fades out and jumps back")
    #expect(LiquidGlassRules.shadowFade(from: 0, to: 1, animated: false) == .settle)
  }

  @Test func `a count lands only in the consent window the frame sampled`() {
    #expect(LiquidGlassRules.countsIn(sampledWindow: 3, currentWindow: 3))
    #expect(!LiquidGlassRules.countsIn(sampledWindow: 3, currentWindow: 5), "sharing turned off and on again after the frame read it")
    #expect(!LiquidGlassRules.countsIn(sampledWindow: 3, currentWindow: nil), "sharing turned off after the frame read it")
    #expect(!LiquidGlassRules.countsIn(sampledWindow: nil, currentWindow: 4))
  }

  @Test func `an overlay drops its lens when the page under it goes missing, not when there was none`() {
    var presence = LiquidGlassRules.PagePresence()
    let firstPage = presence.note(present: true)
    let samePage = presence.note(present: true)
    let pageGone = presence.note(present: false)
    let stillGone = presence.note(present: false)
    let pageBack = presence.note(present: true)
    #expect(!firstPage && !samePage)
    #expect(pageGone, "a tab change whose new WebKit view is missing for a frame drops the old page's lens at once")
    #expect(!stillGone && !pageBack)
  }

  @Test func `private capture work can cool the glass down but never counts toward the budget telemetry`() {
    let frameMs = 1000.0 / 60
    let privateWork = (0..<10).map { LiquidGlassRules.CaptureSample(at: Double($0) * 0.2, ms: 40, privately: true) }
    let publicLight = (0..<10).map { LiquidGlassRules.CaptureSample(at: Double($0) * 0.2 + 0.1, ms: 0.5) }
    let afterSwitch = privateWork + publicLight
    #expect(LiquidGlassRules.overBudget(afterSwitch, now: 2, frameMs: frameMs), "the private work still cools the glass down")
    #expect(!LiquidGlassRules.overBudgetPublicly(afterSwitch, now: 2, frameMs: frameMs), "a private page's work, still landing after the switch to a public tab, isn't counted")
    let publicHeavy = (0..<10).map { LiquidGlassRules.CaptureSample(at: Double($0) * 0.2, ms: 40) }
    #expect(LiquidGlassRules.overBudgetPublicly(publicHeavy, now: 2, frameMs: frameMs))
    let privateDocument: [(start: TimeInterval, end: TimeInterval?, privately: Bool, consentWindow: Int?)] = [(start: 0.1, end: 1.9, privately: true, consentWindow: 0), (start: 1.9, end: 2.0, privately: false, consentWindow: 0)]
    #expect(GlassFlowRules.documentOverBudget(privateDocument.map { (start: $0.start, end: $0.end) }, now: 2))
    #expect(!GlassFlowRules.documentOverBudgetPublicly(privateDocument, now: 2, consentWindow: 0), "WebKit's PDF work for a private page stays out of the count")
  }

  @Test func `a capture started on the Incognito deck charges its landing to private work, not to the public frame it lands in`() {
    let frameMs = 1000.0 / 60
    let landingFrame = LiquidGlassRules.CaptureSample(at: 1.0, ms: 24, uncountedMs: 22)
    let slowPublicFrame = LiquidGlassRules.CaptureSample(at: 1.5, ms: 20)
    let frames = [landingFrame, slowPublicFrame]
    #expect(abs(landingFrame.publicMs - 2) < 1e-9)
    #expect(LiquidGlassRules.overBudget(frames, now: 1.6, frameMs: frameMs, strikes: LiquidGlassRules.backdropStrikes), "both frames were slow, so the glass still cools down")
    #expect(!LiquidGlassRules.overBudgetPublicly(frames, now: 1.6, frameMs: frameMs, strikes: LiquidGlassRules.backdropStrikes), "only one public frame was slow: the deck's two strikes aren't met by public work")
    let bothPublic = [LiquidGlassRules.CaptureSample(at: 1.0, ms: 24), slowPublicFrame]
    #expect(LiquidGlassRules.overBudgetPublicly(bothPublic, now: 1.6, frameMs: frameMs, strikes: LiquidGlassRules.backdropStrikes))
    #expect(LiquidGlassRules.CaptureSample(at: 0, ms: 10, privately: true).publicMs == 0)
    #expect(LiquidGlassRules.CaptureSample(at: 0, ms: 10, uncountedMs: 40).publicMs == 0)
  }

  @Test func `capture work from before sharing was turned back on cools the glass but isn't counted in the new consent window`() {
    let frameMs = 1000.0 / 60
    let before = (0..<10).map { LiquidGlassRules.CaptureSample(at: Double($0) * 0.2, ms: 40, consentWindow: 1) }
    let after = (0..<10).map { LiquidGlassRules.CaptureSample(at: Double($0) * 0.2 + 0.1, ms: 0.5, consentWindow: 2) }
    #expect(LiquidGlassRules.overBudget(before + after, now: 2, frameMs: frameMs))
    #expect(!LiquidGlassRules.overBudgetPublicly(before + after, now: 2, frameMs: frameMs, consentWindow: 2))
    #expect(LiquidGlassRules.overBudgetPublicly(before + after, now: 2, frameMs: frameMs, consentWindow: 1))
    #expect(!LiquidGlassRules.overBudgetPublicly(before, now: 2, frameMs: frameMs, consentWindow: nil), "nothing is counted while sharing is off")
    let offSamples = (0..<10).map { LiquidGlassRules.CaptureSample(at: Double($0) * 0.2, ms: 40, consentWindow: nil) }
    #expect(!LiquidGlassRules.overBudgetPublicly(offSamples, now: 2, frameMs: frameMs, consentWindow: 2), "work done while sharing was off isn't counted once it is on")
    let spans: [(start: TimeInterval, end: TimeInterval?, privately: Bool, consentWindow: Int?)] = [(start: 0.1, end: 1.9, privately: false, consentWindow: 1), (start: 1.9, end: 2.0, privately: false, consentWindow: 2)]
    #expect(!GlassFlowRules.documentOverBudgetPublicly(spans, now: 2, consentWindow: 2), "a WebKit PDF asked for in the old window isn't counted in the new one")
    #expect(GlassFlowRules.documentOverBudgetPublicly(spans, now: 2, consentWindow: 1))
  }

  @Test func `a lens that was private while it showed is never counted as bridged when it fades out on a public tab`() {
    var incognitoLens = LiquidGlassRules.ShownPrivacy()
    incognitoLens.shown(privately: true)
    #expect(!incognitoLens.countsWhenHidden(privatelyNow: false), "leaving Incognito: the lens fading is the Incognito page's")
    var publicLens = LiquidGlassRules.ShownPrivacy()
    publicLens.shown(privately: false)
    #expect(publicLens.countsWhenHidden(privatelyNow: false))
    #expect(!publicLens.countsWhenHidden(privatelyNow: true))
    var turnedPrivate = LiquidGlassRules.ShownPrivacy()
    turnedPrivate.shown(privately: false)
    turnedPrivate.seen(privately: true)
    turnedPrivate.seen(privately: false)
    #expect(!turnedPrivate.countsWhenHidden(privatelyNow: false), "a lens that showed a private page at any moment stays private until it shows again")
    turnedPrivate.shown(privately: false)
    #expect(turnedPrivate.countsWhenHidden(privatelyNow: false))
  }

  @Test func `the light comes from the top left and the rim is dimmer in dark`() {
    let light = LiquidGlassRules.light(LiquidGlassParams.defaults.lightAngle)
    #expect(light.x < 0 && light.y < 0)
    let topLeft = LiquidGlassRules.rimAlpha(normalAngle: 1.25 * Double.pi, dark: false)
    let bottomRight = LiquidGlassRules.rimAlpha(normalAngle: 0.25 * Double.pi, dark: false)
    let side = LiquidGlassRules.rimAlpha(normalAngle: 0.75 * Double.pi, dark: false)
    #expect(abs(topLeft - 0.5) < 1e-9)
    #expect(abs(bottomRight - 0.25) < 1e-9)
    #expect(side < 1e-9)
    let topEdge = LiquidGlassRules.rimAlpha(normalAngle: 1.5 * Double.pi, dark: false)
    let bottomEdge = LiquidGlassRules.rimAlpha(normalAngle: 0.5 * Double.pi, dark: false)
    #expect(topEdge < topLeft / 5 && bottomEdge < bottomRight / 5, "a capsule's long edges only catch a faint glint, so the rim reads as Safari's corners of light, not a ring")
    #expect(abs(LiquidGlassRules.rimAlpha(normalAngle: 1.25 * Double.pi, dark: true) - 0.35) < 1e-9)
    #expect(LiquidGlassRules.rimStops(dark: false).count == 25)
  }

  @Test func `every glass refracts what is under it, turning clear over budget and opaque only for classic, Metal or the lab`() {
    func path(classic: Bool = false, metal: Bool = true, flat: Bool = false, lensFailed: Bool = false, holdsPage: Bool = false, solidPageAsked: Bool = false, overBudget: Bool = false, clearAsked: Bool = false, onScreen: Bool = true) -> LiquidGlassRules.Choice {
      LiquidGlassRules.choose(classic: classic, metal: metal, flat: flat, lensFailed: lensFailed, rimFailed: false, holdsPage: holdsPage, solidPageAsked: solidPageAsked, overBudget: overBudget, clearAsked: clearAsked, onScreen: onScreen)
    }
    #expect(path().path == .live)
    #expect(path().lens && path().rim)
    #expect(path(holdsPage: true).path == .live)
    #expect(path(holdsPage: true).lens)
    #expect(path(classic: true).path == .classic)
    #expect(!path(classic: true).rim)
    #expect(path(metal: false).path == .fallback)
    #expect(!path(metal: false).rim)
    #expect(path(onScreen: false).path == .fallback)
    #expect(path(overBudget: true).path == .clear)
    #expect(path(holdsPage: true, overBudget: true).path == .clear, "the page bar never turns opaque for its budget")
    #expect(path(overBudget: true).rim && !path(overBudget: true).lens)
    #expect(path(clearAsked: true).path == .clear)
    #expect(LiquidGlassRules.Path.clear.isGlassy && LiquidGlassRules.Path.live.isGlassy)
    #expect(!LiquidGlassRules.Path.solid.isGlassy && !LiquidGlassRules.Path.fallback.isGlassy && !LiquidGlassRules.Path.classic.isGlassy)
    #expect(path(holdsPage: true, solidPageAsked: true).path == .solid)
    #expect(path(solidPageAsked: true).path == .live)
    #expect(path(flat: true).path == .live)
    #expect(!path(flat: true).lens && !path(flat: true).rim)
    #expect(!path(lensFailed: true).lens && path(lensFailed: true).rim)
  }

  @Test func `glass outside its source draws the source, and glass inside it or without one draws what is beneath it`() {
    #expect(LiquidGlassRules.backdrop(hasSource: true, insideSource: false) == .source)
    #expect(LiquidGlassRules.backdrop(hasSource: true, insideSource: true) == .beneath)
    #expect(LiquidGlassRules.backdrop(hasSource: false, insideSource: false) == .beneath)
  }

  @Test func `the sustained budget measures from the oldest sample, whatever order they arrived in`() {
    let late = LiquidGlassRules.CaptureSample(at: 1.9, ms: 150)
    let early = LiquidGlassRules.CaptureSample(at: 0.4, ms: 150)
    #expect(LiquidGlassRules.overBudget([late, early], now: 2.0), "a delayed frame sample carries the earlier time")
    #expect(LiquidGlassRules.overBudget([early, late], now: 2.0))
  }

  @Test func `a capture is over budget only when it keeps the main thread busy for two seconds`() {
    func samples(every gap: Double, ms: Double, for seconds: Double) -> [LiquidGlassRules.CaptureSample] {
      stride(from: 0.0, through: seconds, by: gap).map { LiquidGlassRules.CaptureSample(at: $0, ms: ms) }
    }
    #expect(LiquidGlassRules.overBudget(samples(every: 1.0 / 60, ms: 12, for: 2), now: 2))
    #expect(!LiquidGlassRules.overBudget(samples(every: 3, ms: 30, for: 9), now: 9))
    #expect(!LiquidGlassRules.overBudget(samples(every: 1.0 / 60, ms: 12, for: 1), now: 1), "a one second burst is not enough")
    #expect(!LiquidGlassRules.overBudget(samples(every: 1.0 / 60, ms: 1.5, for: 2), now: 2))
    #expect(LiquidGlassRules.recentSamples(samples(every: 1, ms: 5, for: 10), now: 10).count == 3)
  }

  @Test func `the render reported at launch is the best the phone can draw`() {
    #expect(LiquidGlassRules.render(classic: false, flat: false, metal: true, lensFailed: false) == .lens)
    #expect(LiquidGlassRules.render(classic: false, flat: true, metal: true, lensFailed: false) == .frost)
    #expect(LiquidGlassRules.render(classic: false, flat: false, metal: true, lensFailed: true) == .clear, "without the shader the glass draws clear glass, not frost")
    #expect(LiquidGlassRules.render(classic: false, flat: true, metal: true, lensFailed: true) == .clear)
    #expect(LiquidGlassRules.render(classic: false, flat: false, metal: false, lensFailed: false) == .solid)
    #expect(LiquidGlassRules.render(classic: true, flat: false, metal: true, lensFailed: false) == .classic)
  }

  @Test func `a capsule's radius is half its height and a rounded one is capped there`() {
    #expect(LiquidGlassRules.radius(capsule: true, cornerRadius: 0, width: 300, height: 52) == 26)
    #expect(LiquidGlassRules.radius(capsule: false, cornerRadius: 12, width: 300, height: 52) == 12)
    #expect(LiquidGlassRules.radius(capsule: false, cornerRadius: 40, width: 300, height: 52) == 26)
    #expect(LiquidGlassRules.radius(capsule: false, cornerRadius: -3, width: 300, height: 52) == 0)
  }

  @Test func `the uniforms line up with the shader's struct`() {
    let frame = LiquidGlassShader.Frame(width: 300, height: 52, scale: 3, radius: 26, live: true, lens: true, rim: true, dark: true, fill: GlassInk(hex: 0x1E1B1D), tint: GlassInk(hex: 0xFF0000, alpha: 0.5))
    let values = frame.uniforms
    #expect(values.count == LiquidGlassShader.Uniform.allCases.count)
    #expect(values[LiquidGlassShader.Uniform.width.rawValue] == 300)
    #expect(values[LiquidGlassShader.Uniform.bezel.rawValue] == 14)
    #expect(abs(values[LiquidGlassShader.Uniform.rimOpacity.rawValue] - 0.35) < 1e-6)
    #expect(values[LiquidGlassShader.Uniform.tintRed.rawValue] == 0.5)
    #expect(values[LiquidGlassShader.Uniform.tintAlpha.rawValue] == 0.5)
    #expect(abs(values[LiquidGlassShader.Uniform.frostAlpha.rawValue] - 0.1) < 1e-6)
    let names = LiquidGlassShader.Uniform.allCases.map { "float \($0)" }
    let declared = LiquidGlassShader.source.components(separatedBy: "struct GlassUniforms {")[1].components(separatedBy: "};")[0]
    let order = declared.components(separatedBy: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    #expect(order == names)
  }

  @Test func `the shader compiles wherever there is Metal`() throws {
    guard let device = MTLCreateSystemDefaultDevice() else { return }
    let library = try device.makeLibrary(source: LiquidGlassShader.source, options: nil)
    #expect(library.makeFunction(name: LiquidGlassShader.vertexName) != nil)
    #expect(library.makeFunction(name: LiquidGlassShader.fragmentName) != nil)
  }

  @Test func `the median of an even count averages the two middle samples`() {
    #expect(LiquidGlassRules.median([]) == 0)
    #expect(LiquidGlassRules.median([3]) == 3)
    #expect(LiquidGlassRules.median([1, 9, 2]) == 2)
    #expect(LiquidGlassRules.median([1, 2, 6, 9]) == 4)
  }

  @Test func `a glass takes captures only while it refracts, and a failed one backs off`() {
    func path(overBudget: Bool = false, classic: Bool = false, metal: Bool = true) -> LiquidGlassRules.Path {
      LiquidGlassRules.choose(classic: classic, metal: metal, flat: false, lensFailed: false, rimFailed: false, holdsPage: true, overBudget: overBudget).path
    }
    let steps = [path(), path(overBudget: true), path()]
    #expect(steps == [.live, .clear, .live])
    #expect(steps.map(LiquidGlassRules.acceptsCapture) == [true, false, true])
    #expect(!LiquidGlassRules.acceptsCapture(path(classic: true)))
    #expect(!LiquidGlassRules.acceptsCapture(path(metal: false)))
    #expect(LiquidGlassRules.captureRetryDelay(failures: 0) == 0)
    #expect(LiquidGlassRules.captureRetryDelay(failures: 1) == 0.05)
    #expect(LiquidGlassRules.captureRetryDelay(failures: 3) == 0.2)
    #expect(LiquidGlassRules.captureRetryDelay(failures: 40) == 1)
  }

  @Test func `only siblings drawn under the glass are captured, by zPosition then index`() {
    let siblings = [GlassStacking.Sibling(index: 0, zPosition: 0), GlassStacking.Sibling(index: 1, zPosition: 5), GlassStacking.Sibling(index: 2, zPosition: 0), GlassStacking.Sibling(index: 3, zPosition: -1), GlassStacking.Sibling(index: 4, zPosition: 0)]
    #expect(GlassStacking.below(siblings[2], among: siblings) == [3, 0])
    #expect(GlassStacking.below(siblings[1], among: siblings) == [3, 0, 2, 4])
    #expect(GlassStacking.below(siblings[3], among: siblings) == [])
    #expect(GlassStacking.drawOrder(siblings).map(\.index) == [3, 0, 2, 4, 1])
  }

  @Test func `the capture starts at the topmost opaque piece that truly covers the strip`() {
    let strip = CGRect(x: 20, y: 700, width: 360, height: 60)
    let screen = CGRect(x: 0, y: 0, width: 402, height: 874)
    let pieces = [
      GlassStacking.Coverage(rect: screen, opaque: true),
      GlassStacking.Coverage(rect: screen, opaque: true, clips: [CGRect(x: 0, y: 0, width: 402, height: 600)]),
      GlassStacking.Coverage(rect: screen, radius: 30, opaque: true),
      GlassStacking.Coverage(rect: screen, axisAligned: false, opaque: true),
      GlassStacking.Coverage(rect: screen, opaque: false),
    ]
    #expect(GlassStacking.opaqueFloor(pieces, covering: strip) == 2)
    #expect(!pieces[2].covers(CGRect(x: 0, y: 850, width: 402, height: 24)))
    #expect(!pieces[1].covers(strip))
    #expect(!pieces[3].covers(strip))
    #expect(GlassStacking.opaqueFloor([GlassStacking.Coverage(rect: screen, opaque: false)], covering: strip) == nil)
  }

  @Test func `a page picture is kept only for the page and committed document it was asked for`() {
    var gate = GlassSnapshotGate()
    let first = GlassPageKey(page: 1, committed: 4)
    let firstSeen = gate.observe(first)
    let seenAgain = gate.observe(first)
    #expect(firstSeen)
    #expect(!seenAgain)
    let asked = gate.begin(now: 0)
    #expect(gate.accepts(token: asked, key: first))
    let otherTab = gate.observe(GlassPageKey(page: 2, committed: 4))
    #expect(otherTab, "another tab")
    #expect(!gate.accepts(token: asked, key: first), "a late completion from the old tab is refused")
    #expect(!gate.accepts(token: asked, key: GlassPageKey(page: 2, committed: 4)))
    let newDocument = gate.observe(GlassPageKey(page: 2, committed: 5))
    #expect(newDocument, "a new document committed in the same tab")
    let again = gate.begin(now: 1)
    let newer = gate.begin(now: 1.1)
    #expect(!gate.accepts(token: again, key: GlassPageKey(page: 2, committed: 5)), "only the newest request counts")
    #expect(gate.accepts(token: newer, key: GlassPageKey(page: 2, committed: 5)))
  }

  @Test func `WebKit is asked while the page is still or scrolls slowly, far from the last snapshot or after a second`() {
    var gate = GlassSnapshotGate()
    gate.observe(GlassPageKey(page: 1, committed: 1))
    func ask(image: Bool = true, pending: Bool = false, still: Int = 5, distance: CGFloat = 0, age: TimeInterval = 0, committed: Bool = true, speed: CGFloat = 0, moving: Bool = false) -> GlassSnapshotAsk {
      GlassSnapshotAsk(hasImage: image, pending: pending, stillFrames: still, distance: distance, age: age, committed: committed, speed: speed, allowsMoving: moving)
    }
    #expect(gate.mayRequest(now: 0, ask(image: false)))
    #expect(!gate.mayRequest(now: 0, ask(image: false, still: 1)), "never while the page moves unless moving snapshots are on")
    #expect(gate.mayRequest(now: 0, ask(image: false, still: 1, speed: 300, moving: true)), "a slow scroll")
    #expect(!gate.mayRequest(now: 0, ask(image: false, still: 1, speed: 2400, moving: true)), "never during a fling")
    #expect(!gate.mayRequest(now: 0, ask(still: 1, age: 5, speed: 300, moving: true)), "age alone is no reason while moving")
    #expect(gate.mayRequest(now: 0, ask(still: 1, distance: 8, speed: 300, moving: true)), "while it creeps, one is always in flight")
    #expect(!gate.mayRequest(now: 0, ask(image: false, committed: false)), "never before the new document commits")
    #expect(!gate.mayRequest(now: 0, ask(image: false, pending: true)))
    #expect(!gate.mayRequest(now: 0, ask(distance: 1)), "a point of scroll is not a reason")
    #expect(!gate.mayRequest(now: 0, ask(distance: 599)))
    #expect(gate.mayRequest(now: 0, ask(distance: 600)))
    #expect(gate.mayRequest(now: 0, ask(age: 1)))
    gate.failed(now: 1)
    #expect(!gate.mayRequest(now: 1.01, ask(image: false)))
    #expect(gate.mayRequest(now: 1.06, ask(image: false)))
  }

  @Test func `a snapshot is used if the page held still or only crept while WebKit took it`() {
    #expect(GlassFlowRules.acceptsSnapshot(moved: false, maxSpeed: 0, allowsMoving: false, zoomRequested: 1, zoomNow: 1))
    #expect(!GlassFlowRules.acceptsSnapshot(moved: true, maxSpeed: 100, allowsMoving: false, zoomRequested: 1, zoomNow: 1), "with moving snapshots off any move refuses it")
    #expect(GlassFlowRules.acceptsSnapshot(moved: true, maxSpeed: 300, allowsMoving: true, zoomRequested: 1, zoomNow: 1))
    #expect(!GlassFlowRules.acceptsSnapshot(moved: true, maxSpeed: 900, allowsMoving: true, zoomRequested: 1, zoomNow: 1), "a fling while it was taken")
    #expect(!GlassFlowRules.acceptsSnapshot(moved: false, maxSpeed: 0, allowsMoving: true, zoomRequested: 1, zoomNow: 2))
    var gate = GlassSnapshotGate()
    gate.observe(GlassPageKey(page: 1, committed: 7))
    let asked = gate.begin(now: 0)
    let reloaded = gate.observe(GlassPageKey(page: 1, committed: 8))
    #expect(reloaded, "the same URL committed again")
    #expect(!gate.accepts(token: asked, key: GlassPageKey(page: 1, committed: 7)))
  }

  @Test func `a flat snapshot is kept only when the page's own background is that flat colour`() {
    let white = Array(repeating: [1.0, 1.0, 1.0, 1.0], count: 16)
    #expect(GlassFlowRules.uniform(white) == [1, 1, 1, 1])
    #expect(GlassFlowRules.uniform(white + [[0.2, 0.2, 0.2, 1]]) == nil)
    #expect(GlassFlowRules.acceptsUniform([1, 1, 1, 1], background: [1, 1, 1, 1]))
    #expect(!GlassFlowRules.acceptsUniform([0, 0, 0, 1], background: [1, 1, 1, 1]), "a black frame over a white page is a blank snapshot")
    #expect(!GlassFlowRules.acceptsUniform([1, 1, 1, 1], background: nil))
  }

  @Test func `the whole sampling footprint must be inside the capture, and only page pixels shift`() {
    let glass = CGRect(x: 20, y: 760, width: 360, height: 48)
    let footprint = GlassFlowRules.footprint(of: glass, margin: 24)
    #expect(footprint == CGRect(x: -4, y: 736, width: 408, height: 96))
    #expect(!CGRect(x: -4, y: 737, width: 408, height: 400).contains(footprint), "a point short of the margin is not enough")
    #expect(GlassFlowRules.shiftable(pageIndex: 1, overlapsAbove: [true, true, false]))
    #expect(!GlassFlowRules.shiftable(pageIndex: 1, overlapsAbove: [true, true, true]), "something over the page in the strip")
    #expect(!GlassFlowRules.shiftable(pageIndex: nil, overlapsAbove: [true]))
  }

  @Test func `a backdrop may hitch once in two seconds, a page or what lies beneath never`() {
    let frameMs = 1000.0 / 60
    let once = [LiquidGlassRules.CaptureSample(at: 1, ms: 38)]
    #expect(LiquidGlassRules.overBudget(once, now: 1.1, frameMs: frameMs))
    #expect(!LiquidGlassRules.overBudget(once, now: 1.1, frameMs: frameMs, strikes: LiquidGlassRules.backdropStrikes))
    #expect(LiquidGlassRules.overBudget(once + [LiquidGlassRules.CaptureSample(at: 2, ms: 30)], now: 2.1, frameMs: frameMs, strikes: LiquidGlassRules.backdropStrikes))
  }

  @Test func `a cold capture is forgiven once and only up to fifty milliseconds`() {
    let frameMs = 1000.0 / 60
    #expect(!LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 45, cold: true)], now: 1.1, frameMs: frameMs))
    #expect(LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 84, cold: true)], now: 1.1, frameMs: frameMs), "an 84 ms first capture still counts")
  }

  @Test func `the page is drawn from its document, further ahead of the scroll than behind it`() {
    let visible = CGRect(x: 0, y: 2000, width: 402, height: 874)
    let down = GlassFlowRules.documentArea(visible: visible, documentHeight: 20000, direction: 1, speed: 0)
    #expect(down.minY == 800 && down.maxY == 2874 + 3600)
    let up = GlassFlowRules.documentArea(visible: visible, documentHeight: 20000, direction: -1, speed: 0)
    #expect(up.minY == -300 && up.maxY == 2874 + 1200, "it stops just past the top of the document, where the page can overscroll")
    let still = GlassFlowRules.documentArea(visible: visible, documentHeight: 20000, direction: 0, speed: 0)
    #expect(still.minY == -300 && still.maxY == 2874 + 2400, "before the page moves it reaches both ways")
    let fling = GlassFlowRules.documentArea(visible: visible, documentHeight: 20000, direction: 1, speed: 9000)
    #expect(abs(fling.maxY - (2874 + 6000)) < 0.001, "a fling reaches further, up to 6,000 points")
    let short = GlassFlowRules.documentArea(visible: visible, documentHeight: 3000, direction: 1, speed: 0)
    #expect(short.minY == -300 && short.maxY == 3300, "a short document is drawn whole, with the overscroll at both ends")
    let flingBack = GlassFlowRules.documentArea(visible: visible, documentHeight: 20000, direction: -1, speed: 9000)
    #expect(abs(flingBack.maxY - (2874 + 3000)) < 0.001, "a fling keeps more behind it, in case it turns")
    #expect(GlassFlowRules.captureReach(speed: 0) == 1800 && GlassFlowRules.captureReach(speed: 4000) == 2400 && GlassFlowRules.captureReach(speed: 9000) == 3600)
    #expect(GlassFlowRules.place(area: CGRect(x: 0, y: 800, width: 402, height: 5674), zoom: 1, offset: CGPoint(x: 0, y: 2000)) == CGRect(x: 0, y: -1200, width: 402, height: 5674))
    #expect(GlassFlowRules.place(area: CGRect(x: 0, y: 100, width: 201, height: 400), zoom: 2, offset: CGPoint(x: 0, y: 150)) == CGRect(x: 0, y: 50, width: 402, height: 800))
    #expect(GlassFlowRules.direction(velocity: 300, last: -1) == 1)
    #expect(GlassFlowRules.direction(velocity: -300, last: 1) == -1)
    #expect(GlassFlowRules.direction(velocity: 5, last: -1) == -1, "a creep keeps the last direction")
  }

  @Test func `a zoomed page reaches as far on screen, and its picture never takes more than two million pixels`() {
    let visible = CGRect(x: 0, y: 2000, width: 402 / 5, height: 874 / 5)
    let zoomed = GlassFlowRules.documentArea(visible: visible, documentHeight: 20000, direction: 1, speed: 0, zoom: 5)
    #expect(abs((zoomed.maxY - visible.maxY) * 5 - 3600) < 0.01 && abs((visible.minY - zoomed.minY) * 5 - 1200) < 0.01)
    #expect(GlassFlowRules.rasterScale(area: CGRect(x: 0, y: 0, width: 402, height: 9600), zoom: 1, pixelsPerPoint: 0.5) == 0.5)
    let area = CGRect(x: 0, y: 0, width: 170, height: 9000)
    let scale = GlassFlowRules.rasterScale(area: area, zoom: 5, pixelsPerPoint: 0.5)
    #expect(scale < 2.5 && area.width * area.height * scale * scale <= GlassFlowRules.rasterPixelsLongest + 1, "at 5x a 9,000 point picture would be 9.6 million pixels")
  }

  @Test func `WebKit's PDF work counts against the budget when it runs most of the time`() {
    let spans: [(start: TimeInterval, end: TimeInterval?)] = [(10, 10.08), (10.3, 10.38), (10.6, 10.68)]
    #expect(abs(GlassFlowRules.documentBusy(spans, now: 11) - 0.12) < 0.001)
    #expect(!GlassFlowRules.documentOverBudget(spans, now: 11))
    let back: [(start: TimeInterval, end: TimeInterval?)] = [(9.0, 9.5), (9.5, 10.0), (10.0, 10.4), (10.4, nil)]
    #expect(GlassFlowRules.documentOverBudget(back, now: 10.9), "one after another, the last still running")
    #expect(!GlassFlowRules.documentOverBudget(Array(back.dropLast()) + [(start: 10.4, end: 10.9)], now: 13.5), "and it drains once they stop")
  }

  @Test func `a new document picture is asked for before the scroll runs past the one it has`() {
    let needed = CGRect(x: 0, y: 736, width: 402, height: 96)
    let placed = CGRect(x: 0, y: -1200, width: 402, height: 4000)
    let document = CGRect(x: 0, y: -5000, width: 402, height: 20000)
    func wanted(image: Bool = true, still: Bool = false, age: TimeInterval = 0, placed: CGRect = placed, document: CGRect = document, velocity: CGFloat = 0) -> Bool {
      GlassFlowRules.documentWanted(hasImage: image, still: still, age: age, needed: needed, placed: placed, document: document, velocity: velocity)
    }
    #expect(wanted(image: false, still: true, placed: .null))
    #expect(!wanted(still: true, age: 1))
    #expect(wanted(still: true, age: 2), "a still page is refreshed every two seconds")
    #expect(!wanted(velocity: 1000), "1,200 points of lead are still inside")
    #expect(wanted(velocity: 3000), "a fling needs 2,250 points of lead")
    #expect(wanted(placed: placed.offsetBy(dx: 0, dy: 1000), velocity: -1000), "scrolling up runs out above")
    #expect(!wanted(document: CGRect(x: 0, y: -5000, width: 402, height: 7800), velocity: 3000), "no lead is asked for past the end of the document")
    #expect(!wanted(placed: CGRect(x: 0, y: -1200, width: 402, height: 5100), velocity: 9400), "a fling's lead is capped at 3,000 points, half a fresh picture's 6,000, so a new picture lasts")
    #expect(wanted(placed: CGRect(x: 0, y: -1200, width: 402, height: 4000), velocity: 9400))
    let need = GlassFlowRules.captureNeed(footprint: CGRect(x: 0, y: 700, width: 402, height: 160), velocity: CGPoint(x: 0, y: 1000))
    #expect(need == CGRect(x: 0, y: 700, width: 402, height: 410))
    let held = CGRect(x: 0, y: -1000, width: 402, height: 2500)
    #expect(!GlassFlowRules.recenters(held: held, offer: held.offsetBy(dx: 0, dy: 500), need: need), "the capture still holds the lead")
    #expect(GlassFlowRules.recenters(held: held.offsetBy(dx: 0, dy: -400), offer: held.offsetBy(dx: 0, dy: 500), need: need), "it is redrawn ahead before the lead runs out")
    #expect(!GlassFlowRules.recenters(held: held.offsetBy(dx: 0, dy: -400), offer: held.offsetBy(dx: 0, dy: -400), need: need), "never again for a picture that reaches no further")
  }

  @Test func `the lens fades to clear glass before its capture runs out`() {
    let capture = CGRect(x: 0, y: 500, width: 402, height: 500)
    let footprint = CGRect(x: 0, y: 736, width: 402, height: 96)
    #expect(GlassFlowRules.lensShows(footprint: footprint, capture: capture, velocity: .zero))
    #expect(GlassFlowRules.lensShows(footprint: footprint, capture: capture, velocity: CGPoint(x: 0, y: 1000)), "120 points of room at 1000 points a second")
    #expect(!GlassFlowRules.lensShows(footprint: footprint, capture: capture, velocity: CGPoint(x: 0, y: 2000)), "it starts fading while still covered")
    #expect(GlassFlowRules.lensShows(footprint: footprint, capture: capture, velocity: CGPoint(x: 0, y: 2000), travel: -900...100), "but not for scrolling the page can't do")
    #expect(GlassFlowRules.lensShows(footprint: footprint, capture: capture, velocity: CGPoint(x: 0, y: -1500)))
    #expect(!GlassFlowRules.lensShows(footprint: footprint.offsetBy(dx: 0, dy: 200), capture: capture, velocity: .zero))
    #expect(GlassFlowRules.lensDraws(footprint: footprint.offsetBy(dx: 0, dy: 200), capture: capture), "it keeps drawing while it fades")
    #expect(!GlassFlowRules.lensDraws(footprint: footprint.offsetBy(dx: 0, dy: 900), capture: capture))
    #expect(!GlassFlowRules.lensShows(footprint: footprint, capture: .null, velocity: .zero))
  }

  @Test func `an over-budget glass cools down for a few seconds, longer each time, and forgets after a minute`() {
    var cooldown = GlassBudgetCooldown()
    #expect(!cooldown.isCooling(now: 0))
    cooldown.trip(now: 10)
    #expect(cooldown.isCooling(now: 12.9))
    #expect(!cooldown.isCooling(now: 13))
    cooldown.trip(now: 14)
    #expect(cooldown.isCooling(now: 19.9) && !cooldown.isCooling(now: 20))
    cooldown.trip(now: 21)
    #expect(cooldown.trips == 3 && !cooldown.isCooling(now: 33))
    cooldown.trip(now: 200)
    #expect(cooldown.trips == 1 && !cooldown.isCooling(now: 203))
    #expect(LiquidGlassRules.budgetCooldown(trips: 9) == LiquidGlassRules.budgetCooldownLongest)
  }

  @Test func `clear glass is a light veil that keeps text readable`() {
    let light = GlassFrostStyle.glass.clear(dark: false)
    let dark = GlassFrostStyle.glass.clear(dark: true)
    #expect(light.alpha > GlassFrostStyle.glass.tint(dark: false).alpha && light.alpha < GlassFrostStyle.glass.fallback(dark: false).alpha)
    #expect(dark.alpha > GlassFrostStyle.glass.tint(dark: true).alpha && dark.alpha < GlassFrostStyle.glass.fallback(dark: true).alpha)
  }

  @Test func `a shifted snapshot must cover the strip, so a fast fling fades to clear glass`() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    let image = viewport.insetBy(dx: 0, dy: -320)
    let bar = CGRect(x: 0, y: 760 - 24, width: 402, height: 48 + 48)
    #expect(GlassFlowRules.snapshotCovers(image: image, shift: .zero, needed: bar))
    #expect(GlassFlowRules.snapshotCovers(image: image, shift: CGPoint(x: 0, y: 300), needed: bar))
    #expect(!GlassFlowRules.snapshotCovers(image: image, shift: CGPoint(x: 0, y: 520), needed: bar), "the image ends at 674 points and the bar is at 760")
    #expect(!GlassFlowRules.snapshotCovers(image: .null, shift: .zero, needed: bar))
  }

  @Test func `at most two frames are in flight and a drawable is taken only when one is free`() {
    var flight = GlassFlight(limit: 2)
    let one = flight.reserve()
    let two = flight.reserve()
    let three = flight.reserve()
    #expect(one && two)
    #expect(!three, "the third waits")
    flight.finish()
    let again = flight.reserve()
    #expect(again)
    #expect(flight.inFlight == 2)
    flight.finish()
    flight.finish()
    flight.finish()
    #expect(flight.inFlight == 0)
    #expect(GlassFlowRules.canAcquireDrawable(outstanding: 0, maximum: 3))
    #expect(!GlassFlowRules.canAcquireDrawable(outstanding: 1, maximum: 3), "one shown and one queued by the compositor, one still on the GPU")
    #expect(GlassFlowRules.canAcquireDrawable(outstanding: 1, maximum: 4))
  }

  @Test func `one capture longer than a frame is over budget`() {
    let frameMs = 1000.0 / 60
    #expect(LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 35)], now: 1.2, frameMs: frameMs))
    #expect(!LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 12)], now: 1.2, frameMs: frameMs))
    #expect(!LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 35)], now: 4, frameMs: frameMs), "it ages out of the window")
    let cold = [LiquidGlassRules.CaptureSample(at: 1, ms: 45, cold: true), LiquidGlassRules.CaptureSample(at: 1.02, ms: 3)]
    #expect(!LiquidGlassRules.overBudget(cold, now: 1.1, frameMs: frameMs), "a glass's first, cold capture warms up outside the limit")
    #expect(!LiquidGlassRules.overBudget(cold, now: 2.9, frameMs: frameMs), "and stays outside it while in the window")
    #expect(LiquidGlassRules.overBudget(cold + [LiquidGlassRules.CaptureSample(at: 1.04, ms: 30)], now: 1.1, frameMs: frameMs), "a slow one after it still counts")
  }

  @Test func `a changing backdrop is recaptured when its change ends, not a second later`() {
    #expect(!GlassFlowRules.recaptureNow(changed: false, quietFrames: 9, sinceCapture: 9, gap: 1))
    #expect(!GlassFlowRules.recaptureNow(changed: true, quietFrames: 0, sinceCapture: 0.2, gap: 1), "mid crossfade it waits")
    #expect(GlassFlowRules.recaptureNow(changed: true, quietFrames: 2, sinceCapture: 0.2, gap: 1), "the crossfade ended")
    #expect(GlassFlowRules.recaptureNow(changed: true, quietFrames: 0, sinceCapture: 1.1, gap: 1))
  }

  @Test func `the rim is its own pass of white light, so compositing it with plus lighter is Android's PLUS`() throws {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return }
    let library = try device.makeLibrary(source: LiquidGlassShader.source, options: nil)
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: LiquidGlassShader.vertexName)
    descriptor.fragmentFunction = library.makeFunction(name: LiquidGlassShader.fragmentName)
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
    func render(rim: Bool, rimOnly: Bool) -> [Float] {
      var frame = LiquidGlassShader.Frame(width: 48, height: 48, scale: 1, radius: 24, live: false, lens: false, rim: rim, dark: false, fill: GlassFrostStyle.glass.fallback(dark: false))
      frame.rimOnly = rimOnly
      let target = device.makeTexture(descriptor: { let made = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 48, height: 48, mipmapped: false); made.usage = [.renderTarget, .shaderRead]; made.storageMode = .shared; return made }())!
      let blank = device.makeTexture(descriptor: MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false))!
      let buffer = queue.makeCommandBuffer()!
      let pass = MTLRenderPassDescriptor()
      pass.colorAttachments[0].texture = target
      pass.colorAttachments[0].loadAction = .clear
      pass.colorAttachments[0].storeAction = .store
      let encoder = buffer.makeRenderCommandEncoder(descriptor: pass)!
      encoder.setRenderPipelineState(pipeline)
      let uniforms = frame.uniforms
      uniforms.withUnsafeBytes { encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
      encoder.setFragmentTexture(blank, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      encoder.endEncoding()
      buffer.commit()
      buffer.waitUntilCompleted()
      var pixel = [UInt8](repeating: 0, count: 4)
      target.getBytes(&pixel, bytesPerRow: 4 * 48, from: MTLRegionMake2D(0, 24, 1, 1), mipmapLevel: 0)
      return pixel.map { Float($0) / 255 }
    }
    let glass = render(rim: true, rimOnly: false)
    #expect(glass == render(rim: false, rimOnly: false), "the glass pass carries no rim")
    let light = render(rim: true, rimOnly: true)
    #expect(light[3] > 0.05)
    #expect(light.allSatisfy { abs($0 - light[3]) < 0.01 }, "premultiplied white: the same value in all four channels")
    #expect(render(rim: false, rimOnly: true).allSatisfy { $0 == 0 })
    for backdrop: [Float] in [[0.2, 0.3, 0.4, 1], [0.2, 0.3, 0.4, 0.5]] {
      let under = (0..<4).map { glass[$0] + backdrop[$0] * (1 - glass[3]) }
      let android = (0..<4).map { min(under[$0] + light[3], 1) }
      let ours = (0..<4).map { min(under[$0] + light[$0], 1) }
      for channel in 0..<4 { #expect(abs(android[channel] - ours[channel]) < 0.01) }
      #expect(ours[3] >= under[3], "PLUS adds to alpha too")
    }
  }
}
