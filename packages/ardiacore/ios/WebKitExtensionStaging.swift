import CryptoKit
import Foundation

struct WebKitExtensionStaging {
  struct Staged {
    let folder: URL
    let apis: Set<String>
    let nativeMessaging: Bool
    let signature: String
  }

  static let revision = 4
  static let shimmed = WebKitExtensionShim.names
  static let workerFile = "__ardia_webkit_worker.js"
  static let backgroundFlagFile = "__ardia_webkit_background.js"
  static let contentFile = "__ardia_webkit_content.js"
  static let pageFile = "__ardia_webkit_page.js"
  static let pageAlias = """
    (() => {
      const browser = globalThis.browser;
      if (!browser || !browser.runtime) return;
      const chrome = globalThis.chrome || (globalThis.chrome = {});
      if (!chrome.runtime) chrome.runtime = browser.runtime;
    })();

    """
  static let markerFile = ".ardia-webkit-staged"

  static func root(profile: String) -> URL {
    URL(fileURLWithPath: ArdiaServices.profileDirectory(profile), isDirectory: true).appendingPathComponent("Ardia WebKit Extensions", isDirectory: true)
  }

  static func manifest(at folder: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  static func permissionNames(_ value: Any?) -> Set<String> {
    Set((value as? [Any] ?? []).compactMap { $0 as? String }.filter { !$0.contains("://") && !$0.hasPrefix("<") && !$0.hasPrefix("*") })
  }

  static func stage(id: String, source: URL, profile: String, grants: WebKitExtensionGrants) -> Staged {
    guard let manifest = manifest(at: source) else {
      return Staged(folder: source, apis: [], nativeMessaging: false, signature: source.standardizedFileURL.path)
    }
    let required = permissionNames(manifest["permissions"])
    let optional = permissionNames(manifest["optional_permissions"])
    let granted = required.union(optional.intersection(grants.apis))
    let apis = WebKitExtensionShim.staged(granted: granted)
    let nativeMessaging = granted.contains("nativeMessaging")
    let plain = Staged(folder: source, apis: apis, nativeMessaging: nativeMessaging, signature: source.standardizedFileURL.path)
    guard !apis.isEmpty else { return plain }
    let shared = WebKitExtensionShared.available
    let signature = [
      "\(revision)", source.standardizedFileURL.path, "\(newestChange(in: source))", apis.sorted().joined(separator: ","), granted.sorted().joined(separator: ","),
      shared.sorted().joined(separator: ","),
    ].joined(separator: "|")
    let target = root(profile: profile).appendingPathComponent(id, isDirectory: true).appendingPathComponent(version(of: signature), isDirectory: true)
    let staged = Staged(folder: target, apis: apis, nativeMessaging: nativeMessaging, signature: signature)
    if (try? String(contentsOf: target.appendingPathComponent(markerFile), encoding: .utf8)) == signature { return staged }
    let scratch = target.deletingLastPathComponent().appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
    do {
      try write(manifest, from: source, to: scratch, apis: apis, permissions: granted, shared: shared)
      try signature.write(to: scratch.appendingPathComponent(markerFile), atomically: true, encoding: .utf8)
      if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
      try FileManager.default.moveItem(at: scratch, to: target)
      return staged
    } catch {
      NSLog("[webkit] extension %@ couldn't be staged: %@", id, error.localizedDescription)
      try? FileManager.default.removeItem(at: scratch)
      return plain
    }
  }

  static func version(of signature: String) -> String {
    SHA256.hash(data: Data(signature.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
  }

  static func forgetAll(except kept: [String: URL], profile: String) {
    let files = FileManager.default
    let folder = root(profile: profile)
    for name in (try? files.contentsOfDirectory(atPath: folder.path)) ?? [] {
      let extensionFolder = folder.appendingPathComponent(name, isDirectory: true)
      guard let keep = kept[name] else {
        try? files.removeItem(at: extensionFolder)
        continue
      }
      for version in (try? files.contentsOfDirectory(atPath: extensionFolder.path)) ?? [] where version != keep.lastPathComponent {
        try? files.removeItem(at: extensionFolder.appendingPathComponent(version, isDirectory: true))
      }
    }
  }

  static func hostMatches(contentScripts: [[String: Any]]) -> [String] {
    contentScripts.filter { !(($0["js"] as? [String]) ?? []).contains(pageFile) }.flatMap { $0["matches"] as? [String] ?? [] }
  }

  private static func newestChange(in folder: URL) -> Int {
    let keys: [URLResourceKey] = [.contentModificationDateKey, .isRegularFileKey]
    guard let files = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys) else { return 0 }
    var newest = 0.0
    var count = 0
    for case let file as URL in files {
      guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
      count += 1
      newest = max(newest, values.contentModificationDate?.timeIntervalSince1970 ?? 0)
    }
    return Int(newest) * 100_000 + count
  }

  private static func write(_ manifest: [String: Any], from source: URL, to target: URL, apis: Set<String>, permissions granted: Set<String>,
                            shared: Set<String>) throws {
    let files = FileManager.default
    try files.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try files.copyItem(at: source, to: target)
    let relay = WebKitExtensionShim.relayKey()
    let contentApis = WebKitExtensionShim.contentApis(apis)
    var contentScripts = manifest["content_scripts"] as? [[String: Any]] ?? []
    let contentShim = !contentApis.isEmpty && (!contentScripts.isEmpty || injectsScripts(manifest, permissions: granted))
    try WebKitExtensionShim.source(apis: apis, permissions: granted, shared: shared, relay: relay, contentFile: contentShim ? contentFile : "")
      .write(to: target.appendingPathComponent(WebKitExtensionShim.fileName), atomically: true, encoding: .utf8)
    var edited = manifest
    var permissions = manifest["permissions"] as? [Any] ?? []
    if !permissions.contains(where: { ($0 as? String) == "nativeMessaging" }) { permissions.append("nativeMessaging") }
    edited["permissions"] = permissions
    if contentShim {
      try WebKitExtensionShim.source(apis: contentApis, permissions: granted, content: true, shared: shared, relay: relay)
        .write(to: target.appendingPathComponent(contentFile), atomically: true, encoding: .utf8)
      contentScripts = contentScripts.map(withContentShim)
      if !contentScripts.isEmpty { edited["content_scripts"] = contentScripts }
    }
    if let scripts = edited["content_scripts"] as? [[String: Any]] { edited["content_scripts"] = scripts.map(withoutPorts) }
    let connectable = ((manifest["externally_connectable"] as? [String: Any])?["matches"] as? [Any] ?? []).compactMap { $0 as? String }
    if !connectable.isEmpty {
      try pageAlias.write(to: target.appendingPathComponent(pageFile), atomically: true, encoding: .utf8)
      edited["content_scripts"] = (edited["content_scripts"] as? [[String: Any]] ?? [])
        + [["matches": connectable, "js": [pageFile], "world": "MAIN", "run_at": "document_start", "all_frames": true]]
    }
    var background = manifest["background"] as? [String: Any] ?? [:]
    if background.isEmpty, contentShim {
      background = (manifest["manifest_version"] as? Int ?? 2) >= 3 ? ["service_worker": backgroundFlagFile] : ["scripts": [backgroundFlagFile], "persistent": false]
    }
    let backgroundPath = (background["service_worker"] as? String).map(relative) ?? ""
    try "globalThis.__ardiaWebKitBackground = \(backgroundFlag(backgroundPath));\n".write(to: target.appendingPathComponent(backgroundFlagFile), atomically: true, encoding: .utf8)
    if !background.isEmpty {
      try wrapBackground(&background, in: target)
      edited["background"] = background
    }
    let data = try JSONSerialization.data(withJSONObject: edited, options: [.withoutEscapingSlashes])
    try data.write(to: target.appendingPathComponent("manifest.json"), options: .atomic)
    try injectPages(in: target, background: (background["page"] as? String).map(relative))
  }

  static func injectsScripts(_ manifest: [String: Any], permissions: Set<String>) -> Bool {
    permissions.contains("scripting") || (manifest["manifest_version"] as? Int ?? 2) < 3
  }

  static func backgroundFlag(_ path: String) -> String {
    guard !path.isEmpty, path != backgroundFlagFile, let data = try? JSONSerialization.data(withJSONObject: [path]), let list = String(data: data, encoding: .utf8) else { return "true" }
    return String(list.dropFirst().dropLast())
  }

  static func withContentShim(_ entry: [String: Any]) -> [String: Any] {
    guard let scripts = entry["js"] as? [String], !scripts.isEmpty else { return entry }
    var edited = entry
    edited["js"] = [contentFile] + scripts.map(relative).filter { $0 != contentFile }
    return edited
  }

  static func withoutPorts(_ entry: [String: Any]) -> [String: Any] {
    var edited = entry
    for key in ["matches", "exclude_matches"] {
      guard let patterns = entry[key] as? [String] else { continue }
      var seen = Set<String>()
      edited[key] = patterns.map(withoutPort).filter { seen.insert($0).inserted }
    }
    return edited
  }

  static func withoutPort(_ pattern: String) -> String {
    guard let scheme = pattern.range(of: "://") else { return pattern }
    let rest = pattern[scheme.upperBound...]
    let hostEnd = rest.firstIndex(of: "/") ?? rest.endIndex
    let host = rest[..<hostEnd]
    guard !host.hasPrefix("["), let colon = host.lastIndex(of: ":") else { return pattern }
    let port = host[host.index(after: colon)...]
    guard port == "*" || (!port.isEmpty && port.allSatisfy(\.isNumber)) else { return pattern }
    return String(pattern[..<scheme.upperBound]) + host[..<colon] + rest[hostEnd...]
  }

  private static func relative(_ path: String) -> String { String(path.drop { $0 == "/" }) }

  static func wrapBackground(_ background: inout [String: Any], in target: URL) throws {
    let shim = WebKitExtensionShim.fileName
    let flag = backgroundFlagFile
    if let scripts = background["scripts"] as? [String], !scripts.isEmpty {
      background["scripts"] = [flag, shim] + scripts.map(relative).filter { $0 != shim && $0 != flag }
      return
    }
    guard let worker = background["service_worker"] as? String, !worker.isEmpty else { return }
    let path = relative(worker)
    let imports = [flag, shim] + (path == flag ? [] : [path])
    let wrapper = (background["type"] as? String) == "module"
      ? imports.map { "import \"/\($0)\";\n" }.joined()
      : "importScripts(\(imports.map { "\"/\($0)\"" }.joined(separator: ", ")));\n"
    try wrapper.write(to: target.appendingPathComponent(workerFile), atomically: true, encoding: .utf8)
    background["service_worker"] = workerFile
  }

  static func injected(_ html: String, background: Bool = false) -> String {
    let shim = "<script src=\"/\(WebKitExtensionShim.fileName)\"></script>"
    let tag = background ? "<script src=\"/\(backgroundFlagFile)\"></script>" + shim : shim
    guard !html.contains(shim) else { return html }
    for opener in ["<head[\\s>]", "<html[\\s>]"] {
      guard let start = html.range(of: opener, options: [.regularExpression, .caseInsensitive]),
        let end = html.range(of: ">", range: start.lowerBound..<html.endIndex)
      else { continue }
      return html.replacingCharacters(in: end.upperBound..<end.upperBound, with: tag)
    }
    let doctype = html.range(of: "<!doctype", options: .caseInsensitive).flatMap { html.range(of: ">", range: $0.upperBound..<html.endIndex) }
    guard let doctype else { return tag + html }
    return html.replacingCharacters(in: doctype.upperBound..<doctype.upperBound, with: tag)
  }

  private static func injectPages(in folder: URL, background: String?) throws {
    guard let files = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) else { return }
    let backgroundPath = background.map { folder.appendingPathComponent($0).standardizedFileURL.path }
    for case let file as URL in files where ["html", "htm"].contains(file.pathExtension.lowercased()) {
      guard let html = try? String(contentsOf: file, encoding: .utf8) else { continue }
      let edited = injected(html, background: file.standardizedFileURL.path == backgroundPath)
      if edited != html { try edited.write(to: file, atomically: true, encoding: .utf8) }
    }
  }
}
