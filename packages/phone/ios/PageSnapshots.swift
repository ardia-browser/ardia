import ArdiaBrowser
import CryptoKit
import ExpoModulesCore
import Foundation
import Observation
import SwiftData
import UIKit
import WebKit

enum PageSnapshots {
  static var saved: URL { URL.applicationSupportDirectory.appending(path: "PageSnapshots", directoryHint: .isDirectory) }
  static var privateFolder: URL { URL.cachesDirectory.appending(path: "PrivatePageSnapshots", directoryHint: .isDirectory) }

  static func write(_ pageID: String, image: UIImage, isPrivate: Bool, quality: Int) async -> [String: Any]? {
    let folder = isPrivate ? privateFolder : saved
    let stem = fileStem(pageID)
    let width = Int((image.size.width * image.scale).rounded())
    let height = Int((image.size.height * image.scale).rounded())
    guard let data = image.jpegData(compressionQuality: CGFloat(min(max(quality, 1), 100)) / 100) else { return nil }
    let stamp = Int(Date.now.timeIntervalSince1970 * 1000)
    return await Task.detached(priority: .utility) { () -> [String: Any]? in
      let manager = FileManager.default
      guard (try? manager.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return nil }
      let target = folder.appending(path: "\(stem)-\(stamp).jpg")
      guard (try? data.write(to: target, options: .atomic)) != nil else { return nil }
      for old in older(in: folder, stem: stem) where old != target { try? manager.removeItem(at: old) }
      return ["path": target.path(percentEncoded: false), "uri": target.absoluteString, "width": width, "height": height, "route": "draw", "bytes": data.count]
    }.value
  }

  static func delete(_ pageID: String) {
    let stem = fileStem(pageID)
    for folder in [saved, privateFolder] {
      for file in older(in: folder, stem: stem) { try? FileManager.default.removeItem(at: file) }
    }
  }

  static func endPrivateBrowsing() {
    try? FileManager.default.removeItem(at: privateFolder)
  }

  private static func older(in folder: URL, stem: String) -> [URL] {
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.lastPathComponent.hasPrefix("\(stem)-") && $0.pathExtension == "jpg" }
  }

  @MainActor
  static func isOnScreen(_ view: UIView) -> Bool {
    guard let window = view.window, !window.isHidden else { return false }
    var current: UIView? = view
    while let shown = current {
      if shown.isHidden || shown.alpha < 0.01 { return false }
      current = shown.superview
    }
    return view.convert(view.bounds, to: window).intersects(window.bounds)
  }

  static let screenCopyScale: CGFloat = 2

  @MainActor
  static func screenCopy(of view: UIView, width: CGFloat) -> UIImage? {
    guard view.bounds.width > 0, width > 0 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = screenCopyScale * width / view.bounds.width
    format.opaque = true
    var drawn = false
    let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { _ in
      drawn = view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
    }
    return drawn ? image : nil
  }

  static let flatSample = 16
  static let flatSpread = 3

  static func isFlat(_ image: UIImage) -> Bool {
    guard let cgImage = image.cgImage else { return false }
    let side = flatSample
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
      context.interpolationQuality = .medium
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: side, height: side))
      return true
    }
    guard drawn else { return false }
    for channel in 0..<3 {
      var low = UInt8.max
      var high = UInt8.min
      for at in stride(from: channel, to: pixels.count, by: 4) {
        low = min(low, pixels[at])
        high = max(high, pixels[at])
      }
      if Int(high) - Int(low) > flatSpread { return false }
    }
    return true
  }

  static func fileStem(_ pageID: String) -> String {
    if pageID.count <= 64, pageID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }) { return pageID }
    return SHA256.hash(data: Data(pageID.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
  }
}

@MainActor
enum OffscreenCapture {
  static let loadTimeout: Duration = .seconds(10)
  static let settleDelay: Duration = .milliseconds(700)

  static func capture(url: String, pageID: String, blocker: ContentBlocker) async -> [String: Any?]? {
    guard let target = URL(string: url), BrowserURL.isSyncable(url) else { return nil }
    await blocker.prepare()
    guard let window = keyWindow() else { return nil }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    blocker.install(on: configuration.userContentController, counter: BlockedResourceCounter())
    let size = window.bounds.size
    let webView = WKWebView(frame: CGRect(x: -size.width * 2, y: 0, width: size.width, height: size.height), configuration: configuration)
    webView.isUserInteractionEnabled = false
    window.insertSubview(webView, at: 0)
    defer { webView.removeFromSuperview() }
    webView.load(URLRequest(url: target))
    let start = ContinuousClock.now
    try? await Task.sleep(for: .milliseconds(500))
    while webView.isLoading, ContinuousClock.now - start < loadTimeout {
      try? await Task.sleep(for: .milliseconds(200))
    }
    try? await Task.sleep(for: settleDelay)
    let snapshot = WKSnapshotConfiguration()
    snapshot.snapshotWidth = NSNumber(value: Double(min(size.width, TabSnapshotStore.pointWidth)))
    guard let image = try? await webView.takeSnapshot(configuration: snapshot) else { return nil }
    let theme = webView.themeColor.flatMap(hex)
    let title = webView.title
    guard let written = await PageSnapshots.write(pageID, image: image, isPrivate: false, quality: 82) else { return nil }
    return ["fileName": written["uri"] ?? nil, "path": written["path"] ?? nil, "title": (title?.isEmpty == false) ? title : nil, "themeColorHex": theme]
  }

  private static func keyWindow() -> UIWindow? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    return windows.first { $0.isKeyWindow } ?? windows.first
  }

  private static func hex(_ color: UIColor) -> String? {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha > 0.5 else { return nil }
    func byte(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
    return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
  }
}
