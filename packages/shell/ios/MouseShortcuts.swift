import AppKit

final class MouseShortcuts {
  static let shared = MouseShortcuts()

  private var table = MouseShortcutTable()
  private var monitor: Any?
  private var heldButtons = Set<Int>()
  private(set) var installs = 0

  var isInstalled: Bool { monitor != nil }

  func update(_ bindings: [String: [String]]) {
    table = MouseShortcutTable(bindings)
    if table.isEmpty { uninstallWhenReleased() } else { install() }
  }

  static func browserWindowId(of window: NSWindow?) -> String? {
    guard WindowManager.shared.kind(of: window)?.isBrowser == true else { return nil }
    return WindowManager.shared.id(of: window)
  }

  static func bindable(_ item: NSMenuItem) -> CommandItem? {
    guard let item = item as? CommandItem, item.command != "tabSwitcher" else { return nil }
    return item
  }

  private func install() {
    guard monitor == nil else { return }
    installs += 1
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .otherMouseDragged, .otherMouseUp]) { [weak self] event in
      guard let self else { return event }
      return self.filter(event)
    }
  }

  private func uninstallWhenReleased() {
    guard heldButtons.isEmpty, let monitor else { return }
    NSEvent.removeMonitor(monitor)
    self.monitor = nil
  }

  private func filter(_ event: NSEvent) -> NSEvent? {
    let button = event.buttonNumber
    guard event.type == .otherMouseDown else {
      guard heldButtons.contains(button) else { return event }
      if event.type == .otherMouseUp {
        heldButtons.remove(button)
        if table.isEmpty { uninstallWhenReleased() }
      }
      return nil
    }
    heldButtons.remove(button)
    guard !ShortcutRecorder.shared.isRecording,
      let id = table.command(button: button, modifierFlags: event.modifierFlags.rawValue),
      let window = event.window, let windowId = MouseShortcuts.browserWindowId(of: window),
      let item = MainMenu.commandItem(shortcutId: id)
    else { return event }
    heldButtons.insert(button)
    if window !== NSApp.keyWindow || MenuTarget.shared.validateMenuItem(item) {
      MenuTarget.shared.perform(item, in: window, windowId: windowId, mouseButton: MouseShortcutTable.telemetryNames[button])
    }
    return nil
  }
}
