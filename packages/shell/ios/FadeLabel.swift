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
  private static let field = SingleLineInk.labelField()
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

  private let ink = LabelInk()
  private let fade = CAGradientLayer()
  private var font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
  private var fitting = NSSize.zero

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
  var color: NSColor = .labelColor { didSet { if color != oldValue { ink.setNeedsDisplay() } } }
  var strikethrough = false { didSet { if strikethrough != oldValue { update() } } }
  var fadeWidth: Double = 24 { didSet { if fadeWidth != oldValue { relayout() } } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    wantsLayer = true
    clipsToBounds = true
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
    ink.setNeedsDisplay()
  }

  private func load(_ field: NSTextField) {
    field.font = font
    field.textColor = color
    let line = Self.singleLine(text)
    if strikethrough {
      field.attributedStringValue = NSAttributedString(string: line, attributes: [
        .font: font, .foregroundColor: color,
        .strikethroughStyle: NSUnderlineStyle.single.rawValue, .strikethroughColor: color,
      ])
    } else {
      field.stringValue = line
    }
  }

  private func update() {
    font = Self.resolvedFont(family: fontFamily, weight: weight, size: fontSize)
    let field = Self.field
    load(field)
    fitting = SingleLineInk.fitting(field)
    ink.setNeedsDisplay()
    relayout()
  }

  static func singleLine(_ text: String) -> String {
    guard text.contains(where: \.isNewline) else { return text }
    return text.split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
      .joined(separator: " ")
  }

  private func relayout() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if ink.superlayer !== layer { layer?.addSublayer(ink) }
    ink.frame = CGRect(x: 0, y: (bounds.height - fitting.height) / 2, width: max(bounds.width, fitting.width), height: fitting.height)
    if bounds.width > 0, fitting.width > bounds.width + 0.5 {
      fade.frame = CGRect(x: 0, y: 0, width: bounds.width, height: fitting.height)
      let start = max(0, 1 - fadeWidth / bounds.width)
      fade.locations = [0, NSNumber(value: start), 1]
      ink.mask = fade
    } else {
      ink.mask = nil
    }
    CATransaction.commit()
  }

  private func paint(_ ctx: CGContext) {
    let size = ink.bounds.size
    guard size.width > 0, size.height > 0 else { return }
    let field = Self.field
    load(field)
    if !ink.contentsAreFlipped() {
      ctx.translateBy(x: 0, y: size.height)
      ctx.scaleBy(x: 1, y: -1)
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    effectiveAppearance.performAsCurrentDrawingAppearance {
      SingleLineInk.draw(field, size: size)
    }
    NSGraphicsContext.restoreGraphicsState()
  }
}
