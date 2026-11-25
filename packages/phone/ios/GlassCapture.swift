import ArdiaDesign
import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassCapture {
  enum Outcome {
    case captured
    case started
    case failed
    case waiting
  }

  private struct Landed {
    let pixels: CVPixelBuffer
    let rect: CGRect
    let valid: CGRect
    let inked: Bool
    let ms: Double
    let askedAt: CFTimeInterval
    let follow: (web: WKWebView, offset: CGPoint)?
  }

  private static let queue = DispatchQueue(label: "ardia.glass.capture", qos: .userInitiated)
  private static let largest = 4096

  private(set) var texture: MTLTexture?
  private(set) var rect: CGRect = .null
  private(set) var validRect: CGRect = .null
  private(set) var generation = 0
  private(set) var failures = 0
  private var retryAt: CFTimeInterval = 0
  private var signature: Int?
  private var settle = 0
  private var capturedAt: CFTimeInterval = 0
  private var pool: CVPixelBufferPool?
  private var poolSize: (Int, Int) = (0, 0)
  private var outputs: [MTLTexture] = []
  private var outputIndex = 0
  private var token = 0
  private var flying = false
  private var landed: Landed?
  private(set) var lastTiming: (ms: Double, offMain: Bool) = (0, false)
  var probe: ((CVPixelBuffer) -> Void)?
  private var samples: [LiquidGlassRules.CaptureSample] = []
  private var quiet = 0
  let page = GlassPageShot()

  private var warmed: Bool
  private weak var scrollWeb: WKWebView?

  init(warmed: Bool = false) {
    self.warmed = warmed
  }
  private var capturedScroll: CGPoint = .zero

  func follow(_ web: WKWebView?) {
    scrollWeb = web
    pageFollow.installed(following: web != nil)
    capturedScroll = web?.scrollView.contentOffset ?? .zero
  }

  var velocity: CGPoint { scrollWeb == nil ? .zero : page.velocity }

  private var pageFollow = GlassPageFollow()

  func dropsPageCapture(shiftable: Bool) -> Bool { pageFollow.dropsCapture(shiftable: shiftable) }

  var travel: ClosedRange<CGFloat>? {
    guard let scroll = scrollWeb?.scrollView else { return nil }
    let top = -scroll.adjustedContentInset.top
    let bottom = max(scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom, top)
    let now = scroll.contentOffset.y
    return min(top - now, 0)...max(bottom - now, 0)
  }

  var scrollShift: CGPoint {
    guard let web = scrollWeb else { return .zero }
    return CGPoint(x: web.scrollView.contentOffset.x - capturedScroll.x, y: web.scrollView.contentOffset.y - capturedScroll.y)
  }
  var wholeMethod: GlassLaunch.Capture = .layer

  var strikes = 1
  var tone = GlassToneGate()

  func overBudget(now: CFTimeInterval, frameMs: Double) -> Bool { LiquidGlassRules.overBudget(samples, now: now, frameMs: frameMs, strikes: strikes) || page.isOverBudget(now: now) }

  func forgetSamples() {
    samples = []
  }

  func noteMainThread(ms: Double, now: CFTimeInterval, captured: Bool) {
    samples = LiquidGlassRules.recentSamples(samples, now: now) + [LiquidGlassRules.CaptureSample(at: now, ms: ms, cold: captured && !warmed)]
    if captured { warmed = true }
  }

  var isChanging: Bool { settle > 0 }
  var motion = GlassMotionHold()
  var wasHeld = false

  func drop() {
    token += 1
    flying = false
    landed = nil
    scrollWeb = nil
    pageFollow.dropped()
    guard texture != nil else { return }
    texture = nil
    rect = .null
    validRect = .null
    generation += 1
  }

  private(set) var signatureValue = 0

  func survey(_ pieces: [GlassLayerPiece], rect wanted: CGRect, shiftable: Bool = true) {
    var hasher = Hasher()
    var budget = 1500
    let depth = LiquidGlassRules.backdropWalkDepth
    hasher.combine(wanted.minX.rounded())
    hasher.combine(wanted.minY.rounded())
    hasher.combine(wanted.width.rounded())
    hasher.combine(wanted.height.rounded())
    for piece in pieces {
      for value in [piece.transform.a, piece.transform.b, piece.transform.c, piece.transform.d, piece.transform.tx, piece.transform.ty, piece.alpha] { hasher.combine(value) }
      if let web = piece.page {
        if !shiftable {
          hasher.combine(web.scrollView.contentOffset.x)
          hasher.combine(web.scrollView.contentOffset.y)
        }
        hasher.combine(web.scrollView.zoomScale)
        hasher.combine(page.generation)
      } else if let view = piece.view {
        if let contents = view.layer.contents { hasher.combine(ObjectIdentifier(contents as AnyObject)) }
        for sublayer in view.layer.sublayers ?? [] { Self.walk(sublayer, into: &hasher, budget: &budget, depth: depth) }
      }
    }
    note(hasher.finalize())
  }

  private func note(_ value: Int) {
    signatureValue = value
    if value != signature {
      signature = value
      settle = LiquidGlassRules.settleFrames
      quiet = 0
    } else {
      quiet += 1
    }
  }

  func wants(_ wanted: CGRect, need: CGRect? = nil, now: CFTimeInterval, gap: TimeInterval = 0) -> Bool {
    if now < retryAt || flying { return false }
    if texture == nil { return true }
    if let need {
      if GlassFlowRules.recenters(held: validRect.offsetBy(dx: -scrollShift.x, dy: -scrollShift.y), offer: wanted, need: need) { return true }
    } else if !rect.contains(wanted) || rect.width > wanted.width * 1.5 + 64 || rect.height > wanted.height * 1.5 + 64 {
      return true
    }
    if settle > 0 { return GlassFlowRules.recaptureNow(changed: true, quietFrames: quiet, sinceCapture: now - capturedAt, gap: gap) }
    return now - capturedAt > LiquidGlassRules.idleRefresh
  }

  func capture(rect wanted: CGRect, pixelsPerPoint: CGFloat, sigma: Double, blurs: inout [GlassBlurJob], now: CFTimeInterval, draw: (CGContext) -> Bool) -> Outcome {
    if now < retryAt { return .waiting }
    let started = CACurrentMediaTime()
    let width = max(Int((wanted.width * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    let height = max(Int((wanted.height * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    guard width <= Self.largest, height <= Self.largest else { return fail(now) }
    let captured = CGRect(x: wanted.minX, y: wanted.minY, width: CGFloat(width) / pixelsPerPoint, height: CGFloat(height) / pixelsPerPoint)
    guard let pixels = makeBuffer(width: width, height: height) else { return fail(now) }
    guard CVPixelBufferLockBaseAddress(pixels, []) == kCVReturnSuccess else { return fail(now) }
    guard let base = CVPixelBufferGetBaseAddress(pixels), let context = CGContext(data: base, width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
      CVPixelBufferUnlockBaseAddress(pixels, [])
      return fail(now)
    }
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .low
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: pixelsPerPoint, y: -pixelsPerPoint)
    context.translateBy(x: -captured.minX, y: -captured.minY)
    UIGraphicsPushContext(context)
    let drew = draw(context)
    UIGraphicsPopContext()
    let inked = drew && Self.hasInk(base, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), width: width, height: height)
    CVPixelBufferUnlockBaseAddress(pixels, [])
    token += 1
    flying = false
    landed = nil
    guard inked, install(pixels, rect: captured, valid: wanted, sigma: sigma, blurs: &blurs, at: now) else { return fail(now) }
    lastTiming = ((CACurrentMediaTime() - started) * 1000, false)
    return .captured
  }

  func start(rect wanted: CGRect, pixelsPerPoint: CGFloat, now: CFTimeInterval, steps: GlassSteps, follow web: WKWebView?) -> Outcome {
    if now < retryAt || flying { return .waiting }
    let width = max(Int((wanted.width * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    let height = max(Int((wanted.height * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    guard width <= Self.largest, height <= Self.largest, let pixels = makeBuffer(width: width, height: height) else { return fail(now) }
    let captured = CGRect(x: wanted.minX, y: wanted.minY, width: CGFloat(width) / pixelsPerPoint, height: CGFloat(height) / pixelsPerPoint)
    token += 1
    let token = self.token
    flying = true
    let follow = web.map { (web: $0, offset: $0.scrollView.contentOffset) }
    let box = GlassPixels(pixels)
    let slow = GlassLaunch.slowCopy
    Self.queue.async {
      let started = CACurrentMediaTime()
      if slow > 0 { Thread.sleep(forTimeInterval: slow) }
      let inked = Self.render(steps, into: box.pixels, rect: captured, pixelsPerPoint: pixelsPerPoint)
      let ms = (CACurrentMediaTime() - started) * 1000
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard token == self.token else {
            if PhoneTestBuild.isOn { NSLog("PAGELAB glass copy dropped: the document or capture changed while it was drawn") }
            return
          }
          self.flying = false
          self.landed = Landed(pixels: box.pixels, rect: captured, valid: wanted, inked: inked, ms: ms, askedAt: now, follow: follow)
          GlassFrames.shared.schedule()
        }
      }
    }
    return .started
  }

  func land(sigma: Double, blurs: inout [GlassBlurJob], now: CFTimeInterval) -> Outcome? {
    guard let landed else { return nil }
    self.landed = nil
    lastTiming = (landed.ms, true)
    probe?(landed.pixels)
    guard landed.inked, install(landed.pixels, rect: landed.rect, valid: landed.valid, sigma: sigma, blurs: &blurs, at: landed.askedAt) else { return fail(now) }
    scrollWeb = landed.follow?.web
    pageFollow.installed(following: landed.follow != nil)
    capturedScroll = landed.follow?.offset ?? .zero
    return .captured
  }

  private func install(_ pixels: CVPixelBuffer, rect captured: CGRect, valid: CGRect, sigma: Double, blurs: inout [GlassBlurJob], at time: CFTimeInterval) -> Bool {
    guard let (input, holder) = GlassMetal.shared.texture(of: pixels), let blurred = nextOutput(like: input), let blur = GlassMetal.shared.blur(sigma: sigma) else { return false }
    GlassMetal.shared.flushTextures()
    blurs.append(GlassBlurJob(kernel: blur, source: input, target: blurred, holder: holder))
    texture = blurred
    rect = captured
    validRect = valid.intersection(captured)
    generation += 1
    failures = 0
    retryAt = 0
    capturedAt = time
    settle = max(settle - 1, 0)
    return true
  }

  nonisolated private static func render(_ steps: GlassSteps, into pixels: CVPixelBuffer, rect captured: CGRect, pixelsPerPoint: CGFloat) -> Bool {
    guard CVPixelBufferLockBaseAddress(pixels, []) == kCVReturnSuccess else { return false }
    defer { CVPixelBufferUnlockBaseAddress(pixels, []) }
    let width = CVPixelBufferGetWidth(pixels)
    let height = CVPixelBufferGetHeight(pixels)
    guard let base = CVPixelBufferGetBaseAddress(pixels), let context = CGContext(data: base, width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .low
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: pixelsPerPoint, y: -pixelsPerPoint)
    context.translateBy(x: -captured.minX, y: -captured.minY)
    steps.draw(in: context)
    return hasInk(base, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), width: width, height: height)
  }


  func release() {
    page.release()
    token += 1
    flying = false
    landed = nil
    texture = nil
    outputs = []
    rect = .null
    validRect = .null
    pool = nil
    poolSize = (0, 0)
    signature = nil
    generation += 1
  }

  private func fail(_ now: CFTimeInterval) -> Outcome {
    failures += 1
    retryAt = now + LiquidGlassRules.captureRetryDelay(failures: failures)
    texture = nil
    rect = .null
    validRect = .null
    generation += 1
    return .failed
  }

  static func draw(_ view: UIView, method: GlassLaunch.Capture, context: CGContext) -> Bool {
    switch method {
    case .hierarchy:
      return view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
    case .layer, .auto:
      view.layer.render(in: context)
      return true
    case .none:
      return false
    }
  }

  nonisolated private static func hasInk(_ base: UnsafeMutableRawPointer, bytesPerRow: Int, width: Int, height: Int) -> Bool {
    for row in stride(from: 0, to: height, by: 2) {
      let line = base.advanced(by: row * bytesPerRow)
      for column in stride(from: 0, to: width, by: 2) where line.load(fromByteOffset: column * 4 + 3, as: UInt8.self) > 0 { return true }
    }
    return false
  }

  private func makeBuffer(width: Int, height: Int) -> CVPixelBuffer? {
    if pool == nil || poolSize != (width, height) {
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferMetalCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      ]
      var made: CVPixelBufferPool?
      CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 3] as CFDictionary, attributes as CFDictionary, &made)
      pool = made
      poolSize = (width, height)
      outputs = []
    }
    guard let pool else { return nil }
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess else { return nil }
    return buffer
  }

  private func nextOutput(like input: MTLTexture) -> MTLTexture? {
    if outputs.first.map({ $0.width != input.width || $0.height != input.height }) ?? false { outputs = [] }
    outputIndex = (outputIndex + 1) % 2
    if outputIndex < outputs.count { return outputs[outputIndex] }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: input.width, height: input.height, mipmapped: false)
    descriptor.usage = [.shaderRead, .shaderWrite]
    descriptor.storageMode = .private
    guard let made = GlassMetal.shared.device?.makeTexture(descriptor: descriptor) else { return nil }
    outputs.append(made)
    outputIndex = outputs.count - 1
    return made
  }

  private static func walk(_ layer: CALayer, into hasher: inout Hasher, budget: inout Int, depth: Int) {
    guard budget > 0, depth > 0 else { return }
    budget -= 1
    let shown = layer.presentation() ?? layer
    if shown.isHidden || shown.opacity <= 0 {
      hasher.combine(0)
      return
    }
    hasher.combine(shown.position.x)
    hasher.combine(shown.position.y)
    hasher.combine(shown.bounds.origin.x)
    hasher.combine(shown.bounds.origin.y)
    hasher.combine(shown.bounds.width)
    hasher.combine(shown.bounds.height)
    hasher.combine(shown.opacity)
    hasher.combine(shown.zPosition)
    let transform = shown.transform
    hasher.combine(transform.m11)
    hasher.combine(transform.m12)
    hasher.combine(transform.m21)
    hasher.combine(transform.m22)
    hasher.combine(transform.m41)
    hasher.combine(transform.m42)
    if let contents = layer.contents { hasher.combine(ObjectIdentifier(contents as AnyObject)) }
    hasher.combine(layer.backgroundColor.map { CFHash($0) } ?? 0)
    if let web = layer.delegate as? WKWebView {
      hasher.combine(web.scrollView.contentOffset.x)
      hasher.combine(web.scrollView.contentOffset.y)
      return
    }
    for sublayer in layer.sublayers ?? [] { walk(sublayer, into: &hasher, budget: &budget, depth: depth - 1) }
  }
}

final class GlassPixels: @unchecked Sendable {
  let pixels: CVPixelBuffer

  init(_ pixels: CVPixelBuffer) {
    self.pixels = pixels
  }
}
