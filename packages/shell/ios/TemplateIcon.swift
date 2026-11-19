import AppKit
import CoreImage
import ExpoModulesCore

enum TemplateIcon {
  private static let cache = IconDerived<IconImage>("template")

  static func of(_ source: IconSource) -> CGImage? {
    if let cached = cache.value(for: source) { return cached.image }
    guard !source.drawsOffMain, let image = source.load(),
      let context = CGContext(
        data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.draw(image, in: rect)
    context.setBlendMode(.sourceIn)
    context.setFillColor(.white)
    context.fill(rect)
    guard let white = context.makeImage() else { return nil }
    cache.set(IconImage(white), for: source)
    return white
  }
}
