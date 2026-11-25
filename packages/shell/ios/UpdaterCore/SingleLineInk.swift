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
    let size = field.frame(forAlignmentRect: NSRect(origin: .zero, size: field.intrinsicContentSize)).size
    guard let font = field.font, needsFallback(field.stringValue, font: font) else { return size }
    field.frame = NSRect(origin: .zero, size: size)
    let ink = CTLineGetBoundsWithOptions(CTLineCreateWithAttributedString(field.attributedStringValue), .useGlyphPathBounds)
    return NSSize(width: size.width, height: max(size.height, (field.firstBaselineOffsetFromTop - ink.minY + 0.5).rounded(.up)))
  }

  static func needsFallback(_ text: String, font: NSFont) -> Bool {
    if text.utf16.allSatisfy({ $0 < 0x0370 || (0x2000..<0x2070).contains($0) }) { return false }
    let units = Array(text.utf16)
    var glyphs = [CGGlyph](repeating: 0, count: units.count)
    return !CTFontGetGlyphsForCharacters(font, units, &glyphs, units.count)
  }

  static func draw(_ field: NSTextField, size: NSSize) {
    let box = NSRect(origin: .zero, size: size)
    if field.frame != box { field.frame = box }
    field.cell?.draw(withFrame: box, in: field)
  }
}
