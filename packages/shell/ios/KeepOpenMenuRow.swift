import AppKit

final class KeepOpenMenuRow: NSView {
  let id: String
  private var title: String
  private var checked: Bool
  private var enabled: Bool
  private var highlighted = false {
    didSet { if highlighted != oldValue { needsDisplay = true } }
  }

  private static let font = NSFont.menuFont(ofSize: 0)
  private static let titleInset: CGFloat = 30
  private static let checkCenter: CGFloat = 17.5
  private static let trailingInset: CGFloat = 20
  private static let highlightInset: CGFloat = 5
  private static let rowHeight: CGFloat = {
    let menu = NSMenu()
    menu.addItem(withTitle: "M", action: nil, keyEquivalent: "")
    let one = menu.size.height
    menu.addItem(withTitle: "M", action: nil, keyEquivalent: "")
    return menu.size.height - one
  }()

  init(_ item: MenuItem) {
    id = item.id
    title = item.title
    checked = item.checked
    enabled = item.enabled
    super.init(frame: .zero)
    autoresizingMask = [.width]
    setFrameSize(NSSize(width: Self.width(of: title), height: Self.rowHeight))
  }

  required init?(coder: NSCoder) { nil }

  func update(_ item: MenuItem) {
    title = item.title
    checked = item.checked
    enabled = item.enabled
    enclosingMenuItem?.state = item.checked ? .on : .off
    enclosingMenuItem?.isEnabled = item.enabled
    needsDisplay = true
  }

  private static func width(of title: String) -> CGFloat {
    ceil(titleInset + (title as NSString).size(withAttributes: [.font: font]).width + trailingInset)
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  override func mouseEntered(with event: NSEvent) { highlighted = true }
  override func mouseExited(with event: NSEvent) { highlighted = false }

  override func mouseUp(with event: NSEvent) {
    guard enabled else { return }
    ShellEvents.send(.command, ["command": "menu.pick", "arg": id, "windowId": NSNull()])
  }

  override func draw(_ dirtyRect: NSRect) {
    let lit = enabled && highlighted
    if lit {
      NSColor.controlAccentColor.setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: Self.highlightInset, dy: 0), xRadius: 6, yRadius: 6).fill()
    }
    let color: NSColor = lit ? .selectedMenuItemTextColor : enabled ? .labelColor : .disabledControlTextColor
    let attributes: [NSAttributedString.Key: Any] = [.font: Self.font, .foregroundColor: color]
    let size = (title as NSString).size(withAttributes: attributes)
    (title as NSString).draw(at: NSPoint(x: Self.titleInset, y: (bounds.height - size.height) / 2), withAttributes: attributes)
    guard checked,
          let mark = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: Self.font.pointSize - 2, weight: .semibold).applying(.init(paletteColors: [color])))
    else { return }
    let markOrigin = NSPoint(x: Self.checkCenter - mark.size.width / 2, y: (bounds.height - mark.size.height) / 2)
    mark.draw(in: NSRect(origin: markOrigin, size: mark.size))
  }
}
