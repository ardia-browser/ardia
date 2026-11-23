import AppKit
import ArdiaCore
import CoreGraphics

enum SvgArt {
  enum Paint {
    case none
    case currentColor
    case fixed(NSColor)
  }

  struct Style {
    var fill: Paint = .fixed(.black)
    var stroke: Paint = .none
    var strokeWidth: CGFloat = 1
    var lineCap: CGLineCap = .butt
    var lineJoin: CGLineJoin = .miter
    var evenOdd = false
    var opacity: CGFloat = 1
    var fillOpacity: CGFloat = 1
    var strokeOpacity: CGFloat = 1
  }

  struct Shape {
    let path: CGPath
    let style: Style
  }

  final class Document: NSObject {
    let viewBox: CGRect
    let shapes: [Shape]

    init(viewBox: CGRect, shapes: [Shape]) {
      self.viewBox = viewBox
      self.shapes = shapes
    }
  }

  private static let cache = NSCache<NSString, Document>()

  static func document(for svg: String) -> Document? {
    if let cached = cache.object(forKey: svg as NSString) { return cached }
    guard let data = svg.data(using: .utf8) else { return nil }
    let reader = DocumentReader()
    let parser = XMLParser(data: data)
    parser.delegate = reader
    guard parser.parse(), !reader.shapes.isEmpty else { return nil }
    let doc = Document(viewBox: reader.viewBox, shapes: reader.shapes)
    cache.setObject(doc, forKey: svg as NSString)
    return doc
  }

  static func image(svg: String, size: CGSize, scale: CGFloat, tint: NSColor) -> CGImage? {
    guard size.width > 0, size.height > 0, scale > 0,
      let doc = document(for: svg),
      doc.viewBox.width > 0, doc.viewBox.height > 0,
      let space = CGColorSpace(name: CGColorSpace.sRGB),
      let ctx = CGContext(
        data: nil,
        width: max(1, Int((size.width * scale).rounded(.up))),
        height: max(1, Int((size.height * scale).rounded(.up))),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    let width = CGFloat(ctx.width) / scale
    let height = CGFloat(ctx.height) / scale
    ctx.setShouldAntialias(true)
    ctx.setAllowsAntialiasing(true)
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: 0, y: height)
    ctx.scaleBy(x: 1, y: -1)
    let fit = min(width / doc.viewBox.width, height / doc.viewBox.height)
    let offsetX = (width - doc.viewBox.width * fit) / 2
    let offsetY = (height - doc.viewBox.height * fit) / 2
    ctx.translateBy(x: offsetX, y: offsetY)
    ctx.scaleBy(x: fit, y: fit)
    ctx.translateBy(x: -doc.viewBox.minX, y: -doc.viewBox.minY)
    let resolvedTint = tint.usingColorSpace(.sRGB) ?? tint
    for shape in doc.shapes {
      let s = shape.style
      if let fillColor = resolve(s.fill, tint: resolvedTint, alpha: s.opacity * s.fillOpacity) {
        ctx.saveGState()
        ctx.addPath(shape.path)
        ctx.setFillColor(fillColor.cgColor)
        ctx.fillPath(using: s.evenOdd ? .evenOdd : .winding)
        ctx.restoreGState()
      }
      if s.strokeWidth > 0, let strokeColor = resolve(s.stroke, tint: resolvedTint, alpha: s.opacity * s.strokeOpacity) {
        ctx.saveGState()
        ctx.addPath(shape.path)
        ctx.setStrokeColor(strokeColor.cgColor)
        ctx.setLineWidth(s.strokeWidth)
        ctx.setLineCap(s.lineCap)
        ctx.setLineJoin(s.lineJoin)
        ctx.strokePath()
        ctx.restoreGState()
      }
    }
    return ctx.makeImage()
  }

  private static func resolve(_ paint: Paint, tint: NSColor, alpha: CGFloat) -> NSColor? {
    let clamped = max(0, min(1, alpha))
    guard clamped > 0 else { return nil }
    switch paint {
    case .none:
      return nil
    case .currentColor:
      return tint.withAlphaComponent(tint.alphaComponent * clamped)
    case .fixed(let color):
      let srgb = color.usingColorSpace(.sRGB) ?? color
      return srgb.withAlphaComponent(srgb.alphaComponent * clamped)
    }
  }
}

private final class DocumentReader: NSObject, XMLParserDelegate {
  var viewBox = CGRect(x: 0, y: 0, width: 16, height: 16)
  var shapes: [SvgArt.Shape] = []
  private var stack: [SvgArt.Style] = [SvgArt.Style()]

  func parser(
    _ parser: XMLParser,
    didStartElement elementName: String,
    namespaceURI: String?,
    qualifiedName qName: String?,
    attributes: [String: String]
  ) {
    let tag = elementName.lowercased()
    var style = stack.last ?? SvgArt.Style()
    applyStyle(attributes, to: &style)
    stack.append(style)

    if tag == "svg" {
      if let vb = attributes["viewBox"] {
        let nums = parseNumbers(vb)
        if nums.count == 4, nums[2] > 0, nums[3] > 0 {
          viewBox = CGRect(x: nums[0], y: nums[1], width: nums[2], height: nums[3])
        }
      } else if let w = parseNumber(attributes["width"]), let h = parseNumber(attributes["height"]), w > 0, h > 0 {
        viewBox = CGRect(x: 0, y: 0, width: w, height: h)
      }
      return
    }

    if let path = makePath(tag: tag, attributes: attributes) {
      shapes.append(SvgArt.Shape(path: path, style: style))
    }
  }

  func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
    if stack.count > 1 { stack.removeLast() }
  }

  private func applyStyle(_ attrs: [String: String], to style: inout SvgArt.Style) {
    if let v = attrs["fill"] { style.fill = parsePaint(v) }
    if let v = attrs["stroke"] { style.stroke = parsePaint(v) }
    if let v = parseNumber(attrs["stroke-width"]) { style.strokeWidth = v }
    if let v = attrs["stroke-linecap"]?.lowercased() {
      switch v {
      case "round": style.lineCap = .round
      case "square": style.lineCap = .square
      default: style.lineCap = .butt
      }
    }
    if let v = attrs["stroke-linejoin"]?.lowercased() {
      switch v {
      case "round": style.lineJoin = .round
      case "bevel": style.lineJoin = .bevel
      default: style.lineJoin = .miter
      }
    }
    if let v = attrs["fill-rule"]?.lowercased() { style.evenOdd = v == "evenodd" }
    if let v = parseNumber(attrs["opacity"]) { style.opacity *= v }
    if let v = parseNumber(attrs["fill-opacity"]) { style.fillOpacity = v }
    if let v = parseNumber(attrs["stroke-opacity"]) { style.strokeOpacity = v }
  }

  private func parsePaint(_ raw: String) -> SvgArt.Paint {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = value.lowercased()
    if lower == "none" || lower == "transparent" { return .none }
    if lower == "currentcolor" { return .currentColor }
    if lower == "white" { return .fixed(.white) }
    if lower == "black" { return .fixed(.black) }
    if value.hasPrefix("#"), let parsed = RGBA(hex: value)?.srgb { return .fixed(parsed) }
    return .currentColor
  }

  private func makePath(tag: String, attributes: [String: String]) -> CGPath? {
    switch tag {
    case "path":
      guard let d = attributes["d"] else { return nil }
      return SvgPathParser.parse(d)
    case "line":
      let x1 = parseNumber(attributes["x1"]) ?? 0
      let y1 = parseNumber(attributes["y1"]) ?? 0
      let x2 = parseNumber(attributes["x2"]) ?? 0
      let y2 = parseNumber(attributes["y2"]) ?? 0
      let path = CGMutablePath()
      path.move(to: CGPoint(x: x1, y: y1))
      path.addLine(to: CGPoint(x: x2, y: y2))
      return path
    case "rect":
      let x = parseNumber(attributes["x"]) ?? 0
      let y = parseNumber(attributes["y"]) ?? 0
      guard let w = parseNumber(attributes["width"]), let h = parseNumber(attributes["height"]), w > 0, h > 0 else { return nil }
      let rxRaw = parseNumber(attributes["rx"])
      let ryRaw = parseNumber(attributes["ry"])
      let rx = min(max(0, rxRaw ?? ryRaw ?? 0), w / 2)
      let ry = min(max(0, ryRaw ?? rxRaw ?? 0), h / 2)
      let rect = CGRect(x: x, y: y, width: w, height: h)
      return rx > 0 && ry > 0 ? CGPath(roundedRect: rect, cornerWidth: rx, cornerHeight: ry, transform: nil) : CGPath(rect: rect, transform: nil)
    case "circle":
      let cx = parseNumber(attributes["cx"]) ?? 0
      let cy = parseNumber(attributes["cy"]) ?? 0
      guard let r = parseNumber(attributes["r"]), r > 0 else { return nil }
      return CGPath(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2), transform: nil)
    case "ellipse":
      let cx = parseNumber(attributes["cx"]) ?? 0
      let cy = parseNumber(attributes["cy"]) ?? 0
      guard let rx = parseNumber(attributes["rx"]), let ry = parseNumber(attributes["ry"]), rx > 0, ry > 0 else { return nil }
      return CGPath(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2), transform: nil)
    case "polyline", "polygon":
      guard let pts = attributes["points"] else { return nil }
      let nums = parseNumbers(pts)
      guard nums.count >= 4 else { return nil }
      let path = CGMutablePath()
      path.move(to: CGPoint(x: nums[0], y: nums[1]))
      var i = 2
      while i + 1 < nums.count {
        path.addLine(to: CGPoint(x: nums[i], y: nums[i + 1]))
        i += 2
      }
      if tag == "polygon" { path.closeSubpath() }
      return path
    default:
      return nil
    }
  }

  private func parseNumber(_ text: String?) -> CGFloat? {
    guard let text else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let stripped = trimmed.hasSuffix("px") ? String(trimmed.dropLast(2)) : trimmed
    guard let value = Double(stripped), value.isFinite else { return nil }
    return CGFloat(value)
  }

  private func parseNumbers(_ text: String) -> [CGFloat] {
    text
      .split { $0.isWhitespace || $0 == "," }
      .compactMap { Double($0).flatMap { $0.isFinite ? CGFloat($0) : nil } }
  }
}

private enum SvgPathParser {
  static func parse(_ d: String) -> CGPath {
    let bytes = Array(d.utf8)
    let path = CGMutablePath()
    var i = 0
    var cmd: UInt8 = 0
    var current = CGPoint.zero
    var start = CGPoint.zero
    var lastControl: CGPoint?
    var lastQuad: CGPoint?

    func skipSeparators() {
      while i < bytes.count {
        let b = bytes[i]
        if b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D || b == 0x2C {
          i += 1
        } else {
          break
        }
      }
    }

    func isCommand(_ b: UInt8) -> Bool {
      (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
    }

    func readNumber() -> CGFloat? {
      skipSeparators()
      guard i < bytes.count else { return nil }
      let begin = i
      if bytes[i] == 0x2B || bytes[i] == 0x2D { i += 1 }
      var hasDigits = false
      while i < bytes.count, bytes[i] >= 0x30 && bytes[i] <= 0x39 {
        hasDigits = true
        i += 1
      }
      if i < bytes.count, bytes[i] == 0x2E {
        i += 1
        while i < bytes.count, bytes[i] >= 0x30 && bytes[i] <= 0x39 {
          hasDigits = true
          i += 1
        }
      }
      guard hasDigits else {
        i = begin
        return nil
      }
      if i < bytes.count, bytes[i] == 0x65 || bytes[i] == 0x45 {
        let expStart = i
        i += 1
        if i < bytes.count, bytes[i] == 0x2B || bytes[i] == 0x2D { i += 1 }
        var expDigits = false
        while i < bytes.count, bytes[i] >= 0x30 && bytes[i] <= 0x39 {
          expDigits = true
          i += 1
        }
        if !expDigits { i = expStart }
      }
      guard let str = String(bytes: bytes[begin..<i], encoding: .utf8), let value = Double(str), value.isFinite else { return nil }
      return CGFloat(value)
    }

    func readFlag() -> Bool? {
      skipSeparators()
      guard i < bytes.count else { return nil }
      if bytes[i] == 0x30 {
        i += 1
        return false
      }
      if bytes[i] == 0x31 {
        i += 1
        return true
      }
      return nil
    }

    while i < bytes.count {
      skipSeparators()
      guard i < bytes.count else { break }
      if isCommand(bytes[i]) {
        cmd = bytes[i]
        i += 1
      } else if cmd == 0 {
        break
      }
      let relative = cmd >= 0x61
      let upper = relative ? cmd - 0x20 : cmd
      switch upper {
      case 0x4D:
        guard let x = readNumber(), let y = readNumber() else { return path }
        let pt = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        path.move(to: pt)
        current = pt
        start = pt
        lastControl = nil
        lastQuad = nil
        cmd = relative ? 0x6C : 0x4C
      case 0x4C:
        guard let x = readNumber(), let y = readNumber() else { return path }
        let pt = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        path.addLine(to: pt)
        current = pt
        lastControl = nil
        lastQuad = nil
      case 0x48:
        guard let x = readNumber() else { return path }
        let pt = CGPoint(x: relative ? current.x + x : x, y: current.y)
        path.addLine(to: pt)
        current = pt
        lastControl = nil
        lastQuad = nil
      case 0x56:
        guard let y = readNumber() else { return path }
        let pt = CGPoint(x: current.x, y: relative ? current.y + y : y)
        path.addLine(to: pt)
        current = pt
        lastControl = nil
        lastQuad = nil
      case 0x43:
        guard let x1 = readNumber(), let y1 = readNumber(), let x2 = readNumber(), let y2 = readNumber(), let x = readNumber(), let y = readNumber() else { return path }
        let c1 = relative ? CGPoint(x: current.x + x1, y: current.y + y1) : CGPoint(x: x1, y: y1)
        let c2 = relative ? CGPoint(x: current.x + x2, y: current.y + y2) : CGPoint(x: x2, y: y2)
        let pt = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        path.addCurve(to: pt, control1: c1, control2: c2)
        current = pt
        lastControl = c2
        lastQuad = nil
      case 0x53:
        guard let x2 = readNumber(), let y2 = readNumber(), let x = readNumber(), let y = readNumber() else { return path }
        let c1 = lastControl.map { CGPoint(x: current.x * 2 - $0.x, y: current.y * 2 - $0.y) } ?? current
        let c2 = relative ? CGPoint(x: current.x + x2, y: current.y + y2) : CGPoint(x: x2, y: y2)
        let pt = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        path.addCurve(to: pt, control1: c1, control2: c2)
        current = pt
        lastControl = c2
        lastQuad = nil
      case 0x51:
        guard let x1 = readNumber(), let y1 = readNumber(), let x = readNumber(), let y = readNumber() else { return path }
        let c1 = relative ? CGPoint(x: current.x + x1, y: current.y + y1) : CGPoint(x: x1, y: y1)
        let pt = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        path.addQuadCurve(to: pt, control: c1)
        current = pt
        lastQuad = c1
        lastControl = nil
      case 0x54:
        guard let x = readNumber(), let y = readNumber() else { return path }
        let c1 = lastQuad.map { CGPoint(x: current.x * 2 - $0.x, y: current.y * 2 - $0.y) } ?? current
        let pt = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        path.addQuadCurve(to: pt, control: c1)
        current = pt
        lastQuad = c1
        lastControl = nil
      case 0x41:
        guard let rx = readNumber(), let ry = readNumber(), let rot = readNumber(), let large = readFlag(), let sweep = readFlag(), let x = readNumber(), let y = readNumber() else { return path }
        let pt = relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        addArc(to: path, from: current, to: pt, rx: rx, ry: ry, xAxisRotation: rot, largeArc: large, sweep: sweep)
        current = pt
        lastControl = nil
        lastQuad = nil
      case 0x5A:
        path.closeSubpath()
        current = start
        lastControl = nil
        lastQuad = nil
      default:
        return path
      }
    }
    return path
  }

  private static func addArc(
    to path: CGMutablePath,
    from p1: CGPoint,
    to p2: CGPoint,
    rx rawRx: CGFloat,
    ry rawRy: CGFloat,
    xAxisRotation: CGFloat,
    largeArc: Bool,
    sweep: Bool
  ) {
    if p1 == p2 { return }
    var rx = abs(rawRx)
    var ry = abs(rawRy)
    if rx == 0 || ry == 0 {
      path.addLine(to: p2)
      return
    }
    let phi = xAxisRotation * .pi / 180
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)
    let dx = (p1.x - p2.x) / 2
    let dy = (p1.y - p2.y) / 2
    let x1p = cosPhi * dx + sinPhi * dy
    let y1p = -sinPhi * dx + cosPhi * dy
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
      let scale = sqrt(lambda)
      rx *= scale
      ry *= scale
    }
    let rx2 = rx * rx
    let ry2 = ry * ry
    let x1p2 = x1p * x1p
    let y1p2 = y1p * y1p
    let num = max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
    let den = rx2 * y1p2 + ry2 * x1p2
    let factor = den > 0 ? sqrt(num / den) * (largeArc == sweep ? -1 : 1) : 0
    let cxp = factor * (rx * y1p / ry)
    let cyp = factor * (-ry * x1p / rx)
    let cx = cosPhi * cxp - sinPhi * cyp + (p1.x + p2.x) / 2
    let cy = sinPhi * cxp + cosPhi * cyp + (p1.y + p2.y) / 2

    func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
      let dot = ux * vx + uy * vy
      let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
      let clamped = max(-1, min(1, len > 0 ? dot / len : 1))
      let sign: CGFloat = (ux * vy - uy * vx) < 0 ? -1 : 1
      return sign * acos(clamped)
    }

    let vx1 = (x1p - cxp) / rx
    let vy1 = (y1p - cyp) / ry
    let vx2 = (-x1p - cxp) / rx
    let vy2 = (-y1p - cyp) / ry
    let theta1 = angle(1, 0, vx1, vy1)
    var dTheta = angle(vx1, vy1, vx2, vy2)
    if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
    if sweep && dTheta < 0 { dTheta += 2 * .pi }

    let segments = max(1, Int(ceil(abs(dTheta) / (.pi / 2))))
    let delta = dTheta / CGFloat(segments)
    let t = (4.0 / 3.0) * tan(delta / 4.0)

    for s in 0..<segments {
      let a1 = theta1 + CGFloat(s) * delta
      let a2 = a1 + delta
      let cos1 = cos(a1), sin1 = sin(a1)
      let cos2 = cos(a2), sin2 = sin(a2)
      let e1x = cos1 - t * sin1
      let e1y = sin1 + t * cos1
      let e2x = cos2 + t * sin2
      let e2y = sin2 - t * cos2
      let map = { (ux: CGFloat, uy: CGFloat) -> CGPoint in
        let x = rx * ux
        let y = ry * uy
        return CGPoint(x: cosPhi * x - sinPhi * y + cx, y: sinPhi * x + cosPhi * y + cy)
      }
      path.addCurve(to: map(cos2, sin2), control1: map(e1x, e1y), control2: map(e2x, e2y))
    }
  }
}
