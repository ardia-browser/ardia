import ArdiaBrowser
import CryptoKit
import ExpoModulesCore
import Foundation
import Observation
import os
import SwiftData
import UIKit
import WebKit

enum PageSnapshots {
  static var saved: URL { URL.applicationSupportDirectory.appending(path: "PageSnapshots", directoryHint: .isDirectory) }
  static var privateRoot: URL { URL.cachesDirectory.appending(path: "PrivatePageSnapshots", directoryHint: .isDirectory) }

  static func privateFolder(_ session: String) -> URL { privateRoot.appending(path: session, directoryHint: .isDirectory) }

  struct HeldImage: @unchecked Sendable {
    let image: UIImage
  }

  struct Written: Sendable {
    let path: String
    let uri: String
    let width: Int
    let height: Int
    let bytes: Int
    let ticket: Int

    var payload: [String: Any] {
      ["path": path, "uri": uri, "width": width, "height": height, "route": "draw", "bytes": bytes, "generation": ticket]
    }
  }

  struct Order: Comparable, Sendable {
    let current: Bool
    let ticket: Int

    static func < (lhs: Order, rhs: Order) -> Bool {
      if lhs.current != rhs.current { return !lhs.current }
      return lhs.current && lhs.ticket < rhs.ticket
    }
  }

  static let process = UUID().uuidString.replacingOccurrences(of: "-", with: "")

  private static let tickets = OSAllocatedUnfairLock<Int>(initialState: 0)
  private static let privateSession = OSAllocatedUnfairLock<String>(initialState: UUID().uuidString)

  static func nextTicket() -> Int {
    tickets.withLock { last in
      last += 1
      return last
    }
  }

  static func currentPrivateSession() -> String { privateSession.withLock { $0 } }

  static func retirePrivateSession() -> String {
    privateSession.withLock { session in
      let retired = session
      session = UUID().uuidString
      return retired
    }
  }

  static func write(_ pageID: String, image: UIImage, isPrivate: Bool, quality: Int, ticket: Int, session: String, priority: TaskPriority = .userInitiated) async -> [String: Any]? {
    let width = Int((image.size.width * image.scale).rounded())
    let height = Int((image.size.height * image.scale).rounded())
    let compression = CGFloat(min(max(quality, 1), 100)) / 100
    let held = HeldImage(image: image)
    let encoded = await Task.detached(priority: priority) { held.image.jpegData(compressionQuality: compression) }.value
    guard let encoded else { return nil }
    let written = await SnapshotFiles.shared.publish(pageID, data: encoded, privateSession: isPrivate ? session : nil, width: width, height: height, ticket: ticket)
    return written?.payload
  }

  static func deletionOrder() -> Order { Order(current: true, ticket: nextTicket()) }

  static func delete(_ pageID: String, before floor: Order) async {
    await SnapshotFiles.shared.delete(pageID, before: floor)
  }

  static func delete(_ pageIDs: [String], before floor: Order) async {
    await SnapshotFiles.shared.delete(pageIDs, before: floor)
  }

  static func endPrivateBrowsing() {
    let retired = retirePrivateSession()
    Task { await SnapshotFiles.shared.removePrivateSession(retired) }
  }

  static func sweepPrivateLeftovers() {
    Task { await SnapshotFiles.shared.removeInactivePrivateSessions() }
  }

  static func committed(_ entries: [String: String]) {
    let pairs = entries.compactMap { pageID, uri in URL(string: uri).map { (pageID, $0) } }
    Task { await SnapshotFiles.shared.committed(pairs) }
  }

  static func fileName(stem: String, ticket: Int) -> String { "\(stem)-\(process)-\(ticket).jpg" }

  static func order(of file: URL, stem: String) -> Order {
    let parts = file.deletingPathExtension().lastPathComponent.dropFirst(stem.count + 1).split(separator: "-")
    if parts.count == 2, parts[0] == process, let ticket = Int(parts[1]) { return Order(current: true, ticket: ticket) }
    return Order(current: false, ticket: 0)
  }

  static func released(_ file: URL, stem: String, keeping kept: URL) -> Bool {
    guard file.lastPathComponent != kept.lastPathComponent else { return false }
    let fileOrder = Self.order(of: file, stem: stem)
    let keptOrder = Self.order(of: kept, stem: stem)
    return !fileOrder.current || (keptOrder.current && fileOrder.ticket < keptOrder.ticket)
  }

  static func filesOf(_ pageID: String, in folder: URL) -> [URL] {
    older(in: folder, stem: fileStem(pageID))
  }

  static func older(in folder: URL, stem: String) -> [URL] {
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

  static func isFlatAwayFromMain(_ image: UIImage) async -> Bool {
    let held = HeldImage(image: image)
    return await Task.detached(priority: .utility) { PageSnapshots.isFlat(held.image) }.value
  }

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

actor SnapshotFiles {
  static let shared = SnapshotFiles()

  private var newestTicket: [String: Int] = [:]
  private var deletedBefore: [String: PageSnapshots.Order] = [:]
  private var retiredSessions: Set<String> = []

  func publish(_ pageID: String, data: Data, privateSession: String?, width: Int, height: Int, ticket: Int) -> PageSnapshots.Written? {
    let order = PageSnapshots.Order(current: true, ticket: ticket)
    guard ticket > (newestTicket[pageID] ?? 0) else { return nil }
    if let floor = deletedBefore[pageID], order < floor { return nil }
    if let privateSession, retiredSessions.contains(privateSession) || privateSession != PageSnapshots.currentPrivateSession() { return nil }
    let folder = privateSession.map(PageSnapshots.privateFolder) ?? PageSnapshots.saved
    let stem = PageSnapshots.fileStem(pageID)
    let manager = FileManager.default
    guard (try? manager.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return nil }
    let target = folder.appending(path: PageSnapshots.fileName(stem: stem, ticket: ticket))
    guard (try? data.write(to: target, options: .atomic)) != nil else { return nil }
    newestTicket[pageID] = ticket
    if privateSession != nil { keepNewestPrivate(stem: stem, in: folder) }
    return PageSnapshots.Written(path: target.path(percentEncoded: false), uri: target.absoluteString, width: width, height: height, bytes: data.count, ticket: ticket)
  }

  private func keepNewestPrivate(stem: String, in folder: URL) {
    let files = PageSnapshots.older(in: folder, stem: stem).sorted { PageSnapshots.order(of: $0, stem: stem) > PageSnapshots.order(of: $1, stem: stem) }
    for old in files.dropFirst(2) { try? FileManager.default.removeItem(at: old) }
  }

  func committed(_ entries: [(String, URL)]) {
    for (pageID, uri) in entries {
      let stem = PageSnapshots.fileStem(pageID)
      let folder = uri.deletingLastPathComponent()
      guard folder.standardizedFileURL == PageSnapshots.saved.standardizedFileURL, uri.lastPathComponent.hasPrefix("\(stem)-") else { continue }
      for file in PageSnapshots.filesOf(pageID, in: PageSnapshots.saved) where PageSnapshots.released(file, stem: stem, keeping: uri) {
        try? FileManager.default.removeItem(at: file)
      }
    }
  }

  func delete(_ pageID: String, before floor: PageSnapshots.Order) {
    deletedBefore[pageID] = max(deletedBefore[pageID] ?? floor, floor)
    let stem = PageSnapshots.fileStem(pageID)
    let folders = [PageSnapshots.saved] + privateSessionFolders()
    for folder in folders {
      for file in PageSnapshots.filesOf(pageID, in: folder) where PageSnapshots.order(of: file, stem: stem) < floor {
        try? FileManager.default.removeItem(at: file)
      }
    }
  }

  func delete(_ pageIDs: [String], before floor: PageSnapshots.Order) {
    var stems: Set<String> = []
    for pageID in pageIDs {
      deletedBefore[pageID] = max(deletedBefore[pageID] ?? floor, floor)
      stems.insert(PageSnapshots.fileStem(pageID))
    }
    let manager = FileManager.default
    for folder in [PageSnapshots.saved] + privateSessionFolders() {
      let files = (try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
      for file in files where file.pathExtension == "jpg" {
        guard let stem = file.lastPathComponent.split(separator: "-").first.map(String.init), stems.contains(stem) else { continue }
        if PageSnapshots.order(of: file, stem: stem) < floor { try? manager.removeItem(at: file) }
      }
    }
  }

  func removePrivateSession(_ session: String) {
    retiredSessions.insert(session)
    try? FileManager.default.removeItem(at: PageSnapshots.privateFolder(session))
  }

  func removeInactivePrivateSessions() {
    let current = PageSnapshots.currentPrivateSession()
    let manager = FileManager.default
    let entries = (try? manager.contentsOfDirectory(at: PageSnapshots.privateRoot, includingPropertiesForKeys: nil)) ?? []
    for entry in entries where entry.lastPathComponent != current {
      if entry.pathExtension != "jpg" { retiredSessions.insert(entry.lastPathComponent) }
      try? manager.removeItem(at: entry)
    }
  }

  private func privateSessionFolders() -> [URL] {
    (try? FileManager.default.contentsOfDirectory(at: PageSnapshots.privateRoot, includingPropertiesForKeys: nil)) ?? []
  }
}

@MainActor
enum OffscreenCapture {
  static let loadTimeout: Duration = .seconds(10)
  static let settleDelay: Duration = .milliseconds(700)

  static func capture(url: String, pageID: String, blocker: ContentBlocker) async -> [String: Any?]? {
    let ticket = PageSnapshots.nextTicket()
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
    guard let written = await PageSnapshots.write(pageID, image: image, isPrivate: false, quality: 82, ticket: ticket, session: PageSnapshots.currentPrivateSession()) else { return nil }
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
