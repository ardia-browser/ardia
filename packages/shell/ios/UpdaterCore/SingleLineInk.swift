import AppKit

enum SingleLineInk {
  static func labelField() -> NSTextField {
    let field = NSTextField(labelWithString: "")
    field.lineBreakMode = .byClipping
    field.maximumNumberOfLines = 1
    field.cell?.truncatesLastVisibleLine = false
    field.isSelectable = false
    return field
  }

  static func fitting(_ field: NSTextField) -> NSSize {
    field.frame(forAlignmentRect: NSRect(origin: .zero, size: field.intrinsicContentSize)).size
  }

  static func draw(_ field: NSTextField, size: NSSize) {
    let box = NSRect(origin: .zero, size: size)
    if field.frame != box { field.frame = box }
    field.cell?.draw(withFrame: box, in: field)
  }
}
