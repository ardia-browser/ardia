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
  private static let field: NSTextField = {
    let field = NSTextField(labelWithString: "")
    field.lineBreakMode = .byClipping
    field.maximumNumberOfLines = 1
    field.cell?.truncatesLastVisibleLine = false
    field.isSelectable = false
    return field
  }()
  private static let weights: [String: NSFont.Weight] = [
    "ultraLight": .ultraLight, "thin": .thin, "light": .light, "regular": .regular, "medium": .medium,
    "semibold": .semibold, "bold": .bold, "heavy": .heavy, "black": .black,
  ]

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
    let fontWeight = Self.weights[weight] ?? .regular
    font = familyFont(weight: fontWeight) ?? .monospacedDigitSystemFont(ofSize: fontSize, weight: fontWeight)
    let field = Self.field
    load(field)
    fitting = field.frame(forAlignmentRect: NSRect(origin: .zero, size: field.intrinsicContentSize)).size
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

  private func familyFont(weight: NSFont.Weight) -> NSFont? {
    guard !fontFamily.isEmpty else { return nil }
    let descriptor = NSFontDescriptor(fontAttributes: [.family: fontFamily, .traits: [NSFontDescriptor.TraitKey.weight: weight]])
    guard let font = NSFont(descriptor: descriptor, size: fontSize), font.familyName == fontFamily else { return nil }
    return font
  }

  private func relayout() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if ink.superlayer !== layer { layer?.addSublayer(ink) }
    let placed = CGRect(x: 0, y: (bounds.height - fitting.height) / 2, width: fitting.width, height: fitting.height)
    if ink.frame != placed { ink.frame = placed }
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
      field.cell?.draw(withFrame: NSRect(origin: .zero, size: size), in: field)
    }
    NSGraphicsContext.restoreGraphicsState()
  }
}
