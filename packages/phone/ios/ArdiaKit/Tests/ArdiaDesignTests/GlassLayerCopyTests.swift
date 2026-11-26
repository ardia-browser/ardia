import ArdiaDesign
import CoreGraphics
import Foundation
import QuartzCore
import Testing

@MainActor
struct GlassLayerCopyTests {
  private static func scene() -> CALayer {
    let root = CALayer()
    root.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
    root.backgroundColor = CGColor(red: 0, green: 0, blue: 1, alpha: 1)
    let card = CALayer()
    card.frame = CGRect(x: 4, y: 4, width: 20, height: 20)
    card.backgroundColor = CGColor(red: 1, green: 0, blue: 0, alpha: 1)
    card.cornerRadius = 6
    card.masksToBounds = true
    let inner = CALayer()
    inner.frame = CGRect(x: 10, y: 10, width: 20, height: 20)
    inner.backgroundColor = CGColor(red: 0, green: 1, blue: 0, alpha: 1)
    card.addSublayer(inner)
    let shape = CAShapeLayer()
    shape.path = CGPath(ellipseIn: CGRect(x: 24, y: 24, width: 12, height: 12), transform: nil)
    shape.fillColor = CGColor(red: 1, green: 1, blue: 0, alpha: 1)
    shape.opacity = 0.5
    let masked = CALayer()
    masked.frame = CGRect(x: 26, y: 2, width: 12, height: 12)
    masked.backgroundColor = CGColor(red: 1, green: 0, blue: 1, alpha: 1)
    let mask = CALayer()
    mask.frame = CGRect(x: 0, y: 0, width: 6, height: 12)
    mask.backgroundColor = CGColor(red: 0, green: 0, blue: 0, alpha: 1)
    masked.mask = mask
    root.addSublayer(card)
    root.addSublayer(shape)
    root.addSublayer(masked)
    return root
  }

  nonisolated private static func pixels(_ draw: (CGContext) -> Void) -> [UInt8] {
    let context = CGContext(data: nil, width: 40, height: 40, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    draw(context)
    return Array(UnsafeBufferPointer(start: context.data!.assumingMemoryBound(to: UInt8.self), count: 160 * 40))
  }

  @Test func `the copy leaves the original tree alone and shares no layer with it`() throws {
    let root = Self.scene()
    let before = root.sublayers?.count
    let tree = try GlassLayerCopy.tree(of: root).get()
    #expect(root.sublayers?.count == before)
    #expect(root.sublayers?[0].sublayers?.count == 1)
    #expect(root.sublayers?[2].mask != nil)
    #expect(tree.layers == 6)
    let originals = Set((root.sublayers ?? []).map(ObjectIdentifier.init))
    #expect((tree.root.sublayers ?? []).allSatisfy { !originals.contains(ObjectIdentifier($0)) })
    #expect(tree.root.sublayers?.first?.delegate == nil)
  }

  @Test func `the copy renders on another thread exactly as the original renders on main`() async throws {
    let root = Self.scene()
    let expected = Self.pixels { root.render(in: $0) }
    let tree = try GlassLayerCopy.tree(of: root).get()
    let rendered = await Task.detached { Self.pixels { tree.render(in: $0) } }.value
    let differing = (0..<1600).filter { index in (0..<4).contains { rendered[index * 4 + $0] != expected[index * 4 + $0] } }
    #expect(differing.isEmpty, "\(differing.count) pixels differ, first at \(differing.first.map { ($0 % 40, $0 / 40) } as Any): \(differing.first.map { Array(rendered[$0 * 4..<$0 * 4 + 4]) } as Any) vs \(differing.first.map { Array(expected[$0 * 4..<$0 * 4 + 4]) } as Any) samples \(differing.prefix(12).map { ($0 % 40, $0 / 40) })")
  }

  private static func difference(_ one: [UInt8], _ other: [UInt8]) -> (mean: Double, worst: Int) {
    var total = 0
    var worst = 0
    for (a, b) in zip(one, other) {
      let gap = abs(Int(a) - Int(b))
      total += gap
      worst = max(worst, gap)
    }
    return (Double(total) / Double(max(one.count, 1)), worst)
  }

  private static func picture(_ color: CGColor) -> CGImage {
    let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    context.setFillColor(color)
    context.fill(CGRect(x: 0, y: 0, width: 8, height: 4))
    return context.makeImage()!
  }

  private static func contentsOnlyPictures(_ layer: CALayer) -> Bool {
    GlassLayerCopy.isPicture(layer.contents) && (layer.mask.map(contentsOnlyPictures) ?? true) && (layer.sublayers ?? []).allSatisfy(contentsOnlyPictures)
  }

  final class Drawn: CALayer {
    override func draw(in context: CGContext) {
      context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1))
      context.fill(CGRect(x: 2, y: 2, width: 12, height: 6))
    }
  }

  @Test func `text, pictures, drawn layers and masks render off main as they do on main, and only pictures cross over`() async throws {
    let root = CALayer()
    root.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
    root.backgroundColor = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
    let text = CATextLayer()
    text.frame = CGRect(x: 2, y: 2, width: 36, height: 14)
    text.string = "Hi"
    text.fontSize = 12
    text.foregroundColor = CGColor(red: 0, green: 0, blue: 0, alpha: 1)
    text.contentsScale = 1
    let image = CALayer()
    image.frame = CGRect(x: 2, y: 20, width: 16, height: 16)
    image.contents = Self.picture(CGColor(red: 0.9, green: 0.1, blue: 0.1, alpha: 1))
    let drawn = Drawn()
    drawn.frame = CGRect(x: 20, y: 20, width: 16, height: 10)
    drawn.contentsScale = 1
    drawn.setNeedsDisplay()
    drawn.displayIfNeeded()
    let shapeMasked = CALayer()
    shapeMasked.frame = CGRect(x: 20, y: 30, width: 16, height: 8)
    shapeMasked.backgroundColor = CGColor(red: 0, green: 0, blue: 1, alpha: 1)
    let shape = CAShapeLayer()
    shape.path = CGPath(rect: CGRect(x: 0, y: 0, width: 8, height: 8), transform: nil)
    shapeMasked.mask = shape
    let pictureMasked = CALayer()
    pictureMasked.frame = CGRect(x: 2, y: 36, width: 16, height: 4)
    pictureMasked.backgroundColor = CGColor(red: 1, green: 0.5, blue: 0, alpha: 1)
    let pictureMask = CALayer()
    pictureMask.frame = pictureMasked.bounds
    pictureMask.contents = Self.picture(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    pictureMasked.mask = pictureMask
    for layer in [text, image, drawn, shapeMasked, pictureMasked] { root.addSublayer(layer) }
    #expect(!GlassLayerCopy.isPicture(drawn.contents), "a drawn layer holds a backing store, not a picture")
    let expected = Self.pixels { root.render(in: $0) }
    let tree = try GlassLayerCopy.tree(of: root).get()
    #expect(Self.contentsOnlyPictures(tree.root))
    let rendered = await Task.detached { Self.pixels { tree.render(in: $0) } }.value
    let gap = Self.difference(rendered, expected)
    #expect(gap.mean < 1.5, "mean difference \(gap.mean), worst \(gap.worst)")
  }

  @Test func `a layer with no size draws nothing of its own, so its contents never refuse the copy`() throws {
    let root = CALayer()
    root.bounds = CGRect(x: 0, y: 0, width: 20, height: 20)
    let drawn = Drawn()
    drawn.frame = CGRect(x: 0, y: 0, width: 16, height: 10)
    drawn.setNeedsDisplay()
    drawn.displayIfNeeded()
    drawn.bounds = .zero
    #expect(!GlassLayerCopy.isPicture(drawn.contents))
    let child = CALayer()
    child.frame = CGRect(x: 2, y: 2, width: 6, height: 6)
    child.backgroundColor = CGColor(red: 1, green: 0, blue: 0, alpha: 1)
    drawn.addSublayer(child)
    root.addSublayer(drawn)
    let tree = try GlassLayerCopy.tree(of: root).get()
    #expect(Self.contentsOnlyPictures(tree.root))
    #expect(tree.root.sublayers?.first?.sublayers?.count == 1, "what it holds is still copied")
  }

  @Test func `layers the copy can't carry are refused, so the capture falls back instead of dropping them`() {
    let root = CALayer()
    root.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
    root.addSublayer(CAReplicatorLayer())
    #expect(GlassLayerCopy.tree(of: root).failureValue == .unsafe)
    let masked = CALayer()
    masked.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
    masked.mask = CATransformLayer()
    #expect(GlassLayerCopy.tree(of: masked).failureValue == .unsafe, "a mask it can't copy would hide or show the wrong pixels")
    let hiddenMask = CALayer()
    hiddenMask.isHidden = true
    let maskedByHidden = CALayer()
    maskedByHidden.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
    maskedByHidden.mask = hiddenMask
    #expect(GlassLayerCopy.tree(of: maskedByHidden).failureValue == .unsafe)
  }

  @Test func `Metal layers and hidden layers are left out`() throws {
    let root = CALayer()
    root.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
    let hidden = CALayer()
    hidden.isHidden = true
    root.addSublayer(hidden)
    root.addSublayer(CAMetalLayer())
    root.addSublayer(CALayer())
    let tree = try GlassLayerCopy.tree(of: root).get()
    #expect(tree.root.sublayers?.count == 1)
  }
}

extension Result {
  var failureValue: Failure? {
    if case .failure(let error) = self { return error }
    return nil
  }
}
