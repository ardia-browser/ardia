import CoreGraphics
import Foundation

public struct GlassPageKey: Hashable, Sendable {
  public var page: Int
  public var committed: Int
  public var route: Int

  public init(page: Int, committed: Int, route: Int = 0) {
    self.page = page
    self.committed = committed
    self.route = route
  }
}

public struct GlassSnapshotAsk: Equatable, Sendable {
  public var hasImage: Bool
  public var pending: Bool
  public var stillFrames: Int
  public var distance: CGFloat
  public var age: TimeInterval
  public var committed: Bool
  public var speed: CGFloat
  public var allowsMoving: Bool

  public init(hasImage: Bool, pending: Bool, stillFrames: Int, distance: CGFloat, age: TimeInterval, committed: Bool, speed: CGFloat = 0, allowsMoving: Bool = false) {
    self.hasImage = hasImage
    self.pending = pending
    self.stillFrames = stillFrames
    self.distance = distance
    self.age = age
    self.committed = committed
    self.speed = speed
    self.allowsMoving = allowsMoving
  }

  public var isStill: Bool { stillFrames >= GlassFlowRules.stillFramesForSnapshot }

  public var isSlow: Bool { isStill || (allowsMoving && speed <= GlassFlowRules.slowScroll) }
}

public struct GlassBudgetCooldown: Sendable {
  public private(set) var trips = 0
  public private(set) var until: TimeInterval = -.infinity
  public private(set) var lastTrip: TimeInterval = -.infinity

  public init() {}

  public mutating func trip(now: TimeInterval) {
    if now - lastTrip > LiquidGlassRules.budgetTripMemory { trips = 0 }
    trips += 1
    lastTrip = now
    until = now + LiquidGlassRules.budgetCooldown(trips: trips)
  }

  public func isCooling(now: TimeInterval) -> Bool { now < until }
}

public struct GlassSnapshotGate: Sendable {
  public private(set) var key: GlassPageKey?
  public private(set) var token = 0
  public private(set) var failures = 0
  public private(set) var nextRequest: TimeInterval = 0
  public private(set) var lastRequest: TimeInterval = -.infinity

  public init() {}

  @discardableResult
  public mutating func observe(_ key: GlassPageKey) -> Bool {
    guard key != self.key else { return false }
    self.key = key
    token += 1
    failures = 0
    nextRequest = 0
    return true
  }

  public func mayRequest(now: TimeInterval, _ ask: GlassSnapshotAsk) -> Bool {
    guard !ask.pending, now >= nextRequest, ask.committed, ask.isSlow else { return false }
    guard ask.hasImage else { return true }
    guard ask.isStill else { return ask.distance >= GlassFlowRules.movingRefetchDistance }
    return ask.distance >= GlassFlowRules.snapshotRefetchDistance || ask.age >= GlassFlowRules.snapshotRefresh
  }

  public mutating func begin(now: TimeInterval) -> Int {
    token += 1
    lastRequest = now
    return token
  }

  public func accepts(token: Int, key: GlassPageKey) -> Bool {
    token == self.token && key == self.key
  }

  public mutating func succeeded() {
    failures = 0
    nextRequest = 0
  }

  public mutating func failed(now: TimeInterval) {
    failures += 1
    nextRequest = now + LiquidGlassRules.captureRetryDelay(failures: failures)
  }
}

public struct GlassZoomWatch: Sendable {
  public private(set) var zoom: Double?

  public init() {}

  public mutating func observe(_ zoom: Double) -> Bool {
    defer { self.zoom = zoom }
    return self.zoom.map { $0 != zoom } ?? false
  }
}

public enum GlassToneRows {
  private static let linear: [Float] = (0..<256).map { value in
    let channel = Double(value) / 255
    return Float(channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4))
  }

  public static func rows(_ base: UnsafeRawPointer, width: Int, height: Int, bytesPerRow: Int) -> [Float] {
    guard width > 0, height > 0 else { return [] }
    return (0..<height).map { row in
      let line = base.advanced(by: row * bytesPerRow)
      var sum: Float = 0
      var count: Float = 0
      for column in stride(from: 0, to: width, by: 2) {
        let pixel = line.advanced(by: column * 4)
        let blue = linear[Int(pixel.load(fromByteOffset: 0, as: UInt8.self))]
        let green = linear[Int(pixel.load(fromByteOffset: 1, as: UInt8.self))]
        let red = linear[Int(pixel.load(fromByteOffset: 2, as: UInt8.self))]
        sum += 0.2126 * red + 0.7152 * green + 0.0722 * blue
        count += 1
      }
      return sum / max(count, 1)
    }
  }

  public static func mean(_ rows: [Float], from top: Double, to bottom: Double) -> Double? {
    guard !rows.isEmpty, bottom > top else { return nil }
    let first = max(Int((top * Double(rows.count)).rounded(.down)), 0)
    let last = min(Int((bottom * Double(rows.count)).rounded(.up)), rows.count)
    guard last > first else { return nil }
    return Double(rows[first..<last].reduce(0, +)) / Double(last - first)
  }
}

public struct GlassPageFollow: Sendable {
  public private(set) var following = false

  public init() {}

  public mutating func installed(following: Bool) {
    self.following = following
  }

  public mutating func dropped() {
    following = false
  }

  public mutating func dropsCapture(shiftable: Bool) -> Bool {
    guard !shiftable, following else { return false }
    following = false
    return true
  }
}

public enum GlassToneSend {
  public static func needed(toneChanged: Bool, hasColors: Bool, barDark: Bool?, sentBarDark: Bool?) -> Bool {
    guard toneChanged || barDark != sentBarDark else { return false }
    return hasColors || barDark != nil || sentBarDark != nil
  }
}

public struct GlassToneGate: Sendable {
  public static let darkBelow = 0.2
  public static let lightAbove = 0.4
  public static let settle: TimeInterval = 0.3

  public private(set) var dark: Bool?
  private var pending: Bool?
  private var since: TimeInterval = 0

  public init() {}

  public mutating func observe(luminance: Double, now: TimeInterval) -> Bool {
    let wants: Bool
    if luminance < Self.darkBelow {
      wants = true
    } else if luminance > Self.lightAbove {
      wants = false
    } else {
      pending = nil
      return false
    }
    guard let shown = dark else {
      dark = wants
      return true
    }
    guard wants != shown else {
      pending = nil
      return false
    }
    if pending != wants {
      pending = wants
      since = now
      return false
    }
    guard now - since >= Self.settle else { return false }
    dark = wants
    pending = nil
    return true
  }
}

public struct GlassFlight: Sendable {
  public private(set) var inFlight = 0
  public let limit: Int

  public init(limit: Int = LiquidGlassRules.framesInFlight) {
    self.limit = limit
  }

  public var hasRoom: Bool { inFlight < limit }

  public mutating func reserve() -> Bool {
    guard hasRoom else { return false }
    inFlight += 1
    return true
  }

  public mutating func finish() {
    inFlight = max(inFlight - 1, 0)
  }
}

public enum GlassFlowRules {
  public static let snapshotRefresh: TimeInterval = 1
  public static let stillFramesForSnapshot = 3
  public static let snapshotRefetchDistance: CGFloat = 600
  public static let uniformTolerance = 4.0 / 255
  public static let backgroundTolerance = 10.0 / 255
  public static let quietFramesForRecapture = 2
  public static let scrollReach: CGFloat = 200
  public static let slowScroll: CGFloat = 400
  public static let movingRefetchDistance: CGFloat = 8
  public static let lensFade: TimeInterval = 0.12
  public static let directionSpeed: CGFloat = 20
  public static let documentRefresh: TimeInterval = 2
  public static let documentBehind: CGFloat = 1200
  public static let documentAhead: CGFloat = 3600
  public static let documentAheadLongest: CGFloat = 6000
  public static let documentAheadSeconds: CGFloat = 1.5
  public static let documentLead: CGFloat = 1200
  public static let documentLeadSeconds: CGFloat = 0.75
  public static let documentLeadLongest: CGFloat = 3000
  public static let documentGap: TimeInterval = 0.25
  public static let documentBusyShare = 0.6
  public static let rasterPixelsLongest: CGFloat = 2_000_000
  public static let documentBehindSeconds: CGFloat = 0.4
  public static let documentBehindLongest: CGFloat = 3000
  public static let documentWhole: CGFloat = 9000
  public static let documentOverscroll: CGFloat = 300
  public static let captureReach: CGFloat = 1800
  public static let captureReachLongest: CGFloat = 3600
  public static let captureReachSeconds: CGFloat = 0.6
  public static let captureLeadSeconds: CGFloat = 0.25

  public static func documentArea(visible: CGRect, documentHeight: CGFloat, direction: CGFloat, speed: CGFloat, zoom: CGFloat = 1) -> CGRect {
    let scale = max(zoom, 0.01)
    let first = min(visible.minY, 0) - documentOverscroll / scale
    let last = max(documentHeight, visible.maxY) + documentOverscroll / scale
    if (last - first) * scale <= documentWhole { return CGRect(x: visible.minX, y: first, width: visible.width, height: last - first) }
    let ahead = min(max(documentAhead, speed * documentAheadSeconds), documentAheadLongest) / scale
    let behind = min(max(documentBehind, speed * documentBehindSeconds), documentBehindLongest) / scale
    let even = (ahead + behind) / 2
    let above = direction > 0 ? behind : direction < 0 ? ahead : even
    let below = direction > 0 ? ahead : direction < 0 ? behind : even
    let top = max(visible.minY - above, first)
    let bottom = min(visible.maxY + below, last)
    return CGRect(x: visible.minX, y: top, width: visible.width, height: max(bottom - top, visible.height))
  }

  public static func rasterScale(area: CGRect, zoom: CGFloat, pixelsPerPoint: CGFloat) -> CGFloat {
    let wanted = zoom * pixelsPerPoint
    let pixels = area.width * area.height * wanted * wanted
    guard pixels > rasterPixelsLongest, pixels > 0 else { return wanted }
    return wanted * (rasterPixelsLongest / pixels).squareRoot()
  }

  public static func documentBusy(_ spans: [(start: TimeInterval, end: TimeInterval?)], now: TimeInterval) -> Double {
    let from = now - LiquidGlassRules.budgetWindow
    let busy = spans.reduce(0.0) { total, span in
      let end = min(span.end ?? now, now)
      return total + max(end - max(span.start, from), 0)
    }
    return busy / LiquidGlassRules.budgetWindow
  }

  public static func documentOverBudget(_ spans: [(start: TimeInterval, end: TimeInterval?)], now: TimeInterval) -> Bool {
    documentBusy(spans, now: now) > documentBusyShare
  }

  public static func captureReach(speed: CGFloat) -> CGFloat {
    min(max(captureReach, speed * captureReachSeconds), captureReachLongest)
  }

  public static func documentWanted(hasImage: Bool, still: Bool, age: TimeInterval, needed: CGRect, placed: CGRect, document: CGRect, velocity: CGFloat) -> Bool {
    guard hasImage, !placed.isNull else { return true }
    let reachable = needed.intersection(document)
    if still { return age >= documentRefresh || !placed.contains(reachable.isNull ? needed : reachable) }
    let lead = min(max(documentLead, abs(velocity) * documentLeadSeconds), documentLeadLongest)
    let ahead = needed.union(needed.offsetBy(dx: 0, dy: velocity >= 0 ? lead : -lead)).intersection(document)
    guard !ahead.isNull else { return false }
    return !placed.insetBy(dx: -0.5, dy: -0.5).contains(ahead)
  }

  public static func place(area: CGRect, zoom: CGFloat, offset: CGPoint) -> CGRect {
    guard !area.isNull else { return .null }
    return CGRect(x: area.minX * zoom - offset.x, y: area.minY * zoom - offset.y, width: area.width * zoom, height: area.height * zoom)
  }

  public static func captureNeed(footprint: CGRect, velocity: CGPoint) -> CGRect {
    footprint.union(footprint.offsetBy(dx: velocity.x * captureLeadSeconds, dy: velocity.y * captureLeadSeconds))
  }

  public static func recenters(held: CGRect, offer: CGRect, need: CGRect) -> Bool {
    func covered(_ rect: CGRect) -> CGFloat {
      let inside = rect.intersection(need)
      return inside.isNull ? 0 : inside.width * inside.height
    }
    guard !held.contains(need) else { return false }
    return covered(offer) > covered(held) + need.width
  }

  public static func direction(velocity: CGFloat, last: CGFloat) -> CGFloat {
    if velocity > directionSpeed { return 1 }
    if velocity < -directionSpeed { return -1 }
    return last
  }

  public static func lensDraws(footprint: CGRect, capture: CGRect) -> Bool {
    !capture.isNull && !footprint.isNull && capture.intersects(footprint)
  }

  public static func lensShows(footprint: CGRect, capture: CGRect, velocity: CGPoint, travel: ClosedRange<CGFloat>? = nil) -> Bool {
    guard !capture.isNull, !footprint.isNull else { return false }
    let room = capture.insetBy(dx: -0.5, dy: -0.5)
    guard room.contains(footprint) else { return false }
    let lead = CGFloat(lensFade)
    let ahead = velocity.y * lead
    let reach = travel.map { min(max(ahead, $0.lowerBound), $0.upperBound) } ?? ahead
    return room.contains(footprint.offsetBy(dx: velocity.x * lead, dy: reach))
  }

  public static func acceptsSnapshot(moved: Bool, maxSpeed: CGFloat, allowsMoving: Bool, zoomRequested: CGFloat, zoomNow: CGFloat) -> Bool {
    guard zoomRequested == zoomNow else { return false }
    return !moved || (allowsMoving && maxSpeed <= slowScroll)
  }

  public static func uniform(_ samples: [[Double]]) -> [Double]? {
    guard let first = samples.first else { return nil }
    for channel in first.indices {
      let values = samples.map { $0[channel] }
      guard let low = values.min(), let high = values.max(), high - low <= uniformTolerance else { return nil }
    }
    return first
  }

  public static func acceptsUniform(_ color: [Double], background: [Double]?) -> Bool {
    guard let background, background.count == color.count else { return false }
    return zip(color, background).allSatisfy { abs($0 - $1) <= backgroundTolerance }
  }

  public static func footprint(of glass: CGRect, margin: CGFloat) -> CGRect {
    glass.insetBy(dx: -margin, dy: -margin)
  }

  public static func shiftable(pageIndex: Int?, overlapsAbove: [Bool]) -> Bool {
    guard let pageIndex else { return false }
    return !overlapsAbove.enumerated().contains { $0.offset > pageIndex && $0.element }
  }

  public static func snapshotCovers(image: CGRect, shift: CGPoint, needed: CGRect) -> Bool {
    guard !image.isNull, !needed.isNull, !needed.isEmpty else { return false }
    return image.offsetBy(dx: -shift.x, dy: -shift.y).contains(needed)
  }

  public static func canAcquireDrawable(outstanding: Int, maximum: Int) -> Bool {
    outstanding <= maximum - 3
  }

  public static func overFrame(captureMs: Double, frameMs: Double) -> Bool {
    captureMs > frameMs
  }

  public static func recaptureNow(changed: Bool, quietFrames: Int, sinceCapture: TimeInterval, gap: TimeInterval) -> Bool {
    guard changed else { return false }
    return sinceCapture >= gap || quietFrames >= quietFramesForRecapture
  }
}
