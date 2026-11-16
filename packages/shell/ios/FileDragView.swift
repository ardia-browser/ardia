import AppKit
import ArdiaCore
import ExpoModulesCore
import ServiceManagement
import UniformTypeIdentifiers

final class FileDragView: ExpoView, NSDraggingSource {
  var path: String?
  let onMiddleClick = EventDispatcher()
  private var downAt: NSPoint?
  private static let iconSide: CGFloat = 32

  override func otherMouseUp(with event: NSEvent) {
    guard event.buttonNumber == 2 else { return super.otherMouseUp(with: event) }
    let flags = event.modifierFlags
    onMiddleClick(["shiftKey": flags.contains(.shift), "altKey": flags.contains(.option), "metaKey": flags.contains(.command)])
  }

  override func mouseDown(with event: NSEvent) {
    downAt = event.locationInWindow
    super.mouseDown(with: event)
  }

  override func mouseDragged(with event: NSEvent) {
    guard let start = downAt, let path, FileManager.default.fileExists(atPath: path) else {
      return super.mouseDragged(with: event)
    }
    let p = event.locationInWindow
    guard hypot(p.x - start.x, p.y - start.y) > 4 else { return }
    downAt = nil
    let url = URL(fileURLWithPath: path)
    if LaunchConfig.shared.background {
      FileDropView.lastFileDrag = [url]
      return
    }
    let item = NSDraggingItem(pasteboardWriter: url as NSURL)
    let icon = NSWorkspace.shared.icon(forFile: path)
    let local = convert(event.locationInWindow, from: nil)
    let side = abs(convert(NSSize(width: Self.iconSide, height: Self.iconSide), from: nil).width)
    item.setDraggingFrame(NSRect(x: local.x - side / 2, y: local.y - side / 2, width: side, height: side), contents: icon)
    beginDraggingSession(with: [item], event: event, source: self)
  }

  override func mouseUp(with event: NSEvent) {
    downAt = nil
    super.mouseUp(with: event)
  }

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    [.copy, .generic]
  }
}
