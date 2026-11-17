import ArdiaDesign
import ExpoModulesCore
import SwiftUI
import UIKit

public final class LookModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneLook")

    Function("hasGlass") { () -> Bool in true }

    Function("setPageFrost") { (mode: String) throws -> String in
      guard PhoneTestBuild.isOn else { throw LookLabOnly() }
      let solid = mode == "solid"
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          LookHost.pageFrostSolid = solid
          LookHost.refreshFrosts()
        }
      }
      return solid ? "solid" : "live"
    }

    Function("probeFrosts") { () throws in
      guard PhoneTestBuild.isOn else { throw LookLabOnly() }
      DispatchQueue.main.async { MainActor.assumeIsolated { LookHost.probe() } }
    }

    View(DeckBackdropView.self) {
      ViewName("DeckBackdrop")
      Prop("color") { (view: DeckBackdropView, value: String?) in view.colors.color = value }
      Prop("themeColors") { (view: DeckBackdropView, value: [String]?) in view.colors.themeColors = value }
      Prop("darkThemeColors") { (view: DeckBackdropView, value: [String]?) in view.colors.darkThemeColors = value }
      Prop("dark") { (view: DeckBackdropView, value: Bool?) in view.dark = value }
      Prop("reduceMotion") { (view: DeckBackdropView, value: Bool?) in view.reduceMotion = value }
      Prop("reduceTransparency") { (view: DeckBackdropView, value: Bool?) in view.reduceTransparency = value }
      OnViewDidUpdateProps { (view: DeckBackdropView) in view.render() }
    }

    View(ProfileBackdropView.self) {
      ViewName("ProfileBackdrop")
      Prop("color") { (view: ProfileBackdropView, value: String?) in view.colors.color = value }
      Prop("themeColors") { (view: ProfileBackdropView, value: [String]?) in view.colors.themeColors = value }
      Prop("darkThemeColors") { (view: ProfileBackdropView, value: [String]?) in view.colors.darkThemeColors = value }
      Prop("dark") { (view: ProfileBackdropView, value: Bool?) in view.dark = value }
      Prop("themed") { (view: ProfileBackdropView, value: Bool?) in view.themed = value == true }
      Prop("softened") { (view: ProfileBackdropView, value: Bool?) in view.softened = value == true }
      Prop("fadesOut") { (view: ProfileBackdropView, value: Bool?) in view.fadesOut = value == true }
      OnViewDidUpdateProps { (view: ProfileBackdropView) in view.render() }
    }

    View(FilmGrainView.self) {
      ViewName("FilmGrain")
      Prop("opacity") { (view: FilmGrainView, value: Double?) in view.grain = value ?? 0.06 }
      OnViewDidUpdateProps { (view: FilmGrainView) in view.render() }
    }

    View(FrostSourceView.self) {
      ViewName("FrostSource")
      Prop("name") { (_: FrostSourceView, _: String?) in }
    }

    View(GlassView.self) {
      ViewName("Glass")
      Prop("shape") { (view: GlassView, value: String?) in view.shape = GlassView.Shape(rawValue: value ?? "") ?? .capsule }
      Prop("cornerRadius") { (view: GlassView, value: Double?) in view.cornerRadius = CGFloat(value ?? 0) }
      Prop("tint") { (view: GlassView, value: UIColor?) in view.tint = value }
      Prop("interactive") { (view: GlassView, value: Bool?) in view.interactive = value ?? true }
      Prop("dark") { (view: GlassView, value: Bool?) in view.dark = value }
      Prop("reduceTransparency") { (view: GlassView, value: Bool?) in view.reduceTransparency = value == true }
      Prop("surface") { (view: GlassView, value: String?) in view.surface = GlassView.Surface(rawValue: value ?? "") ?? .glass }
      Prop("tinted") { (view: GlassView, value: Bool?) in view.tinted = value == true }
      Prop("barShadow") { (view: GlassView, value: Bool?) in view.barShadow = value == true }
      Prop("shown") { (view: GlassView, value: Bool?) in view.shown = value ?? true }
      Prop("shownMs") { (view: GlassView, value: Double?) in view.shownDuration = max(0, value ?? 200) / 1000 }
      Prop("color") { (view: GlassView, value: String?) in view.colors.color = value }
      Prop("themeColors") { (view: GlassView, value: [String]?) in view.colors.themeColors = value }
      Prop("darkThemeColors") { (view: GlassView, value: [String]?) in view.colors.darkThemeColors = value }
      OnViewDidUpdateProps { (view: GlassView) in view.render() }
    }

    View(FrostView.self) {
      ViewName("Frost")
      Prop("source") { (_: FrostView, _: String?) in }
      Prop("variant") { (view: FrostView, value: String?) in view.variant = value.flatMap(LookFrost.Variant.init(rawValue:)) ?? .bar }
      Prop("cornerRadius") { (view: FrostView, value: Double?) in view.cornerRadius = value ?? 0 }
      Prop("color") { (view: FrostView, value: String?) in view.colors.color = value }
      Prop("themeColors") { (view: FrostView, value: [String]?) in view.colors.themeColors = value }
      Prop("darkThemeColors") { (view: FrostView, value: [String]?) in view.colors.darkThemeColors = value }
      Prop("dark") { (view: FrostView, value: Bool?) in view.dark = value }
      Prop("reduceTransparency") { (view: FrostView, value: Bool?) in view.reduceTransparency = value }
      OnViewDidUpdateProps { (view: FrostView) in view.render() }
    }
  }
}

struct LookLabOnly: Error, CustomStringConvertible {
  var description: String { "the look lab switches exist only in test builds" }
}

@MainActor
enum LookHost {
  static var pageFrostSolid = false
  private static let frosts = NSHashTable<FrostView>.weakObjects()

  static func register(_ frost: FrostView) {
    frosts.add(frost)
  }

  static func refreshFrosts() {
    for frost in frosts.allObjects { frost.render() }
  }

  static func probe() {
    for frost in frosts.allObjects {
      NSLog("ARDIA_LOOK frost variant=%@ solid=%d window=%d size=%@", frost.variant.rawValue, frost.isSolid ? 1 : 0, frost.window == nil ? 0 : 1, NSCoder.string(for: frost.bounds.size))
    }
  }
}

class LookHostView: ExpoView {
  private let host = UIHostingController(rootView: AnyView(EmptyView()))

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    host.view.backgroundColor = .clear
    host.view.isUserInteractionEnabled = false
    host.view.isAccessibilityElement = false
    host.sizingOptions = []
    host.safeAreaRegions = []
    super.insertSubview(host.view, at: 0)
  }

  override func insertSubview(_ view: UIView, at index: Int) {
    if view === host.view || host.view.superview !== self {
      super.insertSubview(view, at: index)
    } else {
      super.insertSubview(view, at: index + 1)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
    sendSubviewToBack(host.view)
  }

  func blendsAsOverlay() {
    host.view.layer.compositingFilter = "overlayBlendMode"
  }

  func show<Content: View>(_ content: Content, dark: Bool?) {
    if let dark {
      host.rootView = AnyView(content.environment(\.colorScheme, dark ? .dark : .light))
      host.overrideUserInterfaceStyle = dark ? .dark : .light
    } else {
      host.rootView = AnyView(content)
      host.overrideUserInterfaceStyle = .unspecified
    }
  }
}

final class DeckBackdropView: LookHostView {
  var colors = LookColors()
  var dark: Bool?
  var reduceMotion: Bool?
  var reduceTransparency: Bool?

  func render() {
    let look = colors.color == nil && (colors.themeColors ?? []).isEmpty ? ProfileLook.plum : colors.look
    show(TabsBackdrop(look: look, reduceMotion: reduceMotion, reduceTransparency: reduceTransparency), dark: colors.isIncognito ? true : dark)
  }
}

final class ProfileBackdropView: LookHostView {
  var colors = LookColors()
  var dark: Bool?
  var themed = false
  var softened = false
  var fadesOut = false

  func render() {
    if themed { LaunchLook.remember(colors) }
    show(ProfileBackdrop(look: colors.look, themed: themed, softened: softened, fadesOut: fadesOut), dark: colors.isIncognito ? true : dark)
  }
}

final class FilmGrainView: LookHostView {
  var grain = 0.06

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    blendsAsOverlay()
  }

  func render() {
    show(FilmGrain(opacity: grain), dark: nil)
  }
}

final class FrostSourceView: ExpoView {}

final class GlassView: ExpoView {
  enum Shape: String {
    case capsule
    case circle
    case rounded
  }

  enum Surface: String {
    case glass
    case classic
  }

  static let classicEdge = UIColor.label.withAlphaComponent(0.12)
  static let classicEdgeWidth: CGFloat = 0.5
  static let classicShadowRadius: CGFloat = 10
  static let classicShadowOffset = CGSize(width: 0, height: 2)

  var shape: Shape = .capsule
  var cornerRadius: CGFloat = 0
  var tint: UIColor?
  var interactive = true
  var dark: Bool?
  var reduceTransparency = false
  var surface: Surface = .glass
  var tinted = false
  var barShadow = false
  var shown = true
  var shownDuration: TimeInterval = 0.2
  var colors = LookColors()

  private let effectView = UIVisualEffectView()
  private var applied: (tint: UIColor?, interactive: Bool, classic: Bool, tinted: Bool, shown: Bool, colors: LookColors)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    effectView.isAccessibilityElement = false
    super.insertSubview(effectView, at: 0)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: GlassView, _: UITraitCollection) in
      view.applyClassicEdgeAndShadow()
    }
  }

  override func insertSubview(_ view: UIView, at index: Int) {
    if view === effectView || effectView.superview !== self {
      super.insertSubview(view, at: index)
    } else {
      super.insertSubview(view, at: index + 1)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    effectView.frame = bounds
    sendSubviewToBack(effectView)
    applyShape()
  }

  var isSolid: Bool { reduceTransparency || surface == .classic }

  func render() {
    overrideUserInterfaceStyle = dark.map { $0 ? .dark : .light } ?? .unspecified
    let classic = isSolid
    if let applied, applied.tint == tint, applied.interactive == interactive, applied.classic == classic, applied.tinted == tinted, applied.shown == shown, applied.colors == colors {
      applyShape()
      return
    }
    let appearing = applied?.shown == false && shown
    applied = (tint, interactive, classic, tinted, shown, colors)
    let surface = { [self] in
      if classic {
        effectView.effect = nil
        effectView.backgroundColor = tinted ? UIColor(colors.look.surface) : .systemBackground
        effectView.alpha = shown ? 1 : 0
      } else {
        let glass = UIGlassEffect(style: .regular)
        glass.isInteractive = interactive
        glass.tintColor = tint
        effectView.backgroundColor = .clear
        effectView.alpha = 1
        effectView.effect = shown ? glass : nil
      }
    }
    if appearing, window != nil, shownDuration > 0, !UIAccessibility.isReduceMotionEnabled {
      UIView.animate(withDuration: shownDuration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: surface)
    } else {
      surface()
    }
    applyShape()
  }

  private func applyShape() {
    switch shape {
    case .capsule, .circle:
      effectView.cornerConfiguration = .capsule()
    case .rounded:
      effectView.cornerConfiguration = .uniformCorners(radius: .fixed(Double(cornerRadius)))
    }
    effectView.clipsToBounds = isSolid
    effectView.layer.cornerRadius = isSolid ? classicRadius : 0
    effectView.layer.cornerCurve = .continuous
    applyClassicEdgeAndShadow()
  }

  private var classicRadius: CGFloat {
    shape == .rounded ? cornerRadius : min(bounds.width, bounds.height) / 2
  }

  private func applyClassicEdgeAndShadow() {
    let classic = isSolid
    effectView.layer.borderWidth = classic ? Self.classicEdgeWidth : 0
    effectView.layer.borderColor = classic ? Self.classicEdge.resolvedColor(with: traitCollection).cgColor : nil
    let shadows = classic && barShadow
    layer.shadowOpacity = shadows ? 1 : 0
    guard shadows else {
      layer.shadowPath = nil
      return
    }
    let dark = traitCollection.userInterfaceStyle == .dark
    layer.shadowColor = UIColor.black.withAlphaComponent(dark ? 0.4 : 0.12).cgColor
    layer.shadowRadius = Self.classicShadowRadius / 2
    layer.shadowOffset = Self.classicShadowOffset
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: classicRadius).cgPath
  }
}

final class FrostView: LookHostView {
  var variant: LookFrost.Variant = .bar
  var cornerRadius = 0.0
  var colors = LookColors()
  var dark: Bool?
  var reduceTransparency: Bool?

  var isSolid: Bool { reduceTransparency == true || LookHost.pageFrostSolid }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    LookHost.register(self)
  }

  func render() {
    let transparency: Bool? = LookHost.pageFrostSolid ? true : reduceTransparency
    show(LookFrost(variant: variant, look: colors.look, cornerRadius: cornerRadius, reduceTransparency: transparency), dark: colors.isIncognito ? true : dark)
  }
}
