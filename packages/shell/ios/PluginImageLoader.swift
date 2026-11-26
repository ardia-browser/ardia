import Foundation

enum PluginImageLoader {
  static func load(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    var request = spec
    request["method"] = "GET"
    request["headers"] = ["accept": "image/png, image/jpeg, image/gif, image/webp"]
    request["binary"] = true
    PluginHostFetch.run(request) { body in
      guard (body["ok"] as? Bool) == true else { return reply(body) }
      guard let status = body["status"] as? Int, (200...299).contains(status), let encoded = body["body"] as? String, let data = Data(base64Encoded: encoded) else {
        return reply(PluginHostFetch.failed("the image didn't load (\(body["status"] ?? "no answer"))"))
      }
      guard let url = PluginImageBytes.dataURL(data) else { return reply(PluginHostFetch.failed("the answer isn't a PNG, JPEG, GIF or WebP image")) }
      reply(["ok": true, "url": url])
    }
  }

  static func asset(_ name: String, folderId: String, approved: String, path: String) -> [String: Any] {
    guard let folders = PluginFolders.current() else { return ["ok": false, "reason": "Ardia has no data folder"] }
    let folder: OpenedFolder
    switch folders.approvedFolder(name, folderId: folderId, approved: approved) {
    case .success(let opened): folder = opened
    case .failure(let refusal): return ["ok": false, "reason": refusal.reason]
    }
    defer { folder.close() }
    switch PluginImageBytes.read(path, in: folder) {
    case .success(let url): return ["ok": true, "url": url]
    case .failure(let refusal): return ["ok": false, "reason": refusal.reason]
    }
  }
}
