import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

private final class LabelInk: CALayer {
  var paint: ((CGContext) -> Void)?

  override func draw(in ctx: CGContext) {
    paint?(ctx)
  }

  override func action(forKey event: String) -> CAAction? { NSNull() }
}

final class FadeLabel: ExpoView {
  private static let weights: [String: NSFont.Weight] = [
    "ultraLight": .ultraLight, "thin": .thin, "light": .light, "regular": .regular, "medium": .medium,
    "semibold": .semibold, "bold": .bold, "heavy": .heavy, "black": .black,
  ]
  private struct FontKey: Hashable {
    let family: String
    let weight: String
    let size: Double
  }
  @MainActor private static var fonts: [FontKey: NSFont] = [:]

  static func opticalLift(_ font: NSFont, scale: CGFloat) -> CGFloat {
    guard scale > 0 else { return 0 }
    return max(0, ((font.capHeight - font.xHeight) * 0.375 * scale).rounded()) / scale
  }

  @MainActor private static func resolvedFont(family: String, weight: String, size: Double) -> NSFont {
    let key = FontKey(family: family, weight: weight, size: size)
    if let font = fonts[key] { return font }
    let fontWeight = weights[weight] ?? .regular
    if let font = familyFont(family, weight: fontWeight, size: size) {
      fonts[key] = font
      return font
    }
    let font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: fontWeight)
    if family.isEmpty { fonts[key] = font }
    return font
  }

  private static func familyFont(_ family: String, weight: NSFont.Weight, size: Double) -> NSFont? {
    guard !family.isEmpty else { return nil }
    let descriptor = NSFontDescriptor(fontAttributes: [.family: family, .traits: [NSFontDescriptor.TraitKey.weight: weight]])
    guard let font = NSFont(descriptor: descriptor, size: size), font.familyName == family else { return nil }
    return font
  }

  private static let cellInset: CGFloat = 2
  private static let inkBleed: CGFloat = 3
  private static let minimumShownWidth: CGFloat = 1

  private struct Prepared {
    let text: String
    let font: NSFont
    let color: NSColor
    let strikethrough: Bool
    let line: NSAttributedString
    let measured: NSSize

    func matches(_ text: String, _ font: NSFont, _ color: NSColor, _ strikethrough: Bool) -> Bool {
      self.text == text && self.font == font && self.color == color && self.strikethrough == strikethrough
    }
  }

  private let ink = LabelInk()
  private let fade = CAGradientLayer()
  private var font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
  private var prepared: Prepared?
  private var lift: CGFloat = 0

  var text = "" {
    didSet {
      guard text != oldValue else { return }
      update()
      NSAccessibility.post(element: self, notification: .valueChanged)
    }
  }
  var fontSize: Double = 13 { didSet { if fontSize != oldValue { update() } } }
  var weight = "regular" { didSet { if weight != oldValue { update() } } }
  var fontFamily = "" { didSet { if fontFamily != oldValue { update() } } }
  var color: NSColor = .labelColor { didSet { if color != oldValue { prepare(); ink.setNeedsDisplay() } } }
  var strikethrough = false { didSet { if strikethrough != oldValue { update() } } }
  var fadeWidth: Double = 24 { didSet { if fadeWidth != oldValue { relayout() } } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    clipsToBounds = false
    ink.paint = { [weak self] ctx in self?.paint(ctx) }
    ink.needsDisplayOnBoundsChange = true
    ink.contentsScale = backingDensity
    layer?.addSublayer(ink)
    NotificationCenter.default.addObserver(self, selector: #selector(matchScale), name: .ArdiaInterfaceScaleDidChange, object: nil)
    fade.colors = [NSColor.black.cgColor, NSColor.black.cgColor, NSColor.clear.cgColor]
    fade.startPoint = CGPoint(x: 0, y: 0.5)
    fade.endPoint = CGPoint(x: 1, y: 0.5)
    update()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func isAccessibilityElement() -> Bool { true }

  override func accessibilityRole() -> NSAccessibility.Role? { .staticText }

  override func accessibilityValue() -> Any? { text }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    relayout()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    ink.setNeedsDisplay()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    matchScale()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    matchScale()
  }

  @objc private func matchScale() {
    let scale = backingDensity
    guard scale != ink.contentsScale else { return }
    ink.contentsScale = scale
    lift = Self.opticalLift(font, scale: scale)
    ink.setNeedsDisplay()
    relayout()
  }

  private func update() {
    font = Self.resolvedFont(family: fontFamily, weight: weight, size: fontSize)
    lift = Self.opticalLift(font, scale: ink.contentsScale)
    prepare()
    ink.setNeedsDisplay()
    relayout()
  }

  private func prepare() {
    let line = Self.singleLine(text)
    if let prepared, prepared.matches(line, font, color, strikethrough) { return }
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byClipping
    var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
    if strikethrough {
      attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      attributes[.strikethroughColor] = color
    }
    let drawn = NSAttributedString(string: line, attributes: attributes)
    let measured: NSSize
    if let prepared, prepared.text == line, prepared.font == font, prepared.strikethrough == strikethrough {
      measured = prepared.measured
    } else {
      measured = drawn.boundingRect(with: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).size
    }
    prepared = Prepared(text: line, font: font, color: color, strikethrough: strikethrough, line: drawn, measured: measured)
  }

  static func singleLine(_ text: String) -> String {
    guard text.contains(where: \.isNewline) else { return text }
    return text.split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
      .joined(separator: " ")
  }

  private func relayout() {
    let fitting = fittingSize()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if ink.superlayer !== layer { layer?.addSublayer(ink) }
    let height = fitting.height + Self.inkBleed * 2
    ink.isHidden = bounds.width < Self.minimumShownWidth
    ink.frame = CGRect(x: 0, y: inkTop(fitting) - Self.inkBleed, width: max(bounds.width, fitting.width), height: height)
    if bounds.width > 0, fitting.width > bounds.width + 0.5 {
      fade.frame = CGRect(x: 0, y: 0, width: bounds.width, height: height)
      let start = max(0, 1 - fadeWidth / bounds.width)
      fade.locations = [0, NSNumber(value: start), 1]
      ink.mask = fade
    } else {
      ink.mask = nil
    }
    CATransaction.commit()
  }

  private func fittingSize() -> NSSize {
    guard let measured = prepared?.measured else { return .zero }
    let density = ink.contentsScale
    let scale = density.isFinite && density > 0 ? density : 1
    return NSSize(width: ceil(measured.width * scale) / scale + Self.cellInset * 2, height: ceil(measured.height))
  }

  private func inkTop(_ fitting: NSSize) -> CGFloat {
    let centered = (bounds.height - fitting.height) / 2
    return isFlipped ? centered - lift : centered + lift
  }

  private func paint(_ ctx: CGContext) {
    let size = ink.bounds.size
    guard size.width > 0, size.height > 0, let line = prepared?.line else { return }
    if !ink.contentsAreFlipped() {
      ctx.translateBy(x: 0, y: size.height)
      ctx.scaleBy(x: 1, y: -1)
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    effectiveAppearance.performAsCurrentDrawingAppearance {
      line.draw(with: NSRect(x: Self.cellInset, y: Self.inkBleed, width: max(0, size.width - Self.cellInset * 2), height: size.height - Self.inkBleed * 2), options: [.usesLineFragmentOrigin])
    }
    NSGraphicsContext.restoreGraphicsState()
  }
}
