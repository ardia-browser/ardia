import ArdiaDesign
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassPageShot {
  private static let rasterQueue = DispatchQueue(label: "ardia.glass.page", qos: .userInitiated)

  private var gate = GlassSnapshotGate()
  private var zoomWatch = GlassZoomWatch()
  private weak var web: WKWebView?
  private(set) var image: CGImage?
  private var rows: [Float] = []
  private(set) var generation = 0
  private var area: CGRect = .null
  private var zoom: CGFloat = 1
  private var takenAt: CFTimeInterval = 0
  private var pendingToken: Int?
  private var pending: Bool { pendingToken != nil }
  private var busy: [(token: Int, start: TimeInterval, end: TimeInterval?)] = []
  private var movedWhilePending = false
  private var requestedOffset: CGPoint = .zero
  private var lastOffset: CGPoint?
  private var lastSeenAt: CFTimeInterval = 0
  private var stillFrames = 0
  private(set) var velocity: CGPoint = .zero
  private var direction: CGFloat = 0
  private var fastestWhilePending: CGFloat = 0
  private(set) var latencies: [Double] = []
  private(set) var rejected = 0
  private(set) var uncovered = 0
  private(set) var moving = 0
  var onMainWork: ((Double) -> Void)?
  var heldUntil: CFTimeInterval = 0
  private(set) var arrived = false
  private(set) var held = 0

  private func isHeld(at now: CFTimeInterval) -> Bool { now < heldUntil }

  static func key(of web: WKWebView) -> (key: GlassPageKey, committed: Bool) {
    let document = PhonePages.shared.document(of: web)
    return (GlassPageKey(page: ObjectIdentifier(web).hashValue, committed: document?.committed ?? 0, route: document?.route ?? 0), document?.settled ?? true)
  }

  @discardableResult
  func observe(_ web: WKWebView, now: CFTimeInterval) -> Bool {
    let offset = web.scrollView.contentOffset
    if offset == lastOffset { stillFrames += 1 } else { stillFrames = 0 }
    var instant = CGPoint.zero
    if let lastOffset, now > lastSeenAt, lastSeenAt > 0 {
      let span = CGFloat(now - lastSeenAt)
      instant = CGPoint(x: (offset.x - lastOffset.x) / span, y: (offset.y - lastOffset.y) / span)
    }
    velocity = CGPoint(x: (velocity.x + instant.x) / 2, y: (velocity.y + instant.y) / 2)
    direction = GlassFlowRules.direction(velocity: velocity.y, last: direction)
    lastOffset = offset
    lastSeenAt = now
    if pending {
      if offset != requestedOffset { movedWhilePending = true }
      fastestWhilePending = max(fastestWhilePending, hypot(instant.x, instant.y))
    }
    let key = Self.key(of: web).key
    let zoomed = zoomWatch.observe(Double(web.scrollView.zoomScale))
    arrived = self.web !== web
    let changed = gate.observe(key) || arrived || zoomed
    guard changed else { return false }
    self.web = web
    pendingToken = nil
    forgetImage()
    return true
  }

  func request(_ web: WKWebView, around needed: CGRect, pixelsPerPoint: CGFloat, now: CFTimeInterval) {
    guard !isHeld(at: now) else { return }
    switch GlassLaunch.pageShot {
    case .pdf: requestDocument(web, around: needed, pixelsPerPoint: pixelsPerPoint, now: now)
    case .snapshot: requestSnapshot(web, pixelsPerPoint: pixelsPerPoint, now: now)
    }
  }

  private var speed: CGFloat { hypot(velocity.x, velocity.y) }

  private func requestDocument(_ web: WKWebView, around needed: CGRect, pixelsPerPoint: CGFloat, now: CFTimeInterval) {
    let (key, committed) = Self.key(of: web)
    guard !pending, committed, key == gate.key, now >= gate.nextRequest, now - gate.lastRequest >= GlassFlowRules.documentGap else { return }
    let still = stillFrames >= GlassFlowRules.stillFramesForSnapshot
    let zoom = web.scrollView.zoomScale
    let offset = web.scrollView.contentOffset
    let document = GlassFlowRules.place(area: CGRect(x: 0, y: 0, width: web.scrollView.contentSize.width / zoom, height: web.scrollView.contentSize.height / zoom).insetBy(dx: 0, dy: -GlassFlowRules.documentOverscroll), zoom: zoom, offset: offset).union(web.bounds)
    guard GlassFlowRules.documentWanted(hasImage: image != nil, still: still, age: now - takenAt, needed: needed, placed: placed(web)?.rect ?? .null, document: document, velocity: velocity.y) else { return }
    let visible = CGRect(x: offset.x / zoom, y: offset.y / zoom, width: web.bounds.width / zoom, height: web.bounds.height / zoom)
    let area = GlassFlowRules.documentArea(visible: visible, documentHeight: web.scrollView.contentSize.height / zoom, direction: direction, speed: speed, zoom: zoom)
    let token = gate.begin(now: now)
    pendingToken = token
    movedWhilePending = false
    requestedOffset = offset
    let configuration = WKPDFConfiguration()
    configuration.rect = area
    let started = CACurrentMediaTime()
    busy = busy.filter { started - ($0.end ?? started) <= LiquidGlassRules.budgetWindow } + [(token: token, start: started, end: nil)]
    let width = max(Int((area.width * GlassFlowRules.rasterScale(area: area, zoom: zoom, pixelsPerPoint: pixelsPerPoint)).rounded()), 1)
    if PhoneTestBuild.isOn { NSLog("PAGELAB time glass pdf ask %.0f", Date().timeIntervalSince1970 * 1000) }
    web.createPDF(configuration: configuration) { [weak self, weak web] result in
      MainActor.assumeIsolated {
        let working = CACurrentMediaTime()
        guard let self else { return }
        defer { self.onMainWork?((CACurrentMediaTime() - working) * 1000) }
        guard let web, self.web === web, self.gate.accepts(token: token, key: key), web.scrollView.zoomScale == zoom, case .success(let data) = result else {
          self.settle(token, at: working)
          self.rejected += 1
          if case .failure = result { self.gate.failed(now: working) }
          return
        }
        guard !self.isHeld(at: working) else {
          self.settle(token, at: working)
          self.held += 1
          if PhoneTestBuild.isOn { NSLog("PAGELAB glass pdf landed during a hold: not rasterized") }
          return
        }
        let moved = self.movedWhilePending
        Self.rasterQueue.async {
          let (picture, rows) = Self.raster(data, width: width)
          let rasterMs = (CACurrentMediaTime() - started) * 1000
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              let landed = CACurrentMediaTime()
              defer { self.onMainWork?((CACurrentMediaTime() - landed) * 1000) }
              self.settle(token, at: landed)
              guard self.web === web, self.gate.accepts(token: token, key: key), web.scrollView.zoomScale == zoom else {
                self.rejected += 1
                return
              }
              guard !self.isHeld(at: landed) else {
                self.held += 1
                return
              }
              guard let picture, Self.usable(picture, under: web) else {
                self.gate.failed(now: landed)
                return
              }
              self.keep(picture, rows: rows, area: area, zoom: zoom, at: landed, moved: moved)
              if PhoneTestBuild.isOn {
                self.latencies.append(rasterMs)
                NSLog("PAGELAB glass pdf %.0f ms for %.0f points (busy %.0f%%)", rasterMs, area.height, GlassFlowRules.documentBusy(self.busy.map { (start: $0.start, end: $0.end) }, now: landed) * 100)
              }
              if GlassLaunch.placementProbe { GlassPlacementProbe.check(picture, area: area, zoom: zoom, web: web) }
            }
          }
        }
      }
    }
  }

  private func requestSnapshot(_ web: WKWebView, pixelsPerPoint: CGFloat, now: CFTimeInterval) {
    let (key, committed) = Self.key(of: web)
    let distance = image == nil ? .infinity : max(abs(web.scrollView.contentOffset.y - requestedOffset.y), abs(web.scrollView.contentOffset.x - requestedOffset.x))
    let ask = GlassSnapshotAsk(hasImage: image != nil, pending: pending, stillFrames: stillFrames, distance: distance, age: now - takenAt, committed: committed, speed: speed, allowsMoving: GlassLaunch.movingSnapshots)
    guard gate.mayRequest(now: now, ask), key == gate.key else { return }
    let token = gate.begin(now: now)
    pendingToken = token
    movedWhilePending = false
    fastestWhilePending = ask.isStill ? 0 : speed
    let configuration = WKSnapshotConfiguration()
    configuration.rect = web.bounds
    configuration.afterScreenUpdates = GlassLaunch.snapshotAfterUpdates
    configuration.snapshotWidth = NSNumber(value: Double(web.bounds.width * pixelsPerPoint / max(web.traitCollection.displayScale, 1)))
    let offset = web.scrollView.contentOffset
    requestedOffset = offset
    let zoom = web.scrollView.zoomScale
    let started = CACurrentMediaTime()
    web.takeSnapshot(with: configuration) { [weak self, weak web] image, _ in
      MainActor.assumeIsolated {
        let working = CACurrentMediaTime()
        guard let self else { return }
        defer { self.onMainWork?((CACurrentMediaTime() - working) * 1000) }
        self.settle(token, at: working)
        guard let web, self.web === web, self.gate.accepts(token: token, key: key), Self.key(of: web).key == key else {
          self.rejected += 1
          return
        }
        guard !self.isHeld(at: working) else {
          self.held += 1
          return
        }
        let moved = self.movedWhilePending || web.scrollView.contentOffset != offset
        guard GlassFlowRules.acceptsSnapshot(moved: moved, maxSpeed: self.fastestWhilePending, allowsMoving: GlassLaunch.movingSnapshots, zoomRequested: zoom, zoomNow: web.scrollView.zoomScale) else {
          self.rejected += 1
          return
        }
        guard let picture = image?.cgImage, Self.usable(picture, under: web) else {
          self.forgetImage()
          self.gate.failed(now: working)
          return
        }
        let area = CGRect(x: offset.x / zoom, y: offset.y / zoom, width: web.bounds.width / zoom, height: web.bounds.height / zoom)
        self.keep(picture, rows: [], area: area, zoom: zoom, at: working, moved: moved)
        if PhoneTestBuild.isOn { self.latencies.append((working - started) * 1000) }
      }
    }
  }

  private func settle(_ token: Int, at time: CFTimeInterval) {
    if pendingToken == token { pendingToken = nil }
    if let open = busy.firstIndex(where: { $0.token == token && $0.end == nil }) { busy[open].end = time }
  }

  func isOverBudget(now: CFTimeInterval) -> Bool { GlassFlowRules.documentOverBudget(busy.map { (start: $0.start, end: $0.end) }, now: now) }

  private func keep(_ picture: CGImage, rows: [Float], area: CGRect, zoom: CGFloat, at time: CFTimeInterval, moved: Bool) {
    gate.succeeded()
    image = picture
    self.rows = rows
    generation += 1
    moving += moved ? 1 : 0
    self.area = area
    self.zoom = zoom
    takenAt = time
  }

  func placed(_ web: WKWebView) -> (image: CGImage, rect: CGRect)? {
    guard let image, self.web === web, web.scrollView.zoomScale == zoom else { return nil }
    return (image, GlassFlowRules.place(area: area, zoom: zoom, offset: web.scrollView.contentOffset))
  }

  func luminance(under needed: CGRect, of web: WKWebView) -> Double? {
    guard let placed = placed(web), placed.rect.height > 0 else { return nil }
    return GlassToneRows.mean(rows, from: Double((needed.minY - placed.rect.minY) / placed.rect.height), to: Double((needed.maxY - placed.rect.minY) / placed.rect.height))
  }

  func covers(_ needed: CGRect, of web: WKWebView) -> Bool {
    guard gate.key == Self.key(of: web).key, let placed = placed(web) else { return false }
    let covered = GlassFlowRules.snapshotCovers(image: placed.rect, shift: .zero, needed: needed.intersection(web.bounds))
    if !covered { uncovered += 1 }
    return covered
  }

  func draw(_ web: WKWebView, transform: CGAffineTransform, in context: CGContext) -> Bool {
    guard let placed = placed(web) else { return false }
    GlassSteps.draw(placed.image, in: placed.rect, clip: web.bounds, transform: transform, context: context)
    return true
  }

  func takeLatencies() -> [Double] {
    defer { latencies.removeAll() }
    return latencies
  }

  func takeCounts() -> (rejected: Int, uncovered: Int, moving: Int) {
    defer {
      rejected = 0
      uncovered = 0
      moving = 0
    }
    return (rejected, uncovered, moving)
  }

  func release() {
    forgetImage()
    pendingToken = nil
    busy = []
    web = nil
    zoomWatch = GlassZoomWatch()
    lastOffset = nil
    lastSeenAt = 0
    velocity = .zero
    stillFrames = 0
    gate = GlassSnapshotGate()
  }

  private func forgetImage() {
    guard image != nil else { return }
    image = nil
    rows = []
    area = .null
    generation += 1
  }

  nonisolated private static func raster(_ data: Data, width: Int) -> (CGImage?, [Float]) {
    guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1) else { return (nil, []) }
    let box = page.getBoxRect(.mediaBox)
    guard box.width > 0, box.height > 0 else { return (nil, []) }
    let height = max(Int((box.height * CGFloat(width) / box.width).rounded()), 1)
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return (nil, []) }
    context.interpolationQuality = .low
    context.scaleBy(x: CGFloat(width) / box.width, y: CGFloat(height) / box.height)
    context.translateBy(x: -box.minX, y: -box.minY)
    context.drawPDFPage(page)
    let rows = context.data.map { GlassToneRows.rows(UnsafeRawPointer($0), width: width, height: height, bytesPerRow: context.bytesPerRow) } ?? []
    return (context.makeImage(), rows)
  }

  private static func usable(_ image: CGImage, under web: WKWebView) -> Bool {
    let side = 16
    guard let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), let data = context.data else { return false }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    var samples: [[Double]] = []
    var inked = false
    for index in 0..<(side * side) {
      let blue = Double(data.load(fromByteOffset: index * 4, as: UInt8.self)) / 255
      let green = Double(data.load(fromByteOffset: index * 4 + 1, as: UInt8.self)) / 255
      let red = Double(data.load(fromByteOffset: index * 4 + 2, as: UInt8.self)) / 255
      let alpha = Double(data.load(fromByteOffset: index * 4 + 3, as: UInt8.self)) / 255
      if alpha > 0 { inked = true }
      samples.append([red, green, blue, alpha])
    }
    guard inked else { return false }
    guard let flat = GlassFlowRules.uniform(samples) else { return true }
    return GlassFlowRules.acceptsUniform(flat, background: background(of: web))
  }

  private static func background(of web: WKWebView) -> [Double]? {
    let color = (web.underPageBackgroundColor ?? web.backgroundColor ?? .white).resolvedColor(with: web.traitCollection)
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
    return [Double(red * alpha), Double(green * alpha), Double(blue * alpha), Double(alpha)]
  }
}

extension PhonePages {
  func document(of webView: WKWebView) -> (committed: Int, route: Int, settled: Bool)? {
    guard let tab = pageIDList.lazy.compactMap({ self.page($0) }).first(where: { $0.webView === webView }) else { return nil }
    return (tab.committedDocuments, tab.sameDocumentNavigations, tab.hasCommittedLoad)
  }
}
