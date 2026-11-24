import AppKit
import ExpoModulesCore
import UniformTypeIdentifiers
import ServiceManagement

final class ShortcutRecorder {
  static let shared = ShortcutRecorder()
  private var monitor: Any?
  private var promise: Promise?
  private var owner: ObjectIdentifier?
  private var releaseMonitor: Any?

  var isRecording: Bool { monitor != nil }

  func record(_ promise: Promise, for module: AnyObject) {
    finish(nil)
    self.promise = promise
    owner = ObjectIdentifier(module)
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
      guard let self else { return event }
      if event.type == .otherMouseDown {
        guard let key = MouseShortcutTable.buttonKeys[event.buttonNumber], MouseShortcuts.browserWindowId(of: event.window) == nil else {
          self.finish(nil)
          return event
        }
        self.finish(["key": key, "modifiers": MouseShortcutTable.modifierNames(event.modifierFlags.rawValue)])
        self.swallowRelease(of: event.buttonNumber)
        return nil
      }
      guard event.type == .keyDown else {
        self.finish(nil)
        return event
      }
      let flags = event.modifierFlags.intersection([.command, .option, .control, .shift, .function])
      if event.keyCode == 53, flags.subtracting(.function).isEmpty {
        self.finish(nil)
        return nil
      }
      let unmodified = event.charactersIgnoringModifiers ?? ""
      let navigationKey = unmodified.unicodeScalars.first.map { (0xF700...0xF8FF).contains($0.value) } ?? false
      let key = navigationKey ? unmodified : (event.characters(byApplyingModifiers: []) ?? unmodified).lowercased()
      guard !key.isEmpty else { return nil }
      let functionKey = key.unicodeScalars.first.map { (0xF704...0xF726).contains($0.value) } ?? false
      guard flags.contains(.command) || flags.contains(.control) || flags.contains(.option) || functionKey else {
        NSSound.beep()
        return nil
      }
      var mods: [String] = []
      if flags.contains(.control) { mods.append("control") }
      if flags.contains(.option) { mods.append("option") }
      if flags.contains(.shift) { mods.append("shift") }
      if flags.contains(.command) { mods.append("command") }
      if flags.contains(.function), let scalar = key.unicodeScalars.first, scalar.value < 0xF700 { mods.append("function") }
      self.finish(["key": key, "modifiers": mods])
      return nil
    }
  }

  private func swallowRelease(of button: Int) {
    if let releaseMonitor { NSEvent.removeMonitor(releaseMonitor) }
    releaseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDragged, .otherMouseUp]) { [weak self] event in
      guard let self, event.buttonNumber == button else { return event }
      if event.type == .otherMouseUp, let monitor = self.releaseMonitor {
        NSEvent.removeMonitor(monitor)
        self.releaseMonitor = nil
      }
      return nil
    }
  }

  func finish(_ result: [String: Any]?) {
    let pending = stop()
    pending?.resolve(result)
  }

  func abandon(by module: AnyObject) {
    guard owner == ObjectIdentifier(module) else { return }
    _ = stop()
  }

  private func stop() -> Promise? {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    owner = nil
    let pending = promise
    promise = nil
    return pending
  }
}
