import AppKit

enum KeyRepeatGate {
  static let ignoredCommands: Set<String> = ["focusCommandBar"]
  private static var keyEquivalentEvent: NSEvent?

  static func withKeyEquivalent<T>(_ event: NSEvent, _ body: () -> T) -> T {
    let previous = keyEquivalentEvent
    keyEquivalentEvent = event
    defer { keyEquivalentEvent = previous }
    return body()
  }

  static func dispatches(_ command: String, keyDown: Bool, repeated: Bool) -> Bool {
    !(keyDown && repeated && ignoredCommands.contains(command))
  }

  static func dispatches(_ command: String, fallback: NSEvent?) -> Bool {
    let event = keyEquivalentEvent ?? fallback
    let keyDown = event?.type == .keyDown
    return dispatches(command, keyDown: keyDown, repeated: keyDown && event?.isARepeat == true)
  }
}

final class KeyEquivalentMenu: NSMenu {
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    KeyRepeatGate.withKeyEquivalent(event) {
      super.performKeyEquivalent(with: event)
    }
  }
}
