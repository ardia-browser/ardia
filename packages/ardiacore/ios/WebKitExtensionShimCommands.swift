import AppKit
import WebKit

struct WebKitExtensionShortcut: Equatable {
  let extensionId: String
  let command: String
  let modifiers: NSEvent.ModifierFlags
  let key: String

  static let actionCommands: Set<String> = ["_execute_action", "_execute_browser_action", "_execute_page_action"]
  static let relevantModifiers: NSEvent.ModifierFlags = [.command, .control, .option, .shift]

  private static let keyCodes: [String: UInt16] = [
    "Comma": 43, "Period": 47, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121, "Space": 49, "Insert": 114, "Delete": 117,
    "Up": 126, "Down": 125, "Left": 123, "Right": 124, "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100,
    "F9": 101, "F10": 109, "F11": 103, "F12": 111,
  ]
  private static let glyphs: [String: String] = ["Comma": ",", "Period": ".", "Up": "↑", "Down": "↓", "Left": "←", "Right": "→"]

  init?(binding: String, extensionId: String, command: String) {
    let accelerator = binding.split(separator: ":", maxSplits: 1).last.map(String.init) ?? binding
    let parts = (accelerator.split(separator: ":").first.map(String.init) ?? accelerator).split(separator: "+").map(String.init)
    guard let key = parts.last, !key.isEmpty else { return nil }
    var modifiers: NSEvent.ModifierFlags = []
    for part in parts.dropLast() {
      switch part {
      case "Command": modifiers.insert(.command)
      case "Ctrl", "MacCtrl": modifiers.insert(.control)
      case "Alt": modifiers.insert(.option)
      case "Shift": modifiers.insert(.shift)
      default: return nil
      }
    }
    self.extensionId = extensionId
    self.command = command
    self.modifiers = modifiers
    self.key = key
  }

  var isAction: Bool { Self.actionCommands.contains(command) }

  var display: String {
    var text = ""
    if modifiers.contains(.control) { text += "⌃" }
    if modifiers.contains(.option) { text += "⌥" }
    if modifiers.contains(.shift) { text += "⇧" }
    if modifiers.contains(.command) { text += "⌘" }
    return text + (Self.glyphs[key] ?? key)
  }

  func matches(_ event: NSEvent) -> Bool {
    guard event.type == .keyDown, event.modifierFlags.intersection(Self.relevantModifiers) == modifiers else { return false }
    if let code = Self.keyCodes[key] { return event.keyCode == code }
    if key.hasPrefix("Media") { return false }
    let base = event.characters(byApplyingModifiers: []) ?? event.charactersIgnoringModifiers ?? ""
    return base.uppercased() == key.uppercased()
  }

  static func preferences(profile: String) -> URL {
    URL(fileURLWithPath: ArdiaServices.profileDirectory(profile), isDirectory: true).appendingPathComponent("Preferences")
  }

  static func read(profile: String) -> [WebKitExtensionShortcut] {
    let file = preferences(profile: profile)
    guard let data = try? Data(contentsOf: file), let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let commands = (root["extensions"] as? [String: Any])?["commands"] as? [String: Any]
    else { return [] }
    return commands.compactMap { binding, value in
      guard binding.hasPrefix("mac:"), let entry = value as? [String: Any], entry["global"] as? Bool != true,
        let id = entry["extension"] as? String, let name = entry["command_name"] as? String
      else { return nil }
      return WebKitExtensionShortcut(binding: binding, extensionId: id, command: name)
    }
  }
}

@available(macOS 15.4, *)
@MainActor
final class WebKitExtensionShortcuts {
  static let shared = WebKitExtensionShortcuts()
  static let commandModifiers: NSEvent.ModifierFlags = [.command, .control, .option]

  private var monitor: Any?
  private var cache: [String: (changed: Date?, shortcuts: [WebKitExtensionShortcut])] = [:]

  func update(active: Bool) {
    if active, monitor == nil {
      monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
        MainActor.assumeIsolated { WebKitExtensionShortcuts.shared.handle(event) ? nil : event }
      }
    } else if !active, let monitor {
      NSEvent.removeMonitor(monitor)
      self.monitor = nil
      cache.removeAll()
    }
  }

  func shortcuts(profile: String) -> [WebKitExtensionShortcut] {
    let base = ArdiaHost.baseProfile(of: profile)
    let file = WebKitExtensionShortcut.preferences(profile: base)
    let changed = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    if let hit = cache[base], hit.changed == changed { return hit.shortcuts }
    let read = WebKitExtensionShortcut.read(profile: base)
    cache[base] = (changed, read)
    return read
  }

  private func handle(_ event: NSEvent) -> Bool {
    guard !event.modifierFlags.isDisjoint(with: Self.commandModifiers) else { return false }
    guard let window = event.window ?? NSApp.keyWindow, window.isKeyWindow || NSApp.keyWindow === window else { return false }
    let shown = WebKitHub.shared.transfers.liveTabs.filter { $0.visible && $0.window === window && $0.webView != nil && !$0.closed }
    let focused = (window.firstResponder as? NSView).flatMap { responder in shown.first { responder.isDescendant(of: $0) } }
    let chromiumFocused = window.firstResponder.map { NSStringFromClass(type(of: $0)).contains("RenderWidgetHostView") } ?? false
    guard let tab = focused ?? (chromiumFocused ? nil : shown.first) else { return false }
    for bridge in WebKitExtensionBridge.live where bridge.owns(tab) {
      if bridge.performShortcut(event, tab: tab) { return true }
    }
    return false
  }
}

@available(macOS 15.4, *)
@MainActor
final class WebKitExtensionPageInput {
  static let shared = WebKitExtensionPageInput()

  private var monitor: Any?

  func start() {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { event in
      MainActor.assumeIsolated { WebKitExtensionPageInput.shared.note(event) }
      return event
    }
  }

  private func note(_ event: NSEvent) {
    guard let window = event.window, let webView = Self.target(of: event, in: window), webView.url?.scheme == "webkit-extension" else { return }
    for bridge in WebKitExtensionBridge.live { bridge.notePageInput(in: webView) }
  }

  private static func target(of event: NSEvent, in window: NSWindow) -> WKWebView? {
    let start: NSView?
    if event.type == .keyDown {
      start = window.firstResponder as? NSView
    } else {
      let frame = window.contentView?.superview ?? window.contentView
      start = frame?.hitTest(event.locationInWindow)
    }
    var view = start
    while let current = view {
      if let webView = current as? WKWebView { return webView }
      view = current.superview
    }
    return nil
  }
}
