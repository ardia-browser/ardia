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
    guard let (path, data) = contents(of: url) else { return respond(task, url, 404, "Not found") }
    let given = ["content-type": Self.mimeType(path), "content-length": String(data.count), "cache-control": "no-store"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers(given))!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
