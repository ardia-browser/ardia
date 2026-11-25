import QuartzCore

struct PeekAffine: Equatable {
  var s: Double
  var tx: Double
  var ty: Double

  static let identity = PeekAffine(s: 1, tx: 0, ty: 0)

  static func mapping(_ from: CGRect, to: CGRect) -> PeekAffine {
    let s = from.width > 0 ? to.width / from.width : 1
    return PeekAffine(s: s, tx: to.minX - s * from.minX, ty: to.minY - s * from.minY)
  }

  static func scale(_ s: Double, about c: CGPoint) -> PeekAffine {
    PeekAffine(s: s, tx: c.x - s * c.x, ty: c.y - s * c.y)
  }

  func apply(_ p: CGPoint) -> CGPoint { CGPoint(x: s * p.x + tx, y: s * p.y + ty) }

  func apply(_ r: CGRect) -> CGRect { CGRect(x: s * r.minX + tx, y: s * r.minY + ty, width: s * r.width, height: s * r.height) }

  func then(_ next: PeekAffine) -> PeekAffine { PeekAffine(s: next.s * s, tx: next.s * tx + next.tx, ty: next.s * ty + next.ty) }

  var inverse: PeekAffine { PeekAffine(s: 1 / s, tx: -tx / s, ty: -ty / s) }

  var isFinite: Bool { s.isFinite && tx.isFinite && ty.isFinite && s > 0 }

  func layerTransform(anchor: CGPoint, height: Double, topDown: Bool) -> CATransform3D {
    let local = topDown ? self : PeekAffine(s: s, tx: tx, ty: height * (1 - s) - ty)
    let c = CGPoint(x: local.tx - anchor.x + local.s * anchor.x, y: local.ty - anchor.y + local.s * anchor.y)
    return CATransform3DConcat(CATransform3DMakeScale(local.s, local.s, 1), CATransform3DMakeTranslation(c.x, c.y, 0))
  }
}
