import AppKit

enum SymbolInk {
  static func offset(of image: NSImage, density: CGFloat) -> CGVector {
    let wide = Int((image.size.width * density).rounded(.up)), high = Int((image.size.height * density).rounded(.up))
    guard wide > 0, high > 0,
      let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: wide, pixelsHigh: high, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: rep)
    else { return .zero }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: CGFloat(wide) / image.size.width, y: CGFloat(high) / image.size.height)
    image.draw(in: NSRect(origin: .zero, size: image.size), from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let pixels = rep.bitmapData, let ink = inkEdges(pixels, wide: wide, high: high, bytesPerRow: rep.bytesPerRow) else {
      return .zero
    }
    return CGVector(
      dx: (ink.right - ink.left) / 2 * image.size.width / CGFloat(wide),
      dy: (ink.top - ink.bottom) / 2 * image.size.height / CGFloat(high))
  }

  static func inkEdges(_ pixels: UnsafePointer<UInt8>, wide: Int, high: Int, bytesPerRow: Int) -> (
    left: CGFloat, right: CGFloat, top: CGFloat, bottom: CGFloat
  )? {
    var columns = [CGFloat](repeating: 0, count: wide), rows = [CGFloat](repeating: 0, count: high)
    for y in 0..<high {
      for x in 0..<wide {
        let alpha = CGFloat(pixels[y * bytesPerRow + x * 4 + 3]) / 255
        columns[x] = max(columns[x], alpha)
        rows[y] = max(rows[y], alpha)
      }
    }
    guard let left = columns.firstIndex(where: { $0 > 0 }), let right = columns.lastIndex(where: { $0 > 0 }),
      let top = rows.firstIndex(where: { $0 > 0 }), let bottom = rows.lastIndex(where: { $0 > 0 })
    else { return nil }
    return (
      CGFloat(left) + 1 - columns[left], CGFloat(wide) - CGFloat(right) - columns[right],
      CGFloat(top) + 1 - rows[top], CGFloat(high) - CGFloat(bottom) - rows[bottom]
    )
  }

  static func centredRect(_ image: NSSize, in bounds: NSRect, offset: CGVector, flipped: Bool) -> NSRect? {
    guard bounds.width > 0, bounds.height > 0, image.width > 0, image.height > 0 else { return nil }
    let fit = min(1, bounds.width / image.width, bounds.height / image.height)
    let size = NSSize(width: image.width * fit, height: image.height * fit)
    let up = flipped ? -offset.dy : offset.dy
    return NSRect(
      x: bounds.midX - size.width / 2 + offset.dx * fit, y: bounds.midY - size.height / 2 + up * fit, width: size.width,
      height: size.height)
  }
}
