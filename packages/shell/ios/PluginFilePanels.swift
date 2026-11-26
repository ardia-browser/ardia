import AppKit
import ArdiaCore
import Darwin
import Foundation
import UniformTypeIdentifiers

enum PluginFilePanels {
  static let maxFiles = 16
  static let maxFileBytes = 64 << 20
  static let maxTypes = 32

  static func unavailable() -> [String: Any]? {
    LaunchConfig.shared.background ? ["ok": false, "reason": "a background instance doesn't open file panels"] : nil
  }

  static func contentTypes(_ given: [String]) -> [UTType] {
    given.prefix(maxTypes).compactMap { entry in
      let text = entry.trimmingCharacters(in: .whitespaces).lowercased()
      if text.contains("/") { return UTType(mimeType: text) }
      return UTType(filenameExtension: text.hasPrefix(".") ? String(text.dropFirst()) : text)
    }
  }

  static func mimeType(_ url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }

  static func isText(_ url: URL) -> Bool {
    UTType(filenameExtension: url.pathExtension)?.conforms(to: .text) ?? false
  }

  static func anchorWindow() -> NSWindow? { NSApp.keyWindow ?? NSApp.mainWindow }

  static func owner(_ spec: [String: Any]) -> (name: String, run: Int)? {
    guard let name = spec["name"] as? String, let run = (spec["run"] as? NSNumber)?.intValue else { return nil }
    return (name, run)
  }

  static func pick(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    if let refusal = unavailable() { return reply(refusal) }
    guard let owner = owner(spec) else { return reply(["ok": false, "reason": "pickFiles needs the plugin's run"]) }
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.resolvesAliases = true
    panel.allowsMultipleSelection = spec["multiple"] as? Bool ?? false
    if let title = spec["title"] as? String { panel.message = String(title.prefix(120)) }
    let types = contentTypes(spec["types"] as? [String] ?? [])
    if !types.isEmpty { panel.allowedContentTypes = types }
    let maxBytes = min(maxFileBytes, (spec["maxBytes"] as? NSNumber)?.intValue ?? maxFileBytes)
    let finish: (NSApplication.ModalResponse) -> Void = { response in
      guard response == .OK else { return reply(["ok": false, "cancelled": true, "reason": "you didn't pick a file"]) }
      let paths = panel.urls.prefix(maxFiles).map(\.path)
      DispatchQueue.global(qos: .userInitiated).async { reply(open(paths, owner: owner, maxBytes: maxBytes)) }
    }
    if let window = anchorWindow() { panel.beginSheetModal(for: window, completionHandler: finish) } else { panel.begin(completionHandler: finish) }
  }

  static func dropped(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    guard let owner = owner(spec), let paths = spec["paths"] as? [String], !paths.isEmpty else { return reply(["ok": false, "reason": "openDropped needs the plugin's run and paths"]) }
    let maxBytes = min(maxFileBytes, (spec["maxBytes"] as? NSNumber)?.intValue ?? maxFileBytes)
    DispatchQueue.global(qos: .userInitiated).async { reply(open(Array(paths.prefix(maxFiles)), owner: owner, maxBytes: maxBytes, skipRefused: true)) }
  }

  static func open(_ paths: [String], owner: (name: String, run: Int), maxBytes: Int, skipRefused: Bool = false) -> [String: Any] {
    let live = { PluginHost.shared.isLive(owner.name, run: owner.run) }
    let batch = PluginFileBatch.open(paths, maxBytes: maxBytes, skipRefused: skipRefused, textual: { isText(URL(fileURLWithPath: $0)) }, mimeType: { mimeType(URL(fileURLWithPath: $0)) }) { fd, size in
      PluginFileHandles.shared.addRead(owner.name, owner.run, fd: fd, size: size, live: live)
    } discard: { PluginFileHandles.shared.discard(owner.name, owner.run, $0) }
    switch batch {
    case .failure(let refusal): return ["ok": false, "reason": refusal.reason]
    case .success(let opened):
      guard live() else {
        PluginFileHandles.shared.discard(owner.name, owner.run, opened.handles)
        return ["ok": false, "reason": "the plugin stopped while the files were being opened"]
      }
      return ["ok": true, "files": opened.files]
    }
  }

  static func safeName(_ given: String) -> String {
    let cleaned = given.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmed = String(cleaned.drop(while: { $0 == "." }).prefix(200))
    return trimmed.isEmpty ? "Untitled" : trimmed
  }

  static func saveBegin(_ spec: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    if let refusal = unavailable() { return reply(refusal) }
    guard let owner = owner(spec), let name = spec["fileName"] as? String else { return reply(["ok": false, "reason": "saveBegin needs the plugin's run and a name"]) }
    let panel = NSSavePanel()
    panel.nameFieldStringValue = safeName(name)
    panel.canCreateDirectories = true
    let finish: (NSApplication.ModalResponse) -> Void = { response in
      guard response == .OK, let url = panel.url else { return reply(["ok": true, "saved": false]) }
      let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).part").path
      let fd = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
      guard fd >= 0 else { return reply(["ok": false, "reason": "the file couldn't be created there"]) }
      guard let handle = PluginFileHandles.shared.addWrite(owner.name, owner.run, fd: fd, temporary: temporary, destination: url, live: { PluginHost.shared.isLive(owner.name, run: owner.run) }) else { return reply(["ok": false, "reason": "the plugin has too many files open"]) }
      reply(["ok": true, "saved": true, "handle": handle, "name": url.lastPathComponent])
    }
    if let window = anchorWindow() { panel.beginSheetModal(for: window, completionHandler: finish) } else { panel.begin(completionHandler: finish) }
  }
}
