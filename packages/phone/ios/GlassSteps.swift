import ArdiaDesign
import QuartzCore
import UIKit

struct GlassSteps: @unchecked Sendable {
  enum Kind {
    case fill(color: CGColor, path: CGPath)
    case image(CGImage, rect: CGRect, clip: CGRect)
    case layer(GlassLayerTree)
  }

  struct Step {
    let kind: Kind
    let transform: CGAffineTransform
    let alpha: CGFloat
    let clips: [CGPath]
  }

  private(set) var steps: [Step] = []
  private(set) var layers = 0

  @MainActor
  static func make(_ pieces: [GlassLayerPiece], page: GlassPageShot, pixelsPerPoint: CGFloat) -> GlassSteps? {
    var made = GlassSteps()
    for piece in pieces {
      let clips = piece.clips.map(\.path)
      if let web = piece.page {
        guard let placed = page.placed(web) else { return nil }
        made.steps.append(Step(kind: .image(placed.image, rect: placed.rect, clip: web.bounds), transform: piece.transform, alpha: piece.alpha, clips: clips))
      } else if let view = piece.view {
        guard case .success(let tree) = GlassLayerCopy.tree(of: view.layer, pixelsPerPoint: pixelsPerPoint) else { return nil }
        made.layers += tree.layers
        let alpha = piece.alpha / (GlassProbe.appliesOwnAlpha(.layer) ? max(CGFloat(tree.root.opacity), 0.01) : 1)
        made.steps.append(Step(kind: .layer(tree), transform: piece.transform, alpha: alpha, clips: clips))
      } else if let fill = piece.fill {
        let radius = min(piece.radius, min(piece.bounds.width, piece.bounds.height) / 2)
        made.steps.append(Step(kind: .fill(color: fill, path: CGPath(roundedRect: piece.bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)), transform: piece.transform, alpha: piece.alpha, clips: clips))
      }
    }
    return made
  }

  static func page(_ image: CGImage, in rect: CGRect, across bounds: CGRect, transform: CGAffineTransform) -> (steps: GlassSteps, drawn: CGRect) {
    let band = CGRect(x: bounds.minX, y: rect.minY, width: bounds.width, height: rect.height).intersection(rect)
    var made = GlassSteps()
    made.steps.append(Step(kind: .image(image, rect: rect, clip: band), transform: transform, alpha: 1, clips: []))
    return (made, band.applying(transform))
  }

  func draw(in context: CGContext) {
    for step in steps {
      context.saveGState()
      for clip in step.clips {
        context.addPath(clip)
        context.clip()
      }
      switch step.kind {
      case .fill(let color, let path):
        context.concatenate(step.transform)
        context.setAlpha(step.alpha)
        context.setFillColor(color)
        context.addPath(path)
        context.fillPath()
      case .image(let image, let rect, let clip):
        if step.alpha < 1 { context.setAlpha(step.alpha) }
        Self.draw(image, in: rect, clip: clip, transform: step.transform, context: context)
      case .layer(let tree):
        context.concatenate(step.transform)
        let layered = step.alpha < 1
        if layered {
          context.setAlpha(step.alpha)
          context.beginTransparencyLayer(auxiliaryInfo: nil)
        }
        tree.render(in: context)
        if layered { context.endTransparencyLayer() }
      }
      context.restoreGState()
    }
  }

  static func draw(_ image: CGImage, in rect: CGRect, clip: CGRect, transform: CGAffineTransform, context: CGContext) {
    context.saveGState()
    defer { context.restoreGState() }
    context.concatenate(transform)
    context.clip(to: clip)
    context.translateBy(x: rect.minX, y: rect.maxY)
    context.scaleBy(x: 1, y: -1)
    context.draw(image, in: CGRect(origin: .zero, size: rect.size))
  }
}
