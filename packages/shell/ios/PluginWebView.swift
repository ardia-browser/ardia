import AppKit
import ArdiaCore
import WebKit

final class PluginWebView: WKWebView {
  private let edits = UndoManager()
  private var keyUpOfReservedKey: UInt16?

  override var undoManager: UndoManager? { edits }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard (window?.firstResponder as? NSView)?.isDescendant(of: self) == true else { return super.performKeyEquivalent(with: event) }
    let reserved = ArdiaPerformReservedKey(event)
    keyUpOfReservedKey = reserved ? event.keyCode : nil
    return reserved || super.performKeyEquivalent(with: event)
  }

  override func keyDown(with event: NSEvent) {
    keyUpOfReservedKey = nil
    super.keyDown(with: event)
  }

  override func keyUp(with event: NSEvent) {
    if keyUpOfReservedKey == event.keyCode {
      keyUpOfReservedKey = nil
      return
    }
    super.keyUp(with: event)
  }

  override func resignFirstResponder() -> Bool {
    keyUpOfReservedKey = nil
    return super.resignFirstResponder()
  }

  @objc func undo(_ sender: Any?) {
    if edits.canUndo { edits.undo() }
  }

  @objc func redo(_ sender: Any?) {
    if edits.canRedo { edits.redo() }
  }

  override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
    if item.action == #selector(undo(_:)) { return edits.canUndo }
    if item.action == #selector(redo(_:)) { return edits.canRedo }
    return super.validateUserInterfaceItem(item)
  }

  override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
    super.willOpenMenu(menu, with: event)
    guard LaunchConfig.shared.background else { return }
    if !menu.items.isEmpty { NSLog("[plugins] page context menu (background mode, not shown): %@", menu.items.map(\.title).joined(separator: ", ")) }
    menu.removeAllItems()
  }
}
