import ArdiaDesign
import QuartzCore
import UIKit
import WebKit

struct GlassClip {
  let transform: CGAffineTransform
  let bounds: CGRect
  let radius: CGFloat

  var path: CGPath {
    var transform = transform
    let radius = min(self.radius, min(bounds.width, bounds.height) / 2)
    return CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: &transform)
  }

  var outerRect: CGRect { bounds.applying(transform) }

  var solidRect: CGRect {
    let scaled = radius * max(abs(transform.a), abs(transform.d))
    return outerRect.insetBy(dx: scaled, dy: scaled)
  }
}

struct GlassLayerPiece {
  let view: UIView?
  let page: WKWebView?
  let transform: CGAffineTransform
  let bounds: CGRect
  let radius: CGFloat
  let fill: CGColor?
  let alpha: CGFloat
  let clips: [GlassClip]
  let masked: Bool

  init(view: UIView?, page: WKWebView? = nil, transform: CGAffineTransform, bounds: CGRect, radius: CGFloat, fill: CGColor?, alpha: CGFloat, clips: [GlassClip], masked: Bool = false) {
    self.view = view
    self.page = page
    self.transform = transform
    self.bounds = bounds
    self.radius = radius
    self.fill = fill
    self.alpha = alpha
    self.clips = clips
    self.masked = masked
  }

  var axisAligned: Bool { transform.b == 0 && transform.c == 0 }

  var coverage: GlassStacking.Coverage {
    let opaque = GlassStacking.coversOpaquely(isPage: page != nil, alpha: Double(alpha), fillAlpha: Double(fill?.alpha ?? 0), masked: masked)
    return GlassStacking.Coverage(rect: bounds.applying(transform), radius: radius * max(abs(transform.a), abs(transform.d)), axisAligned: axisAligned, opaque: opaque, clips: clips.map(\.solidRect))
  }
}

@MainActor
enum GlassBackdrop {
  static func space(for surface: LiquidGlassSurface) -> UIView? {
    switch surface.backdropMode {
    case .source: surface.backdropSource
    case .beneath: surface.backdropRoot
    case nil: nil
    }
  }

  @MainActor
  private struct Walk {
    let root: CALayer
    let usesPresentation: Bool
    let wanted: CGRect
    let web: WKWebView?

    func shown(_ view: UIView) -> CALayer? { usesPresentation ? view.layer.presentation() : view.layer }

    func expand(_ view: UIView, clips: [GlassClip], alpha: CGFloat) -> [GlassLayerPiece] {
      guard !view.isHidden, let layer = shown(view), !layer.isHidden, layer.opacity > 0.01 else { return [] }
      let reach = GlassStacking.reach(bounds: layer.bounds, clips: layer.masksToBounds, children: (layer.sublayers ?? []).map(\.frame))
      guard !reach.isNull, !reach.isEmpty else { return [] }
      let place = GlassBackdrop.transform(of: layer, to: root)
      let visible = clips.reduce(root.bounds) { $0.intersection($1.outerRect) }
      let area = reach.applying(place).intersection(visible)
      guard !area.isNull, area.intersects(wanted) else { return [] }
      let shownAlpha = alpha * CGFloat(layer.opacity)
      if let web, view === web {
        return [GlassLayerPiece(view: nil, page: web, transform: place, bounds: layer.bounds, radius: layer.cornerRadius, fill: nil, alpha: shownAlpha, clips: clips)]
      }
      guard let web, web.isDescendant(of: view) else {
        return [GlassLayerPiece(view: view, transform: place, bounds: layer.bounds, radius: layer.cornerRadius, fill: layer.backgroundColor, alpha: shownAlpha, clips: clips, masked: layer.mask != nil)]
      }
      var pieces: [GlassLayerPiece] = []
      if let fill = layer.backgroundColor, fill.alpha > 0 {
        pieces.append(GlassLayerPiece(view: nil, transform: place, bounds: layer.bounds, radius: layer.cornerRadius, fill: fill, alpha: shownAlpha, clips: clips, masked: layer.mask != nil))
      }
      let inner = layer.masksToBounds ? clips + [GlassClip(transform: place, bounds: layer.bounds, radius: layer.cornerRadius)] : clips
      let subviews = view.subviews
      let order = GlassStacking.drawOrder(subviews.enumerated().map { GlassStacking.Sibling(index: $0.offset, zPosition: Double((shown($0.element) ?? $0.element.layer).zPosition)) })
      for sibling in order { pieces += expand(subviews[sibling.index], clips: inner, alpha: shownAlpha) }
      return pieces
    }
  }

  static func pieces(of source: UIView, covering wanted: CGRect, web: WKWebView?) -> [GlassLayerPiece] {
    let usesPresentation = source.layer.presentation() != nil
    guard let root = usesPresentation ? source.layer.presentation() : source.layer else { return [] }
    guard let web else { return [GlassLayerPiece(view: source, transform: .identity, bounds: source.bounds, radius: 0, fill: nil, alpha: 1, clips: [])] }
    let walk = Walk(root: root, usesPresentation: usesPresentation, wanted: wanted, web: web)
    var pieces: [GlassLayerPiece] = []
    if let fill = root.backgroundColor, fill.alpha > 0 {
      pieces.append(GlassLayerPiece(view: nil, transform: .identity, bounds: root.bounds, radius: 0, fill: fill, alpha: 1, clips: [], masked: root.mask != nil))
    }
    let subviews = source.subviews
    let order = GlassStacking.drawOrder(subviews.enumerated().map { GlassStacking.Sibling(index: $0.offset, zPosition: Double((walk.shown($0.element) ?? $0.element.layer).zPosition)) })
    for sibling in order { pieces += walk.expand(subviews[sibling.index], clips: [], alpha: 1) }
    return floored(pieces, covering: wanted)
  }

  static func pieces(under glass: UIView, root: UIView, covering wanted: CGRect, web: WKWebView?) -> [GlassLayerPiece] {
    var chain: [UIView] = []
    var current: UIView? = glass
    while let view = current {
      chain.append(view)
      if view === root { break }
      current = view.superview
    }
    guard chain.last === root, chain.count > 1 else { return [] }
    let usesPresentation = chain.allSatisfy { $0.layer.presentation() != nil }
    guard let rootLayer = usesPresentation ? root.layer.presentation() : root.layer else { return [] }
    let walk = Walk(root: rootLayer, usesPresentation: usesPresentation, wanted: wanted, web: web)
    var pieces: [GlassLayerPiece] = []
    var clips: [GlassClip] = []
    var alpha: CGFloat = 1
    for level in stride(from: chain.count - 1, to: 0, by: -1) {
      let parent = chain[level]
      let child = chain[level - 1]
      guard let parentLayer = walk.shown(parent), !parentLayer.isHidden else { return [] }
      alpha *= CGFloat(parentLayer.opacity)
      let parentTransform = transform(of: parentLayer, to: rootLayer)
      if let fill = parentLayer.backgroundColor, fill.alpha > 0 {
        pieces.append(GlassLayerPiece(view: nil, transform: parentTransform, bounds: parentLayer.bounds, radius: parentLayer.cornerRadius, fill: fill, alpha: alpha, clips: clips, masked: parentLayer.mask != nil))
      }
      if parentLayer.masksToBounds {
        clips.append(GlassClip(transform: parentTransform, bounds: parentLayer.bounds, radius: parentLayer.cornerRadius))
      }
      let subviews = parent.subviews
      guard let childIndex = subviews.firstIndex(where: { $0 === child }) else { return [] }
      let siblings = subviews.enumerated().map { GlassStacking.Sibling(index: $0.offset, zPosition: Double((walk.shown($0.element) ?? $0.element.layer).zPosition)) }
      for index in GlassStacking.below(siblings[childIndex], among: siblings) {
        pieces += walk.expand(subviews[index], clips: clips, alpha: alpha)
      }
    }
    return floored(pieces, covering: wanted)
  }

  private static func floored(_ pieces: [GlassLayerPiece], covering wanted: CGRect) -> [GlassLayerPiece] {
    guard let floor = GlassStacking.opaqueFloor(pieces.map(\.coverage), covering: wanted) else { return pieces }
    return Array(pieces.dropFirst(floor))
  }

  static func transform(of layer: CALayer, to root: CALayer) -> CGAffineTransform {
    let origin = layer.convert(CGPoint.zero, to: root)
    let across = layer.convert(CGPoint(x: 1, y: 0), to: root)
    let down = layer.convert(CGPoint(x: 0, y: 1), to: root)
    return CGAffineTransform(a: across.x - origin.x, b: across.y - origin.y, c: down.x - origin.x, d: down.y - origin.y, tx: origin.x, ty: origin.y)
  }

  static func draw(_ piece: GlassLayerPiece, method: GlassLaunch.Capture, page: GlassPageShot, in context: CGContext) -> Bool {
    context.saveGState()
    defer { context.restoreGState() }
    for clip in piece.clips {
      context.addPath(clip.path)
      context.clip()
    }
    if let web = piece.page {
      if piece.alpha < 1 { context.setAlpha(piece.alpha) }
      return page.draw(web, transform: piece.transform, in: context)
    }
    context.concatenate(piece.transform)
    guard let view = piece.view else {
      guard let fill = piece.fill else { return true }
      let radius = min(piece.radius, min(piece.bounds.width, piece.bounds.height) / 2)
      context.setAlpha(piece.alpha)
      context.setFillColor(fill)
      context.addPath(CGPath(roundedRect: piece.bounds, cornerWidth: radius, cornerHeight: radius, transform: nil))
      context.fillPath()
      return true
    }
    let alpha = piece.alpha / (GlassProbe.appliesOwnAlpha(method) ? max(CGFloat(view.layer.opacity), 0.01) : 1)
    let layered = alpha < 1
    if layered {
      context.setAlpha(alpha)
      context.beginTransparencyLayer(auxiliaryInfo: nil)
    }
    defer { if layered { context.endTransparencyLayer() } }
    return GlassCapture.draw(view, method: method, context: context)
  }
}

@MainActor
enum GlassProbe {
  private static var ownAlpha: [GlassLaunch.Capture: Bool] = [.hierarchy: true, .layer: true, .auto: true]

  static func appliesOwnAlpha(_ method: GlassLaunch.Capture) -> Bool { ownAlpha[method] ?? false }

  static func run(in window: UIWindow) {
    let probe = UIView(frame: CGRect(x: 0, y: 0, width: 8, height: 8))
    probe.backgroundColor = .red
    probe.alpha = 0.5
    probe.isUserInteractionEnabled = false
    window.addSubview(probe)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
      MainActor.assumeIsolated {
        var line = "PAGELAB glass probe"
        for method in [GlassLaunch.Capture.hierarchy, .layer] {
          let context = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
          context.translateBy(x: 0, y: 1)
          context.scaleBy(x: 1 / 8, y: -1 / 8)
          UIGraphicsPushContext(context)
          let drew = GlassCapture.draw(probe, method: method, context: context)
          UIGraphicsPopContext()
          let alpha = context.data.map { Double($0.load(fromByteOffset: 3, as: UInt8.self)) / 255 } ?? -1
          line += " \(method.rawValue): drew=\(drew ? "yes" : "no") own_alpha_pixel=\(String(format: "%.2f", alpha))"
        }
        probe.removeFromSuperview()
        NSLog("%@", line)
      }
    }
  }
}
