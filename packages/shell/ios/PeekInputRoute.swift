import AppKit

enum PeekInputRoute {
  struct Routed {
    weak var stage: PeekStage?
    var point: NSPoint
    var timestamp: TimeInterval
  }

  static var routed: Routed?

  private static let mask: NSEvent.EventTypeMask = [
    .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
    .otherMouseDown, .otherMouseUp, .otherMouseDragged, .mouseMoved, .scrollWheel,
  ]

  static let install: Void = {
    _ = NSEvent.addLocalMonitorForEvents(matching: mask) { event in
      guard let window = event.window ?? NSApp.orderedWindows.first(where: { $0.isVisible && $0.frame.contains(event.locationInWindow) }) else { return event }
      let location = event.window == nil ? window.convertPoint(fromScreen: event.locationInWindow) : event.locationInWindow
      for stage in PeekStage.stages.allObjects where stage.window === window {
        if let mapped = stage.remap(event, at: location) { return mapped }
      }
      return event
    }
  }()

  static func matches(_ stage: PeekStage, windowPoint: NSPoint) -> Bool {
    guard let routed, routed.stage === stage, let current = NSApp.currentEvent, current.timestamp == routed.timestamp else { return false }
    return abs(routed.point.x - windowPoint.x) < 1 && abs(routed.point.y - windowPoint.y) < 1
  }

  static func moved(_ event: NSEvent, to windowPoint: NSPoint, in window: NSWindow) -> NSEvent? {
    switch event.type {
    case .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
         .otherMouseDown, .otherMouseUp, .otherMouseDragged, .mouseMoved:
      guard let rebuilt = NSEvent.mouseEvent(
        with: event.type, location: windowPoint, modifierFlags: event.modifierFlags, timestamp: event.timestamp,
        windowNumber: window.windowNumber, context: nil, eventNumber: event.eventNumber, clickCount: event.clickCount, pressure: event.pressure)
      else { return nil }
      guard let original = event.cgEvent, let copy = rebuilt.cgEvent?.copy() else { return rebuilt }
      for field in [CGEventField.mouseEventButtonNumber, .mouseEventDeltaX, .mouseEventDeltaY, .mouseEventSubtype] {
        copy.setIntegerValueField(field, value: original.getIntegerValueField(field))
      }
      return NSEvent(cgEvent: copy) ?? rebuilt
    default:
      guard let copy = event.cgEvent?.copy() else { return nil }
      let screen = window.convertPoint(toScreen: windowPoint)
      let top = NSScreen.screens.first?.frame.maxY ?? 0
      copy.location = CGPoint(x: screen.x, y: top - screen.y)
      copy.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
      copy.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
      guard let mapped = NSEvent(cgEvent: copy), mapped.window === window || event.window == nil else { return nil }
      return mapped
    }
  }
}
