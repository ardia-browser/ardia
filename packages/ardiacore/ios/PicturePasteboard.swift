import AppKit

enum PicturePasteboard {
  static func write(_ picture: CGImage?, pixelsPerPoint: CGFloat) -> [String: Int]? {
    guard let picture = picture.map(inSRGB) else { return nil }
    let bitmap = NSBitmapImageRep(cgImage: picture)
    let density = max(pixelsPerPoint, 1)
    bitmap.size = NSSize(width: CGFloat(picture.width) / density, height: CGFloat(picture.height) / density)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.declareTypes([.png, .tiff], owner: nil)
    pasteboard.setData(png, forType: .png)
    if let tiff = bitmap.tiffRepresentation { pasteboard.setData(tiff, forType: .tiff) }
    return ["width": picture.width, "height": picture.height]
  }

  private static func inSRGB(_ image: CGImage) -> CGImage {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB), image.colorSpace?.name != CGColorSpace.sRGB,
      let context = CGContext(
        data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return image }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return context.makeImage() ?? image
  }
}
