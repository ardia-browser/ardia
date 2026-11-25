import CoreGraphics
import Foundation
import QuartzCore

public final class GlassLayerTree: @unchecked Sendable {
  public let root: CALayer
  public let layers: Int

  init(root: CALayer, layers: Int) {
    self.root = root
    self.layers = layers
  }

  public func render(in context: CGContext) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.render(in: context)
    CATransaction.commit()
  }
}

public enum GlassLayerCopy {
  public static let layerBudget = 2000
  @MainActor public private(set) static var refused = ""

  public enum Refusal: Error, Equatable {
    case tooMany
    case unsafe
  }

  @MainActor
  public static func tree(of layer: CALayer, pixelsPerPoint: CGFloat = 1) -> Result<GlassLayerTree, Refusal> {
    var budget = layerBudget
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    do {
      let root = try copy(shown(layer), scale: max(pixelsPerPoint, 0.05), budget: &budget) ?? CALayer()
      return .success(GlassLayerTree(root: root, layers: layerBudget - budget))
    } catch {
      return .failure(error)
    }
  }

  static func shown(_ layer: CALayer) -> CALayer { layer.presentation() ?? layer }

  public static func drawsNothing(_ layer: CALayer) -> Bool {
    layer is CAMetalLayer || layer is CAEmitterLayer || NSStringFromClass(type(of: layer)).contains("Backdrop")
  }

  public static func refuses(_ layer: CALayer) -> Bool {
    layer is CAReplicatorLayer || layer is CATransformLayer || layer is CAScrollLayer || layer is CATiledLayer
  }

  public static func isPicture(_ contents: Any?) -> Bool {
    guard let contents else { return true }
    return CFGetTypeID(contents as CFTypeRef) == CGImage.typeID
  }

  @MainActor
  private static func copy(_ layer: CALayer, scale: CGFloat, budget: inout Int) throws(Refusal) -> CALayer? {
    guard budget > 0 else {
      refused = "more than \(layerBudget) layers"
      throw Refusal.tooMany
    }
    budget -= 1
    if refuses(layer) {
      refused = NSStringFromClass(type(of: layer))
      throw Refusal.unsafe
    }
    guard !drawsNothing(layer), !layer.isHidden, layer.opacity > 0 else { return nil }
    let made: CALayer
    switch layer {
    case let shape as CAShapeLayer: made = shapeCopy(shape)
    case let gradient as CAGradientLayer: made = gradientCopy(gradient)
    default: made = CALayer()
    }
    copyBase(layer, into: made)
    if layer.bounds.width > 0, layer.bounds.height > 0, layer is CATextLayer || !isPicture(layer.contents) {
      guard let picture = ownContents(of: layer, scale: scale) else {
        refused = "contents of \(NSStringFromClass(type(of: layer))) \(Int(layer.bounds.width))x\(Int(layer.bounds.height))"
        throw Refusal.unsafe
      }
      made.contents = picture
      made.contentsRect = CGRect(x: 0, y: 0, width: 1, height: 1)
      made.contentsCenter = CGRect(x: 0, y: 0, width: 1, height: 1)
      made.contentsGravity = .resize
    }
    if let mask = layer.mask {
      guard let copied = try copy(mask, scale: scale, budget: &budget) else {
        refused = "mask \(NSStringFromClass(type(of: mask)))"
        throw Refusal.unsafe
      }
      made.mask = copied
    }
    for sublayer in layer.sublayers ?? [] {
      if let copied = try copy(sublayer, scale: scale, budget: &budget) { made.addSublayer(copied) }
    }
    return made
  }

  @MainActor
  private static func ownContents(of layer: CALayer, scale: CGFloat) -> CGImage? {
    let bounds = layer.bounds
    let width = max(Int((bounds.width * scale).rounded(.up)), 1)
    let height = max(Int((bounds.height * scale).rounded(.up)), 1)
    guard bounds.width > 0, bounds.height > 0, width <= 4096, height <= 4096, let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    let own: CALayer
    if let text = layer as? CATextLayer {
      own = textCopy(text)
    } else {
      own = CALayer()
      own.contents = layer.contents
      own.contentsRect = layer.contentsRect
      own.contentsCenter = layer.contentsCenter
      own.contentsGravity = layer.contentsGravity
      own.contentsScale = layer.contentsScale
      own.isGeometryFlipped = layer.isGeometryFlipped
    }
    own.bounds = bounds
    #if os(iOS)
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: CGFloat(width) / bounds.width, y: -CGFloat(height) / bounds.height)
    #else
    context.scaleBy(x: CGFloat(width) / bounds.width, y: CGFloat(height) / bounds.height)
    #endif
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    own.render(in: context)
    return context.makeImage()
  }

  private static func copyBase(_ layer: CALayer, into made: CALayer) {
    made.bounds = layer.bounds
    made.position = layer.position
    made.anchorPoint = layer.anchorPoint
    made.anchorPointZ = layer.anchorPointZ
    made.zPosition = layer.zPosition
    made.transform = layer.transform
    made.sublayerTransform = layer.sublayerTransform
    made.isGeometryFlipped = layer.isGeometryFlipped
    made.isDoubleSided = layer.isDoubleSided
    if isPicture(layer.contents) { made.contents = layer.contents }
    made.contentsRect = layer.contentsRect
    made.contentsCenter = layer.contentsCenter
    made.contentsGravity = layer.contentsGravity
    made.contentsScale = layer.contentsScale
    made.minificationFilter = layer.minificationFilter
    made.magnificationFilter = layer.magnificationFilter
    made.masksToBounds = layer.masksToBounds
    made.cornerRadius = layer.cornerRadius
    made.maskedCorners = layer.maskedCorners
    made.cornerCurve = layer.cornerCurve
    made.borderWidth = layer.borderWidth
    made.borderColor = layer.borderColor
    made.backgroundColor = layer.backgroundColor
    made.opacity = layer.opacity
    made.isOpaque = layer.isOpaque
    made.allowsEdgeAntialiasing = layer.allowsEdgeAntialiasing
    made.edgeAntialiasingMask = layer.edgeAntialiasingMask
    made.shadowColor = layer.shadowColor
    made.shadowOpacity = layer.shadowOpacity
    made.shadowOffset = layer.shadowOffset
    made.shadowRadius = layer.shadowRadius
    made.shadowPath = layer.shadowPath
  }

  private static func shapeCopy(_ shape: CAShapeLayer) -> CAShapeLayer {
    let made = CAShapeLayer()
    made.path = shape.path
    made.fillColor = shape.fillColor
    made.fillRule = shape.fillRule
    made.strokeColor = shape.strokeColor
    made.strokeStart = shape.strokeStart
    made.strokeEnd = shape.strokeEnd
    made.lineWidth = shape.lineWidth
    made.miterLimit = shape.miterLimit
    made.lineCap = shape.lineCap
    made.lineJoin = shape.lineJoin
    made.lineDashPhase = shape.lineDashPhase
    made.lineDashPattern = shape.lineDashPattern
    return made
  }

  private static func gradientCopy(_ gradient: CAGradientLayer) -> CAGradientLayer {
    let made = CAGradientLayer()
    made.colors = gradient.colors
    made.locations = gradient.locations
    made.startPoint = gradient.startPoint
    made.endPoint = gradient.endPoint
    made.type = gradient.type
    return made
  }

  @MainActor
  private static func textCopy(_ text: CATextLayer) -> CATextLayer {
    let made = CATextLayer()
    made.string = text.string
    made.font = text.font
    made.fontSize = text.fontSize
    made.foregroundColor = text.foregroundColor
    made.isWrapped = text.isWrapped
    made.truncationMode = text.truncationMode
    made.alignmentMode = text.alignmentMode
    return made
  }
}
