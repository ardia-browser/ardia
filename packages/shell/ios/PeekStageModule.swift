import AppKit
import ArdiaCore
import ExpoModulesCore

public class PeekStageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPeekStage")

    AsyncFunction("devState") { (windowId: String) -> [[String: Any]] in
      #if DEBUG
      guard let window = WindowManager.shared.window(windowId) else { return [] }
      let live = PeekStage.stages.allObjects.filter { $0.window === window }.map { $0.devState() }
      return live.isEmpty ? PeekStage.lastDetached.map { [$0] } ?? [] : live
      #else
      return []
      #endif
    }.runOnQueue(.main)

    AsyncFunction("devPageFrames") { (windowId: String) -> [[String: Any]] in
      #if DEBUG
      guard let root = WindowManager.shared.window(windowId)?.contentView else { return [] }
      var found: [[String: Any]] = []
      var queue: [NSView] = [root]
      while !queue.isEmpty {
        let view = queue.removeFirst()
        if let web = view as? ArdiaWebView {
          let r = web.convert(web.bounds, to: nil)
          let height = root.frame.height
          found.append([
            "tabId": web.transferKey ?? "", "browserId": web.browserId, "visible": web.visible,
            "frame": ["x": r.minX, "y": height - r.maxY, "width": r.width, "height": r.height],
            "inPeek": sequence(first: web as NSView, next: { $0.superview }).contains { $0 is PeekStage },
          ])
        }
        queue.append(contentsOf: view.subviews)
      }
      return found
      #else
      return []
      #endif
    }.runOnQueue(.main)

    AsyncFunction("devPostMagnify") { (windowId: String, x: Double, y: Double, phase: String, magnification: Double) -> [String: Any] in
      #if DEBUG
      guard let window = WindowManager.shared.window(windowId), let content = window.contentView else { return ["error": "no window"] }
      let point = content.convert(SyntheticInput.contentPoint(x: x, top: y, in: content), to: nil)
      let screen = window.convertPoint(toScreen: point)
      let top = NSScreen.screens.first?.frame.maxY ?? 0
      guard let event = CGEvent(source: nil) else { return ["error": "no event"] }
      event.type = CGEventType(rawValue: 29)!
      event.location = CGPoint(x: screen.x, y: top - screen.y)
      event.setIntegerValueField(CGEventField(rawValue: 110)!, value: 8)
      event.setDoubleValueField(CGEventField(rawValue: 113)!, value: magnification)
      let phases: [String: Int64] = ["began": 1, "changed": 2, "ended": 4, "cancelled": 8]
      event.setIntegerValueField(CGEventField(rawValue: 132)!, value: phases[phase] ?? 2)
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
      event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
      guard let ns = NSEvent(cgEvent: event) else { return ["error": "no NSEvent"] }
      let isMagnify = ns.type == .magnify
      if isMagnify { NSApp.postEvent(ns, atStart: false) }
      return ["seen": MagnifyArea.seen, "claimed": MagnifyArea.claimedCount, "type": ns.type.rawValue, "magnify": isMagnify, "phase": isMagnify ? ns.phase.rawValue : -1, "magnification": isMagnify ? ns.magnification : 0, "window": ns.windowNumber]
      #else
      return ["error": "DEV builds only"]
      #endif
    }.runOnQueue(.main)

    AsyncFunction("devPostScroll") { (windowId: String, x: Double, y: Double, dy: Int) -> [String: Any] in
      #if DEBUG
      guard let window = WindowManager.shared.window(windowId), let content = window.contentView else { return ["error": "no window"] }
      let point = content.convert(SyntheticInput.contentPoint(x: x, top: y, in: content), to: nil)
      let screen = window.convertPoint(toScreen: point)
      let top = NSScreen.screens.first?.frame.maxY ?? 0
      guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(dy), wheel2: 0, wheel3: 0) else { return ["error": "no event"] }
      event.location = CGPoint(x: screen.x, y: top - screen.y)
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
      event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
      guard let ns = NSEvent(cgEvent: event) else { return ["error": "no NSEvent"] }
      NSApp.postEvent(ns, atStart: false)
      return ["type": ns.type.rawValue, "window": ns.windowNumber]
      #else
      return ["error": "DEV builds only"]
      #endif
    }.runOnQueue(.main)

    AsyncFunction("devPostButton") { (windowId: String, x: Double, y: Double, button: Int) -> [String: Any] in
      #if DEBUG
      guard let window = WindowManager.shared.window(windowId), let content = window.contentView else { return ["error": "no window"] }
      let point = content.convert(SyntheticInput.contentPoint(x: x, top: y, in: content), to: nil)
      var posted: [Int] = []
      for type in [NSEvent.EventType.otherMouseDown, .otherMouseUp] {
        guard let base = NSEvent.mouseEvent(
          with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .otherMouseDown ? 1 : 0),
          let cg = base.cgEvent?.copy() else { return ["error": "no event"] }
        cg.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button))
        guard let ns = NSEvent(cgEvent: cg) else { return ["error": "no NSEvent"] }
        posted.append(ns.buttonNumber)
        posted.append(ns.window === window ? 1 : 0)
        NSApp.postEvent(ns, atStart: false)
      }
      return ["posted": posted]
      #else
      return ["error": "DEV builds only"]
      #endif
    }.runOnQueue(.main)

    View(PeekStage.self) {
      Prop("geometry") { (view: PeekStage, geometry: [String: Any]) in view.setGeometry(geometry) }
      Prop("reduceMotion") { (view: PeekStage, on: Bool) in view.reduceMotion = on }
      Prop("gestures") { (view: PeekStage, on: Bool) in view.gestures = on }
      Prop("meshAllowed") { (view: PeekStage, on: Bool) in view.meshAllowed = on }
      Events("onPeekState", "onPeekDone", "onPeekPinch")
      AsyncFunction("begin") { (view: PeekStage, generation: Int, animated: Bool) -> Bool in view.begin(generation, animated: animated) }.runOnQueue(.main)
      AsyncFunction("close") { (view: PeekStage, generation: Int) -> Bool in view.close(generation) }.runOnQueue(.main)
      AsyncFunction("promote") { (view: PeekStage, generation: Int) -> Bool in view.promote(generation) }.runOnQueue(.main)
    }
  }
}
