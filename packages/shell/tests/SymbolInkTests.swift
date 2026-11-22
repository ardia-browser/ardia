import AppKit
import XCTest
@testable import ArdiaUpdaterCore

final class SymbolInkTests: XCTestCase {
  private let engineSymbols = ["safari", "globe"]
  private let engineMarkPointSizes: [CGFloat] = [7, 8, 9]
  private let densities: [CGFloat] = [1, 2, 3]

  private func symbol(_ name: String, points: CGFloat) -> NSImage {
    let config = NSImage.SymbolConfiguration(pointSize: points, weight: .semibold)
    return NSImage(systemSymbolName: name, accessibilityDescription: nil)!.withSymbolConfiguration(config)!
  }

  private func placed(_ image: NSImage, box: CGFloat, density: CGFloat, centresInk: Bool) -> NSRect {
    let offset = centresInk ? SymbolInk.offset(of: image, density: density) : .zero
    let rect = SymbolInk.centredRect(image.size, in: NSRect(x: 0, y: 0, width: box, height: box), offset: offset, flipped: false)!
    return NSRect(
      x: (rect.minX * density).rounded() / density, y: (rect.minY * density).rounded() / density, width: rect.width,
      height: rect.height)
  }

  private func inkCentreOffset(_ image: NSImage, at rect: NSRect, box: CGFloat, density: CGFloat) -> (x: CGFloat, y: CGFloat) {
    let side = Int((box * density).rounded())
    let context = CGContext(
      data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: density, y: density)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
    func alpha(_ x: Int, _ y: Int) -> CGFloat { CGFloat(pixels[y * side * 4 + x * 4 + 3]) / 255 }
    let columns = (0..<side).map { x in (0..<side).map { alpha(x, $0) }.max()! }
    let rows = (0..<side).map { y in (0..<side).map { alpha($0, y) }.max()! }
    let left = columns.firstIndex { $0 > 0 }!, right = columns.lastIndex { $0 > 0 }!
    let top = rows.firstIndex { $0 > 0 }!, bottom = rows.lastIndex { $0 > 0 }!
    let inkLeft = CGFloat(left) + 1 - columns[left], inkRight = CGFloat(right) + columns[right]
    let inkTop = CGFloat(top) + 1 - rows[top], inkBottom = CGFloat(bottom) + rows[bottom]
    let centre = CGFloat(side) / 2
    return ((inkLeft + inkRight) / 2 - centre, (inkTop + inkBottom) / 2 - centre)
  }

  func testTheEngineMarkGlyphsSitInTheMiddleOfTheirPlateAtEverySizeAndScale() {
    for name in engineSymbols {
      for points in engineMarkPointSizes {
        let image = symbol(name, points: points)
        let box = points + 3
        for density in densities {
          let rect = placed(image, box: box, density: density, centresInk: true)
          let off = inkCentreOffset(image, at: rect, box: box, density: density)
          let label = "\(name) \(points) pt in a \(box) pt plate at \(density)x"
          XCTAssertLessThanOrEqual(abs(off.x), 0.55, "\(label): ink is \(off.x) px off horizontally")
          XCTAssertLessThanOrEqual(abs(off.y), 0.55, "\(label): ink is \(off.y) px off vertically")
        }
      }
    }
  }

  func testCentringTheInkIsNeverWorseThanCentringTheImageBox() {
    for name in engineSymbols {
      for points in engineMarkPointSizes {
        let image = symbol(name, points: points)
        let box = points + 3
        for density in densities {
          let ink = inkCentreOffset(image, at: placed(image, box: box, density: density, centresInk: true), box: box, density: density)
          let plain = inkCentreOffset(image, at: placed(image, box: box, density: density, centresInk: false), box: box, density: density)
          let label = "\(name) \(points) pt at \(density)x"
          XCTAssertLessThanOrEqual(abs(ink.x), abs(plain.x) + 0.05, label)
          XCTAssertLessThanOrEqual(abs(ink.y), abs(plain.y) + 0.05, label)
        }
      }
    }
  }

  func testWithoutCentresInkTheImageBoxIsCentredAsBefore() {
    let image = symbol("safari", points: 7)
    let rect = SymbolInk.centredRect(image.size, in: NSRect(x: 0, y: 0, width: 10, height: 10), offset: .zero, flipped: true)!
    XCTAssertEqual(rect.midX, 5, accuracy: 0.001)
    XCTAssertEqual(rect.midY, 5, accuracy: 0.001)
    XCTAssertEqual(rect.size, image.size)
  }

  func testAFlippedViewMovesTheImageTheOtherWayVertically() {
    let bounds = NSRect(x: 0, y: 0, width: 10, height: 10)
    let size = NSSize(width: 9, height: 9)
    let offset = CGVector(dx: 0.4, dy: 0.3)
    let up = SymbolInk.centredRect(size, in: bounds, offset: offset, flipped: false)!
    let down = SymbolInk.centredRect(size, in: bounds, offset: offset, flipped: true)!
    XCTAssertEqual(up.minX, down.minX, accuracy: 0.001)
    XCTAssertEqual(up.minY, 0.8, accuracy: 0.001)
    XCTAssertEqual(down.minY, 0.2, accuracy: 0.001)
  }

  func testAnImageLargerThanItsBoxShrinksWithItsOffset() {
    let rect = SymbolInk.centredRect(
      NSSize(width: 20, height: 20), in: NSRect(x: 0, y: 0, width: 10, height: 10), offset: CGVector(dx: 2, dy: 0), flipped: false)!
    XCTAssertEqual(rect.size, NSSize(width: 10, height: 10))
    XCTAssertEqual(rect.minX, 1, accuracy: 0.001)
  }

  func testInkEdgesReadPartialCoverage() {
    let wide = 10, high = 6
    var pixels = [UInt8](repeating: 0, count: wide * high * 4)
    for y in 1...3 {
      for x in 2...6 { pixels[(y * wide + x) * 4 + 3] = 255 }
      pixels[(y * wide + 7) * 4 + 3] = 128
    }
    for x in 2...6 { pixels[(4 * wide + x) * 4 + 3] = 64 }
    let edges = pixels.withUnsafeBufferPointer { SymbolInk.inkEdges($0.baseAddress!, wide: wide, high: high, bytesPerRow: wide * 4) }!
    XCTAssertEqual(edges.left, 2, accuracy: 0.01)
    XCTAssertEqual(edges.right, 10 - 7 - 128.0 / 255, accuracy: 0.01)
    XCTAssertEqual(edges.top, 1, accuracy: 0.01)
    XCTAssertEqual(edges.bottom, 6 - 4 - 64.0 / 255, accuracy: 0.01)
  }

  func testAnEmptyImageHasNoOffset() {
    XCTAssertEqual(SymbolInk.offset(of: NSImage(size: NSSize(width: 8, height: 8)), density: 2), .zero)
  }
}
