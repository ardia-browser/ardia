import AppKit
import XCTest
@testable import ArdiaUpdaterCore

final class SingleLineInkTests: XCTestCase {
  private let sidebarTitleSizes: [(String, CGFloat)] = [("compact", 11), ("tab strip", 12), ("Default", 13), ("Large", 15), ("Larger", 17)]
  private let text = "Trip plan — Docpad, gypsy"

  private func inkRows(_ field: NSTextField, size: NSSize, scale: CGFloat = 2) -> (top: Int, bottom: Int, height: Int) {
    let width = Int((size.width * scale).rounded(.up)), height = Int((size.height * scale).rounded(.up))
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: 0, y: size.height)
    context.scaleBy(x: 1, y: -1)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
    NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance { SingleLineInk.draw(field, size: size) }
    NSGraphicsContext.restoreGraphicsState()
    let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
    var top = -1, bottom = -1
    for row in 0..<height where (0..<width).contains(where: { pixels[row * width * 4 + $0 * 4 + 3] > 20 }) {
      if top < 0 { top = row }
      bottom = row
    }
    return (top, bottom, height)
  }

  private func glyphHeight(_ font: NSFont) -> CGFloat {
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
    return CTLineGetBoundsWithOptions(line, .useGlyphPathBounds).height
  }

  func testATitleDrawsItsDescendersWholeAtEverySidebarTextSize() {
    let field = SingleLineInk.labelField()
    for weight in [NSFont.Weight.regular, .medium] {
      for (name, points) in sidebarTitleSizes {
        let font = NSFont.monospacedDigitSystemFont(ofSize: points, weight: weight)
        field.font = font
        field.textColor = .black
        field.stringValue = text
        let box = SingleLineInk.fitting(field)
        let ink = inkRows(field, size: NSSize(width: box.width, height: box.height))
        XCTAssertGreaterThanOrEqual(box.height, font.ascender - font.descender - 0.1, "\(name) \(points) pt: the line box is shorter than the font")
        XCTAssertGreaterThanOrEqual(ink.top, 0, "\(name) \(points) pt drew nothing")
        let drawn = CGFloat(ink.bottom - ink.top + 1) / 2
        XCTAssertGreaterThanOrEqual(drawn, glyphHeight(font) - 1, "\(name) \(points) pt: \(drawn) pt of ink for \(glyphHeight(font)) pt of glyphs, so the descenders were cut")
        XCTAssertLessThan(ink.bottom, ink.height - 1, "\(name) \(points) pt: the descenders reach the bottom of the ink box")
      }
    }
  }

  func testTheSharedFieldDrawsAWholeTitleAfterASmallerOne() {
    let field = SingleLineInk.labelField()
    field.textColor = .black
    field.stringValue = text
    field.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
    _ = inkRows(field, size: SingleLineInk.fitting(field))
    let large = NSFont.monospacedDigitSystemFont(ofSize: 17, weight: .regular)
    field.font = large
    let ink = inkRows(field, size: SingleLineInk.fitting(field))
    XCTAssertGreaterThanOrEqual(CGFloat(ink.bottom - ink.top + 1) / 2, glyphHeight(large) - 1)
  }

  func testTitlesInScriptsTheSystemFontDrawsWithAFallbackKeepTheirDescendersAtEverySidebarTextSize() {
    let field = SingleLineInk.labelField()
    field.textColor = .black
    let titles = ["Devanagari": "नमस्ते दुनिया gyp", "Thai": "สวัสดีชาวโลก gyp", "Arabic": "مرحبا بالعالم gyp", "CJK": "你好世界 日本語 gyp", "emoji": "Trip 🎉🙂🇯🇵 gyp"]
    for (script, title) in titles {
      for (name, points) in sidebarTitleSizes {
        field.font = NSFont.monospacedDigitSystemFont(ofSize: points, weight: .regular)
        field.stringValue = title
        let box = SingleLineInk.fitting(field)
        let fitted = inkRows(field, size: box)
        let roomy = inkRows(field, size: NSSize(width: box.width, height: box.height + 20))
        XCTAssertEqual(fitted.bottom, roomy.bottom, "\(script) at \(name) \(points) pt: \(roomy.bottom - fitted.bottom) pixel rows lost at the bottom")
      }
    }
  }

  func testALatinTitleSkipsTheFallbackMeasureAndKeepsItsBox() {
    let field = SingleLineInk.labelField()
    for title in ["Trip plan — Docpad", "Café • Ångström “quoted” – naïve"] {
      for (_, points) in sidebarTitleSizes {
        let font = NSFont.monospacedDigitSystemFont(ofSize: points, weight: .regular)
        field.font = font
        field.stringValue = title
        XCTAssertFalse(SingleLineInk.needsFallback(title, font: font), title)
        XCTAssertEqual(SingleLineInk.fitting(field), field.frame(forAlignmentRect: NSRect(origin: .zero, size: field.intrinsicContentSize)).size, title)
      }
    }
    XCTAssertTrue(SingleLineInk.needsFallback("नमस्ते", font: .systemFont(ofSize: 13)))
  }
}
