import AppKit
import CoreImage
import ExpoModulesCore

final class BlurredIcon {
  let plain: CGImage
  let darkRing: CGImage

  private static let cache = IconDerived<BlurredIcon>("blurred")
  private static let context = CIContext()

  private init(plain: CGImage, darkRing: CGImage) {
    self.plain = plain
    self.darkRing = darkRing
  }

  static func of(_ source: IconSource) -> BlurredIcon? {
    if let cached = cache.value(for: source) { return cached }
    guard !source.drawsOffMain, let image = source.load(), let plain = blur(image), let darkRing = colorControls(plain) else { return nil }
    let icon = BlurredIcon(plain: plain, darkRing: darkRing)
    cache.set(icon, for: source)
    return icon
  }

  private static func blur(_ image: CGImage) -> CGImage? {
    guard let filter = CIFilter(name: "CIGaussianBlur") else { return nil }
    filter.setValue(CIImage(cgImage: image), forKey: kCIInputImageKey)
    filter.setValue(5, forKey: kCIInputRadiusKey)
    guard let output = filter.outputImage else { return nil }
    return context.createCGImage(output, from: output.extent)
  }

  private static func colorControls(_ image: CGImage) -> CGImage? {
    guard let filter = CIFilter(name: "CIColorControls") else { return nil }
    filter.setValue(CIImage(cgImage: image), forKey: kCIInputImageKey)
    filter.setValue(2.0, forKey: kCIInputSaturationKey)
    filter.setValue(-0.1, forKey: kCIInputBrightnessKey)
    guard let output = filter.outputImage else { return nil }
    return context.createCGImage(output, from: output.extent)
  }
}
