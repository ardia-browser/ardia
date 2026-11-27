import AppKit

struct WebKitPagePresses {
  enum Navigation: Equatable {
    case back
    case forward
  }

  enum Verdict: Equatable {
    case pass
    case drop
    case refuse
    case swallow
    case navigate(Navigation)
  }

  private var held = Set<Int>()

  static func navigation(for event: NSEvent) -> Navigation? {
    guard [.otherMouseDown, .otherMouseDragged, .otherMouseUp].contains(event.type) else { return nil }
    switch event.buttonNumber {
    case 3: return .back
    case 4: return .forward
    default: return nil
    }
  }

  static func lands(_ event: NSEvent, on view: NSView) -> Bool {
    guard let window = view.window, event.window === window, let frame = window.contentView?.superview else { return true }
    guard let hit = frame.hitTest(event.locationInWindow) else { return false }
    return hit === view || hit.isDescendant(of: view)
  }

  mutating func verdict(for event: NSEvent, on view: NSView) -> Verdict {
    let button = event.buttonNumber
    let navigation = Self.navigation(for: event)
    switch event.type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      guard Self.lands(event, on: view) else {
        held.remove(button)
        return .refuse
      }
      held.insert(button)
      return navigation != nil ? .swallow : .pass
    case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
      guard held.contains(button) else { return .drop }
      return navigation != nil ? .swallow : .pass
    case .leftMouseUp, .rightMouseUp, .otherMouseUp:
      guard held.remove(button) != nil else { return .drop }
      if let navigation {
        return view.window != nil && !view.isHiddenOrHasHiddenAncestor ? .navigate(navigation) : .swallow
      }
      return .pass
    default:
      return .pass
    }
  }
}
