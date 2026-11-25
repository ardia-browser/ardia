import ArdiaDesign
import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore
import UIKit
import WebKit

enum GlassLaunch {
  enum Capture: String {
    case auto
    case hierarchy
    case layer
    case none
  }

  static let flat = PhoneTestBuild.flag("ArdiaFlatGlass")
  static let solidPage = PhoneTestBuild.flag("ArdiaGlassSolidPage")
  static let snapshotAfterUpdates = !PhoneTestBuild.flag("ArdiaGlassSnapshotVisible")

  enum PageMode: String {
    case shift
    case full
  }

  static let pageMode: PageMode = PhoneTestBuild.isOn ? (UserDefaults.standard.string(forKey: "ArdiaGlassPageMode").flatMap(PageMode.init(rawValue:)) ?? .shift) : .shift
  static let capture: Capture = PhoneTestBuild.isOn ? (UserDefaults.standard.string(forKey: "ArdiaGlassCapture").flatMap(Capture.init(rawValue:)) ?? .auto) : .auto
  static let offMain = !PhoneTestBuild.flag("ArdiaGlassOnMain")
  static let movingSnapshots = PhoneTestBuild.flag("ArdiaGlassMovingSnapshots")
  static let forceClear = PhoneTestBuild.flag("ArdiaGlassForceClear")
  static let copyProbe = PhoneTestBuild.flag("ArdiaGlassCopyProbe")
  static let placementProbe = PhoneTestBuild.flag("ArdiaGlassPlacementProbe")
  static let slowCopy = PhoneTestBuild.isOn ? (UserDefaults.standard.object(forKey: "ArdiaGlassSlowCopy").flatMap { Double(String(describing: $0)) } ?? 0) : 0

  enum PageShot: String {
    case pdf
    case snapshot
  }

  static let pageShot: PageShot = PhoneTestBuild.isOn ? (UserDefaults.standard.string(forKey: "ArdiaGlassPageShot").flatMap(PageShot.init(rawValue:)) ?? .pdf) : .pdf
}

enum GlassReport {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var failed = false
  static let hasDevice = MTLCreateSystemDefaultDevice() != nil

  static var shaderFailed: Bool {
    get { lock.withLock { failed } }
    set { lock.withLock { failed = newValue } }
  }

  static func render(classic: Bool) -> LiquidGlassRules.Render {
    LiquidGlassRules.render(classic: classic, flat: GlassLaunch.flat, metal: hasDevice, lensFailed: shaderFailed)
  }
}

@MainActor
final class GlassMetal {
  static let shared = GlassMetal()

  let device = MTLCreateSystemDefaultDevice()
  private(set) lazy var queue = device?.makeCommandQueue()
  private(set) var pipeline: MTLRenderPipelineState?
  private(set) var failures = 0
  private var compiling = false
  private var textureCache: CVMetalTextureCache?
  private var blurs: [Double: MPSImageGaussianBlur] = [:]
  var onFailed: (() -> Void)?

  var isReady: Bool { pipeline != nil }

  func prepare() {
    guard pipeline == nil, !compiling, failures == 0, let device else { return }
    compiling = true
    let source = LiquidGlassShader.source
    Task.detached(priority: .userInitiated) {
      let made: Result<MTLRenderPipelineState, Error> = Result {
        let library = try device.makeLibrary(source: source, options: nil)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: LiquidGlassShader.vertexName)
        descriptor.fragmentFunction = library.makeFunction(name: LiquidGlassShader.fragmentName)
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        return try device.makeRenderPipelineState(descriptor: descriptor)
      }
      await MainActor.run { GlassMetal.shared.finish(made) }
    }
  }

  private func finish(_ made: Result<MTLRenderPipelineState, Error>) {
    compiling = false
    switch made {
    case .success(let state):
      pipeline = state
      GlassReport.shaderFailed = false
    case .failure(let error):
      failures += 1
      GlassReport.shaderFailed = true
      onFailed?()
      NSLog("PAGELAB look glass shader failed and is skipped until the app returns: %@", String(describing: error))
    }
    GlassFrames.shared.metalChanged()
  }

  func retryFailed() {
    guard failures > 0, pipeline == nil, !compiling else { return }
    failures = 0
    prepare()
  }

  func texture(of buffer: CVPixelBuffer) -> (MTLTexture, CVMetalTexture)? {
    guard let device else { return nil }
    if textureCache == nil { CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache) }
    guard let textureCache else { return nil }
    var made: CVMetalTexture?
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    guard CVMetalTextureCacheCreateTextureFromImage(nil, textureCache, buffer, nil, .bgra8Unorm, width, height, 0, &made) == kCVReturnSuccess, let made, let texture = CVMetalTextureGetTexture(made) else { return nil }
    return (texture, made)
  }

  func flushTextures() {
    if let textureCache { CVMetalTextureCacheFlush(textureCache, 0) }
  }

  func blur(sigma: Double) -> MPSImageGaussianBlur? {
    guard let device, sigma > 0 else { return nil }
    let key = (sigma * 100).rounded() / 100
    if let known = blurs[key] { return known }
    let made = MPSImageGaussianBlur(device: device, sigma: Float(key))
    made.edgeMode = .clamp
    blurs[key] = made
    return made
  }
}

@MainActor
enum GlassSources {
  private static let sources = NSMapTable<NSString, FrostSourceView>.strongToWeakObjects()

  static func register(_ name: String, _ view: FrostSourceView) {
    sources.setObject(view, forKey: name as NSString)
    GlassFrames.shared.sourcesChanged()
  }

  static func unregister(_ name: String, _ view: FrostSourceView) {
    if sources.object(forKey: name as NSString) === view { sources.removeObject(forKey: name as NSString) }
    GlassFrames.shared.sourcesChanged()
  }

  static func find(_ name: String?) -> FrostSourceView? {
    name.flatMap { sources.object(forKey: $0 as NSString) }
  }

  private static var pages: [ObjectIdentifier: (holds: Bool, at: CFTimeInterval)] = [:]

  static func holdsPage(_ source: FrostSourceView) -> Bool {
    let now = CACurrentMediaTime()
    let key = ObjectIdentifier(source)
    if let known = pages[key], now - known.at < LiquidGlassRules.pageCheckInterval { return known.holds }
    let holds = walkForPage(source)
    pages[key] = (holds, now)
    if pages.count > 16 { pages = pages.filter { now - $0.value.at < 1 } }
    return holds
  }

  static let pageSource = "page"

  static func holdsPage(in source: UIView) -> Bool {
    (source as? FrostSourceView).map(holdsPage) ?? false
  }

  static func page(in view: UIView) -> WKWebView? {
    if view.isHidden || view.alpha <= 0 { return nil }
    if let web = view as? WKWebView { return web.bounds.width > 0 && web.bounds.height > 0 ? web : nil }
    return view.subviews.lazy.compactMap(page).max { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }
  }

  private static func walkForPage(_ view: UIView) -> Bool {
    if view.isHidden || view.alpha <= 0 { return false }
    if view is WKWebView { return view.bounds.width > 0 && view.bounds.height > 0 }
    return view.subviews.contains(where: walkForPage)
  }
}
