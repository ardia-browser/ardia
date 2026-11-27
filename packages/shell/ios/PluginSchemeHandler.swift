import AppKit
import Foundation
import UniformTypeIdentifiers
import WebKit

final class PluginSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "ardia-plugin"

  let plugin: String
  let folderId: String
  let approved: String
  let policy: String?

  init(plugin: String, folderId: String, approved: String, policy: String?) {
    self.plugin = plugin
    self.folderId = folderId
    self.approved = approved
    self.policy = policy
  }

  static func relativePath(of url: URL, plugin: String) -> String? {
    guard url.scheme == scheme, url.host == plugin, url.user == nil, url.port == nil else { return nil }
    let path = url.path
    guard path.utf8.first == UInt8(ascii: "/"), let parts = PluginFiles.pathParts(String(path.dropFirst())) else { return nil }
    return parts.joined(separator: "/")
  }

  func contents(of url: URL) -> (path: String, data: Data)? {
    guard let relative = Self.relativePath(of: url, plugin: plugin), let folders = PluginFolders.current(),
      let data = folders.readPageFile(plugin, folderId: folderId, approved: approved, relative: relative)
    else { return nil }
    return (relative, data)
  }

  static func mimeType(_ path: String) -> String {
    let ext = (path as NSString).pathExtension.lowercased()
    if ext == "js" || ext == "mjs" { return "text/javascript" }
    return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
  }

  private func respond(_ task: WKURLSchemeTask, _ url: URL, _ status: Int, _ text: String) {
    let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers(["content-type": "text/plain; charset=utf-8"]))!
    task.didReceive(response)
    task.didReceive(Data(text.utf8))
    task.didFinish()
  }

  private func headers(_ given: [String: String]) -> [String: String] {
    var headers = given
    headers["x-content-type-options"] = "nosniff"
    if let policy {
      headers["content-security-policy"] = policy
      headers["x-dns-prefetch-control"] = "off"
    }
    return headers
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
    if url.scheme == Self.scheme, url.host == plugin, url.user == nil, url.port == nil, url.path.hasPrefix(PluginSymbols.prefix) {
      guard let request = PluginSymbols.request(of: url) else { return respond(task, url, 400, "Bad symbol request") }
      guard let png = PluginSymbols.png(request) else { return respond(task, url, 404, "No such symbol") }
      let given = ["content-type": "image/png", "content-length": String(png.count), "cache-control": "max-age=86400"]
      task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers(given))!)
      task.didReceive(png)
      return task.didFinish()
    }
    guard let (path, data) = contents(of: url) else { return respond(task, url, 404, "Not found") }
    let given = ["content-type": Self.mimeType(path), "content-length": String(data.count), "cache-control": "no-store"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers(given))!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

enum PluginSymbols {
  static let prefix = "/__symbols/"
  static let maxPointSize: CGFloat = 64
  static let maxScale: CGFloat = 3
  static let maxNameLength = 64

  private static let cache: NSCache<NSString, NSData> = {
    let cache = NSCache<NSString, NSData>()
    cache.countLimit = 512
    cache.totalCostLimit = 8 * 1024 * 1024
    return cache
  }()

  private static let weights: [String: NSFont.Weight] = [
    "ultralight": .ultraLight, "thin": .thin, "light": .light, "regular": .regular, "medium": .medium,
    "semibold": .semibold, "bold": .bold, "heavy": .heavy, "black": .black,
  ]

  struct Request: Equatable {
    let name: String
    let weight: String
    let pointSize: CGFloat
    let scale: CGFloat
    var key: String { "\(name)|\(weight)|\(pointSize)|\(scale)" }
  }

  static func isSymbolName(_ name: String) -> Bool {
    guard !name.isEmpty, name.utf8.count <= maxNameLength, name.first != ".", name.last != ".", !name.contains("..") else { return false }
    return name.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2E }
  }

  static func request(of url: URL) -> Request? {
    let path = url.path
    guard path.hasPrefix(prefix), path.hasSuffix(".png") else { return nil }
    let name = String(path.dropFirst(prefix.count).dropLast(4))
    guard isSymbolName(name) else { return nil }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let value = { (key: String) in items.first { $0.name == key }?.value }
    let weight = value("weight") ?? "regular"
    guard weights[weight] != nil else { return nil }
    guard let size = Double(value("size") ?? "13"), size.isFinite, size >= 4, CGFloat(size) <= maxPointSize else { return nil }
    guard let scale = Double(value("scale") ?? "2"), scale.isFinite, scale >= 1, CGFloat(scale) <= maxScale else { return nil }
    return Request(name: name, weight: weight, pointSize: (CGFloat(size) * 2).rounded() / 2, scale: CGFloat(scale).rounded())
  }

  static func png(_ request: Request) -> Data? {
    let key = request.key as NSString
    if let hit = cache.object(forKey: key) { return hit as Data }
    guard let data = render(request) else { return nil }
    cache.setObject(data as NSData, forKey: key, cost: data.count)
    return data
  }

  private static func render(_ request: Request) -> Data? {
    let configuration = NSImage.SymbolConfiguration(pointSize: request.pointSize, weight: weights[request.weight] ?? .regular)
    guard let symbol = NSImage(systemSymbolName: request.name, accessibilityDescription: nil)?.withSymbolConfiguration(configuration) else { return nil }
    let size = symbol.size
    let pixelsWide = Int((size.width * request.scale).rounded(.up))
    let pixelsHigh = Int((size.height * request.scale).rounded(.up))
    guard pixelsWide > 0, pixelsHigh > 0, pixelsWide <= 1024, pixelsHigh <= 1024,
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { return nil }
    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    NSGraphicsContext.current = context
    let rect = NSRect(origin: .zero, size: size)
    symbol.draw(in: rect)
    NSColor.black.set()
    rect.fill(using: .sourceAtop)
    context.flushGraphics()
    return bitmap.representation(using: .png, properties: [:])
  }
}
