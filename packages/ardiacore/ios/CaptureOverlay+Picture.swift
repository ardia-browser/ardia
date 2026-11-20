import AppKit

extension CaptureOverlay {
  static func withGray(_ picture: CGImage?, done: @escaping (CGImage?, CGImage?) -> Void) {
    CaptureClipboard.imageWork.async {
      let gray = picture.flatMap(grayscale)
      DispatchQueue.main.async { done(picture, gray) }
    }
  }

  private static func grayscale(_ image: CGImage) -> CGImage? {
    let context = CGContext(
      data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
      bitmapInfo: CGImageAlphaInfo.none.rawValue)
    context?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return context?.makeImage()
  }
}
