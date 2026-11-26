import ArdiaBrowser
import CoreVideo
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassLabScroll: NSObject {
  private static var running: GlassLabScroll?

  private let web: WKWebView
  private let seconds: Double
  private let period: Double
  private let reach: CGFloat
  private let zoom: CGFloat?
  private var link: CADisplayLink?
  private var started: CFTimeInterval = 0

  private init(web: WKWebView, seconds: Double, period: Double, reach: CGFloat, zoom: CGFloat?) {
    self.web = web
    self.seconds = seconds
    self.period = period
    self.reach = reach
    self.zoom = zoom
  }

  static func start(after delay: Double, for seconds: Double, period: Double = 4, reach: CGFloat = 2400, zoom: CGFloat? = nil) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let web = windows.flatMap(pages).max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else {
          NSLog("PAGELAB glass scroll found no page")
          return
        }
        let scroll = GlassLabScroll(web: web, seconds: seconds, period: period, reach: reach, zoom: zoom)
        running = scroll
        scroll.begin()
      }
    }
  }

  static func pages(in view: UIView) -> [WKWebView] {
    if view.isHidden || view.alpha <= 0.01 { return [] }
    if let web = view as? WKWebView {
      guard let window = web.window, web.convert(web.bounds, to: window).intersects(window.bounds) else { return [] }
      return [web]
    }
    return view.subviews.flatMap(pages)
  }

  private func begin() {
    if let zoom {
      let scroll = web.scrollView
      scroll.maximumZoomScale = max(scroll.maximumZoomScale, scroll.zoomScale * zoom)
      scroll.setZoomScale(scroll.zoomScale * zoom, animated: false)
      NSLog("PAGELAB glass zoom %.2f (min %.2f max %.2f)", scroll.zoomScale, scroll.minimumZoomScale, scroll.maximumZoomScale)
    }
    started = CACurrentMediaTime()
    WebTab.labScrollCountsAsTouch = true
    let made = CADisplayLink(target: self, selector: #selector(tick(_:)))
    made.add(to: .main, forMode: .common)
    link = made
    NSLog("PAGELAB glass scroll started for %.0f s", seconds)
  }

  @objc private func tick(_ link: CADisplayLink) {
    let elapsed = CACurrentMediaTime() - started
    let scroll = web.scrollView
    let reach = max(min(scroll.contentSize.height - scroll.bounds.height, self.reach), 0)
    let wave = (1 - cos(elapsed / period * 2 * Double.pi)) / 2
    scroll.contentOffset = CGPoint(x: scroll.contentOffset.x, y: CGFloat(wave) * reach - scroll.adjustedContentInset.top)
    guard elapsed >= seconds else { return }
    link.invalidate()
    self.link = nil
    WebTab.labScrollCountsAsTouch = false
    Self.running = nil
    NSLog("PAGELAB glass scroll done")
  }
}

@MainActor
enum GlassLabRim {
  static func start(after delay: Double) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        let board = UIView(frame: window.bounds)
        board.backgroundColor = .white
        board.isUserInteractionEnabled = false
        let solid = UIView(frame: CGRect(x: 0, y: 0, width: window.bounds.width, height: window.bounds.height / 2))
        solid.backgroundColor = UIColor(red: 0.1, green: 0.45, blue: 0.8, alpha: 1)
        let wash = UIView(frame: CGRect(x: 0, y: window.bounds.height / 2, width: window.bounds.width, height: window.bounds.height / 2))
        wash.backgroundColor = UIColor(red: 1, green: 0.5, blue: 0.1, alpha: 0.5)
        board.addSubview(solid)
        board.addSubview(wash)
        for (index, top) in [200.0, 300.0, window.bounds.height / 2 + 150, window.bounds.height / 2 + 250].enumerated() {
          let glass = LiquidGlassSurface(frame: CGRect(x: 40, y: top, width: 220, height: 64))
          glass.label = "rimProbe\(index)"
          glass.dark = false
          glass.rimDisabled = index % 2 == 1
          board.addSubview(glass)
        }
        window.addSubview(board)
        NSLog("PAGELAB glass rim probe shown")
      }
    }
  }
}

@MainActor
enum GlassLabNavigate {
  static func start(after delay: Double, to target: URL, stopAfter: Double?) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let web = windows.flatMap(GlassLabScroll.pages).first else { return }
        NSLog("PAGELAB glass navigate to %@", target.host ?? "-")
        web.load(URLRequest(url: target))
        guard let stopAfter else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + stopAfter) {
          MainActor.assumeIsolated {
            NSLog("PAGELAB glass stop loading (still loading: %@)", web.isLoading ? "yes" : "no")
            web.stopLoading()
          }
        }
      }
    }
  }
}

@MainActor
enum GlassLabReload {
  static func start(after delay: Double) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let web = windows.flatMap(GlassLabScroll.pages).first else { return }
        NSLog("PAGELAB glass reload %@", web.url?.host ?? "-")
        web.reload()
      }
    }
  }
}


@MainActor
enum GlassPlacementProbe {
  static func check(_ picture: CGImage, area: CGRect, zoom: CGFloat, web: WKWebView) {
    let offset = web.scrollView.contentOffset
    let configuration = WKSnapshotConfiguration()
    configuration.rect = web.bounds
    configuration.snapshotWidth = NSNumber(value: Double(web.bounds.width / 2))
    web.takeSnapshot(with: configuration) { image, _ in
      MainActor.assumeIsolated {
        guard let shot = image?.cgImage else { return }
        guard web.scrollView.contentOffset == offset else {
          NSLog("PAGELAB glass placement skipped: the page moved")
          return
        }
        let document = rows(picture)
        let screen = rows(shot)
        guard let found = residual(old: document, oldTop: area.minY, oldPerPoint: CGFloat(picture.height) / area.height, new: screen, newTop: offset.y / zoom, newPerPoint: CGFloat(shot.height) * zoom / web.bounds.height) else {
          NSLog("PAGELAB glass placement no overlap")
          return
        }
        NSLog("PAGELAB glass placement offset=%.0f error=%.1f pt overlap=%d", offset.y, found.shift, found.overlap)
      }
    }
  }

  static func rows(_ image: CGImage) -> [Double] {
    let height = image.height
    guard height > 1, let context = CGContext(data: nil, width: 4, height: height, bitsPerComponent: 8, bytesPerRow: 16, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), let data = context.data else { return [] }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: 4, height: height))
    return (0..<height).map { row in
      var sum = 0.0
      for column in 0..<4 {
        let at = row * 16 + column * 4
        sum += Double(data.load(fromByteOffset: at, as: UInt8.self)) + Double(data.load(fromByteOffset: at + 1, as: UInt8.self)) + Double(data.load(fromByteOffset: at + 2, as: UInt8.self))
      }
      return sum / 12
    }
  }

  static func residual(old: [Double], oldTop: CGFloat, oldPerPoint: CGFloat, new: [Double], newTop: CGFloat, newPerPoint: CGFloat) -> (shift: CGFloat, overlap: Int)? {
    var best: (shift: CGFloat, error: Double, overlap: Int)?
    for step in -200...200 {
      let shift = CGFloat(step) / 2
      var error = 0.0
      var count = 0
      for (row, value) in new.enumerated() {
        let document = newTop + shift + CGFloat(row) / newPerPoint
        let place = (document - oldTop) * oldPerPoint
        let low = Int(place.rounded(.down))
        guard low >= 0, low + 1 < old.count else { continue }
        let mix = Double(place - CGFloat(low))
        let expected = old[low] * (1 - mix) + old[low + 1] * mix
        error += (value - expected) * (value - expected)
        count += 1
      }
      guard count >= 120 else { continue }
      let mean = error / Double(count)
      if best == nil || mean < best!.error { best = (shift, mean, count) }
    }
    return best.map { ($0.shift, $0.overlap) }
  }
}

@MainActor
enum GlassCopyProbe {
  private static var left = 6

  static func arm(_ capture: GlassCapture, pieces: [GlassLayerPiece], rect: CGRect, pixelsPerPoint: CGFloat) {
    guard left > 0 else { return }
    left -= 1
    let width = max(Int((rect.width * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    let height = max(Int((rect.height * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), let data = context.data else { return }
    context.interpolationQuality = .low
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: pixelsPerPoint, y: -pixelsPerPoint)
    context.translateBy(x: -rect.minX, y: -rect.minY)
    let started = CACurrentMediaTime()
    UIGraphicsPushContext(context)
    for piece in pieces { _ = GlassBackdrop.draw(piece, method: .layer, page: capture.page, in: context) }
    UIGraphicsPopContext()
    let mainMs = (CACurrentMediaTime() - started) * 1000
    let expected = Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: width * height * 4))
    capture.probe = { [weak capture] pixels in
      capture?.probe = nil
      guard CVPixelBufferLockBaseAddress(pixels, .readOnly) == kCVReturnSuccess else { return }
      defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
      guard CVPixelBufferGetWidth(pixels) == width, CVPixelBufferGetHeight(pixels) == height, let base = CVPixelBufferGetBaseAddress(pixels) else {
        NSLog("PAGELAB glass copy probe size changed")
        return
      }
      let row = CVPixelBufferGetBytesPerRow(pixels)
      var total = 0
      var off = 0
      var worst = 0
      for y in 0..<height {
        for x in 0..<width {
          var most = 0
          for channel in 0..<4 {
            let got = Int(base.load(fromByteOffset: y * row + x * 4 + channel, as: UInt8.self))
            let want = Int(expected[(y * width + x) * 4 + channel])
            most = max(most, abs(got - want))
          }
          total += most
          worst = max(worst, most)
          if most > 8 { off += 1 }
        }
      }
      NSLog("PAGELAB glass copy probe pieces=%d size=%dx%d mean_diff=%.2f off_pixels=%.2f%% worst=%d on_main_ms=%.1f", pieces.count, width, height, Double(total) / Double(width * height), Double(off) * 100 / Double(width * height), worst, mainMs)
    }
  }
}
