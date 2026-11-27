import ArdiaDesign
import ArdiaSync
import ExpoModulesCore
import ExpoUI
import Observation
import SwiftUI
import UIKit

enum SettingsTintChoice {
  static let swatch = "swatch"

  static func color(_ name: String, look: ProfileLook) -> Color {
    name == swatch ? look.swatchColor : (SettingsTint.named(name) ?? SettingsTint.neutral)
  }
}

struct TintedTile: View {
  var systemImage: String
  var tint: String
  var baseSide: CGFloat
  @Environment(\.profileLook) private var look

  var body: some View {
    SettingsIconTile(systemImage: systemImage, color: SettingsTintChoice.color(tint, look: look), baseSide: baseSide)
  }
}

final class SettingsIconTileProps: UIBaseViewProps {
  @Field var systemImage: String = "gearshape"
  @Field var tint: String = "neutral"
  @Field var baseSide: Double = Double(SettingsTile.side)
}

struct SettingsIconTileView: ExpoSwiftUI.View {
  @ObservedObject var props: SettingsIconTileProps

  var body: some View {
    TintedTile(systemImage: props.systemImage, tint: props.tint, baseSide: CGFloat(props.baseSide))
  }
}

final class SettingsRowLabelProps: UIBaseViewProps {
  @Field var title: String = ""
  @Field var systemImage: String = "gearshape"
  @Field var tint: String = "neutral"
}

struct SettingsRowLabelView: ExpoSwiftUI.View {
  @ObservedObject var props: SettingsRowLabelProps
  @Environment(\.profileLook) private var look

  var body: some View {
    SettingsRowLabel(LocalizedStringKey(props.title), systemImage: props.systemImage, tint: SettingsTintChoice.color(props.tint, look: look))
  }
}

final class SettingsHeroContentProps: UIBaseViewProps {
  @Field var title: String = ""
  @Field var subtitle: String = ""
  @Field var subtitleIsWarning: Bool = false
  @Field var systemImage: String = "gearshape"
  @Field var tint: String = "neutral"
}

struct SettingsHeroContentView: ExpoSwiftUI.View {
  @ObservedObject var props: SettingsHeroContentProps
  @Environment(\.profileLook) private var look

  private var subtitle: Text? {
    if props.subtitle.isEmpty { return nil }
    return props.subtitleIsWarning ? Text(props.subtitle).foregroundStyle(.ardiaInk(.orange)) : Text(props.subtitle)
  }

  var body: some View {
    SettingsHeroContent(LocalizedStringKey(props.title), subtitle: subtitle, systemImage: props.systemImage, tint: SettingsTintChoice.color(props.tint, look: look)) {
      Children()
    }
  }
}

final class SetupStepRowProps: UIBaseViewProps {
  @Field var number: Int = 1
  @Field var title: String = ""
  @Field var detail: String = ""
  @Field var progress: String = "upcoming"
}

struct SetupStepRowView: ExpoSwiftUI.View {
  @ObservedObject var props: SetupStepRowProps

  private var progress: SetupStepRow<AnyView>.Progress {
    switch props.progress {
    case "done": .done
    case "current": .current
    default: .upcoming
    }
  }

  var body: some View {
    SetupStepRow(props.number, title: Text(props.title), detail: props.detail.isEmpty ? nil : Text(props.detail), progress: progress) {
      AnyView(Children())
    }
  }
}

final class ColorSwatchProps: UIBaseViewProps {
  @Field var preset: String = "plum"
  @Field var colors: [String] = []
  @Field var ring: String? = nil
  @Field var isSelected: Bool = false
}

struct ColorSwatchView: ExpoSwiftUI.View {
  @ObservedObject var props: ColorSwatchProps

  var body: some View {
    let presetColor = ProfileLook(preset: ProfileLook.Preset(rawValue: props.preset) ?? .plum).swatchColor
    let colors = props.colors.compactMap { Color(hexString: $0) }
    if colors.isEmpty {
      ColorSwatch(color: presetColor, isSelected: props.isSelected)
    } else {
      ColorSwatch(colors: colors, ring: props.ring.flatMap { Color(hexString: $0) } ?? presetColor, isSelected: props.isSelected)
    }
  }
}

final class CheckmarkLabelProps: UIBaseViewProps {
  @Field var title: String = ""
  @Field var isChecked: Bool = false
}

struct CheckmarkLabelView: ExpoSwiftUI.View {
  @ObservedObject var props: CheckmarkLabelProps

  var body: some View {
    CheckmarkLabel(title: props.title, isChecked: props.isChecked)
  }
}

final class AppIconPreviewProps: UIBaseViewProps {
  @Field var side: Double = 29
}

struct AppIconPreviewView: ExpoSwiftUI.View {
  @ObservedObject var props: AppIconPreviewProps

  var body: some View {
    AppIconPreview(side: CGFloat(props.side))
  }
}

struct SettingsShortcutItem: Record {
  @Field var id: String = ""
  @Field var title: String = ""
}

final class SettingsShortcutsProps: UIBaseViewProps {
  @Field var shortcuts: [SettingsShortcutItem] = []
  var onShortcutPress = EventDispatcher()
}

struct SettingsShortcutsView: ExpoSwiftUI.View {
  @ObservedObject var props: SettingsShortcutsProps

  var body: some View {
    SettingsShortcuts(props.shortcuts.map { SettingsShortcut(id: $0.id, title: $0.title) }) { shortcut in
      props.onShortcutPress(["id": shortcut.id])
    }
  }
}

enum SpaceFields {
  static func profile(name: String, icon: String?, color: String?, themeColors: [String], themeDarkColors: [String]?) -> SyncedProfile {
    SyncedProfile(
      syncId: "space", name: name, color: color, icon: icon, isDefault: false,
      theme: themeColors.isEmpty ? nil : SyncedTheme(colors: themeColors, darkColors: themeDarkColors),
      deviceTabs: [], pinned: PinnedArea(), bookmarks: [], history: []
    )
  }

  static func hex(_ color: UIColor) -> String {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    let channel = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
    return String(format: "#%02X%02X%02X", channel(red), channel(green), channel(blue))
  }
}

final class SpaceTitleProps: UIBaseViewProps {
  @Field var name: String = ""
  @Field var icon: String? = nil
  @Field var color: String? = nil
  @Field var themeColors: [String] = []
  @Field var themeDarkColors: [String]? = nil
  @Field var showsChevron: Bool = false
}

struct SpaceTitleView: ExpoSwiftUI.View {
  @ObservedObject var props: SpaceTitleProps

  var body: some View {
    SpaceTitle(space: SpaceFields.profile(name: props.name, icon: props.icon, color: props.color, themeColors: props.themeColors, themeDarkColors: props.themeDarkColors), showsChevron: props.showsChevron)
  }
}

final class GlassCircleButtonProps: UIBaseViewProps {
  @Field var symbol: String = "xmark"
  @Field var label: String = ""
  @Field var diameter: Double = Double(TabsLayout.headerCircle)
  var onButtonPress = EventDispatcher()
}

struct GlassCircleButtonView: ExpoSwiftUI.View {
  @ObservedObject var props: GlassCircleButtonProps

  var body: some View {
    GlassCircleButton(symbol: props.symbol, label: LocalizedStringKey(props.label), diameter: CGFloat(props.diameter)) {
      props.onButtonPress([:])
    }
  }
}

final class SpacePageDotsProps: UIBaseViewProps {
  @Field var count: Int = 1
  @Field var index: Int = 0
}

struct SpacePageDotsView: ExpoSwiftUI.View {
  @ObservedObject var props: SpacePageDotsProps

  var body: some View {
    SpacePageDots(count: max(props.count, 0), index: props.index)
  }
}

struct PinnedTabRecord: Record {
  @Field var key: String = ""
  @Field var title: String = ""
  @Field var url: String = ""
}

struct PinnedTileRecord: Record {
  @Field var key: String = ""
  @Field var title: String = ""
  @Field var url: String = ""
  @Field var icon: String? = nil
  @Field var folder: [PinnedTabRecord]? = nil

  var tile: PinnedTile {
    PinnedTile(key: key, title: title, url: url, icon: icon, folder: folder?.map { PinnedTab(key: $0.key.isEmpty ? $0.url : $0.key, title: $0.title, url: $0.url, icon: nil) })
  }
}

final class PinnedTilesProps: UIBaseViewProps {
  @Field var tiles: [PinnedTileRecord] = []
  var onTileOpen = EventDispatcher()
}

struct PinnedTilesView: ExpoSwiftUI.View {
  @ObservedObject var props: PinnedTilesProps

  var body: some View {
    PinnedTiles(tiles: props.tiles.map(\.tile)) { url, title in
      props.onTileOpen(["url": url, "title": title])
    }
  }
}

struct SpaceBackdropModifier: ViewModifier, Record {
  @Field var color: String? = nil
  @Field var icon: String? = nil
  @Field var themeColors: [String] = []
  @Field var themeDarkColors: [String]? = nil
  @Field var animated: Bool = true

  func body(content: Content) -> some View {
    let space = SpaceFields.profile(name: "", icon: icon, color: color, themeColors: themeColors, themeDarkColors: themeDarkColors)
    content.presentationBackground {
      SpaceBackdropLayer(space: space, animated: animated)
    }
  }
}

struct SpaceBackdropLayer: View {
  let space: SyncedProfile
  let animated: Bool
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.colorSchemeContrast) private var contrast
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    SpaceBackdrop(tones: SpaceTone.colors(for: space, scheme: colorScheme, contrast: contrast))
      .animation(animated && !reduceMotion ? Motion.smooth : nil, value: space)
      .ignoresSafeArea()
  }
}

final class FullScreenCoverProps: UIBaseViewProps {
  @Field var isPresented: Bool = false
  var onIsPresentedChange = EventDispatcher()
}

struct FullScreenCoverView: ExpoSwiftUI.View {
  @ObservedObject var props: FullScreenCoverProps
  @State private var isPresented = false

  var body: some View {
    Color.clear
      .frame(width: 0, height: 0)
      .fullScreenCover(isPresented: $isPresented) {
        Children()
      }
      .onChange(of: isPresented) { _, presented in
        if props.isPresented != presented { props.onIsPresentedChange(["isPresented": presented]) }
      }
      .onChange(of: props.isPresented) { _, presented in isPresented = presented }
      .onAppear { isPresented = props.isPresented }
  }
}

final class FilterTextEditorProps: UIBaseViewProps {
  @Field var text: String = ""
  var onTextChange = EventDispatcher()
}

struct FilterTextEditorView: ExpoSwiftUI.View {
  @ObservedObject var props: FilterTextEditorProps
  @State private var text = ""

  var body: some View {
    TextEditor(text: $text)
      .font(.callout.monospaced())
      .autocorrectionDisabled()
      .textInputAutocapitalization(.never)
      .keyboardType(.asciiCapable)
      .scrollContentBackground(.hidden)
      .padding(.horizontal, Spacing.small)
      .background(Color(.systemBackground))
      .onAppear { text = props.text }
      .onChange(of: props.text) { _, value in
        if value != text { text = value }
      }
      .onChange(of: text) { _, value in
        if value != props.text { props.onTextChange(["text": value]) }
      }
  }
}

struct SettingsChromeModifier: ViewModifier, Record {
  func body(content: Content) -> some View {
    content.ardiaSettingsChrome()
  }
}

struct SettingsPageModifier: ViewModifier, Record {
  @Field var title: String = ""

  func body(content: Content) -> some View {
    content.ardiaSettingsPage(LocalizedStringKey(title))
  }
}

struct ChromeSurfaceModifier: ViewModifier, Record {
  @Field var shape: String = "capsule"
  @Field var cornerRadius: Double = 0
  @Field var tinted: Bool = false

  @ViewBuilder
  func body(content: Content) -> some View {
    switch shape {
    case "circle": content.chromeSurface(in: Circle(), tinted: tinted)
    case "rounded": content.chromeSurface(in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous), tinted: tinted)
    default: content.chromeSurface(in: Capsule(), tinted: tinted)
    }
  }
}

struct SettingsSwitchStyleModifier: ViewModifier, Record {
  func body(content: Content) -> some View {
    content.toggleStyle(.switch).tint(Color(.systemGreen))
  }
}

struct PressableStyleModifier: ViewModifier, Record {
  func body(content: Content) -> some View {
    content.buttonStyle(PressableStyle())
  }
}

struct LegibleInkModifier: ViewModifier, Record {
  @Field var tint: String = "green"

  func body(content: Content) -> some View {
    content.modifier(LegibleInkResolver(tint: tint))
  }
}

struct LegibleInkResolver: ViewModifier {
  var tint: String
  @Environment(\.profileLook) private var look

  func body(content: Content) -> some View {
    content.foregroundStyle(.ardiaInk(tint == "formAccent" ? Palette.formAccent : SettingsTintChoice.color(tint, look: look)))
  }
}

struct AccessibilityFocusRequestModifier: ViewModifier, Record {
  @Field var request: Int = 0

  func body(content: Content) -> some View {
    content.modifier(AccessibilityFocusRequester(request: request))
  }
}

struct AccessibilityFocusRequester: ViewModifier {
  var request: Int
  @AccessibilityFocusState private var isFocused: Bool

  func body(content: Content) -> some View {
    content
      .accessibilityFocused($isFocused)
      .onChange(of: request) { _, value in
        if value > 0 { isFocused = true }
      }
  }
}

struct WidthChangeModifier: ViewModifier, Record {
  var eventDispatcher: EventDispatcher?

  init() {}

  init(from params: Dict, appContext: AppContext, eventDispatcher: EventDispatcher) throws {
    try self = .init(from: params, appContext: appContext)
    self.eventDispatcher = eventDispatcher
  }

  func body(content: Content) -> some View {
    content.onGeometryChange(for: CGFloat.self, of: { proxy in proxy.size.width }, action: { width in
      eventDispatcher?(["ardia.widthChange": ["width": width]])
    })
  }
}

struct MinListRowHeightModifier: ViewModifier, Record {
  @Field var height: Double = 44

  func body(content: Content) -> some View {
    content.environment(\.defaultMinListRowHeight, CGFloat(height))
  }
}

struct BackButtonHiddenModifier: ViewModifier, Record {
  @Field var hidden: Bool = false

  func body(content: Content) -> some View {
    content.navigationBarBackButtonHidden(hidden)
  }
}

struct ContentMarginsModifier: ViewModifier, Record {
  @Field var edges: String = "top"
  @Field var length: Double = 0

  private var edgeSet: Edge.Set {
    switch edges {
    case "bottom": .bottom
    case "all": .all
    default: .top
    }
  }

  func body(content: Content) -> some View {
    content.contentMargins(edgeSet, CGFloat(length), for: .scrollContent)
  }
}

struct ProfileLookModifier: ViewModifier, Record {
  @Field var color: String? = nil
  @Field var themeColors: [String] = []
  @Field var darkThemeColors: [String]? = nil
  @Field var usesGlass: Bool = true

  func body(content: Content) -> some View {
    content
      .environment(\.profileLook, ProfileLook(colorName: color, themeColors: themeColors, darkThemeColors: darkThemeColors))
      .environment(\.usesGlass, usesGlass)
  }
}

enum SettingsUIModifiers {
  static let names = ["ardia.navigationBarBackButtonHidden", "ardia.minListRowHeight", "ardia.spaceBackdrop", "ardia.settingsChrome", "ardia.settingsPage", "ardia.chromeSurface", "ardia.settingsSwitchStyle", "ardia.pressableStyle", "ardia.legibleInk", "ardia.profileLook", "ardia.contentMargins", "ardia.neverBounces", "ardia.accessibilityFocusRequest", "ardia.widthChange"]

  static func register() {
    ViewModifierRegistry.register("ardia.navigationBarBackButtonHidden") { params, context, _ in try BackButtonHiddenModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.minListRowHeight") { params, context, _ in try MinListRowHeightModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.spaceBackdrop") { params, context, _ in try SpaceBackdropModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.settingsChrome") { params, context, _ in try SettingsChromeModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.settingsPage") { params, context, _ in try SettingsPageModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.chromeSurface") { params, context, _ in try ChromeSurfaceModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.settingsSwitchStyle") { params, context, _ in try SettingsSwitchStyleModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.pressableStyle") { params, context, _ in try PressableStyleModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.legibleInk") { params, context, _ in try LegibleInkModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.profileLook") { params, context, _ in try ProfileLookModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.contentMargins") { params, context, _ in try ContentMarginsModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.neverBounces") { params, context, _ in try NeverBouncesModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.accessibilityFocusRequest") { params, context, _ in try AccessibilityFocusRequestModifier(from: params, appContext: context) }
    ViewModifierRegistry.register("ardia.widthChange") { params, context, dispatcher in try WidthChangeModifier(from: params, appContext: context, eventDispatcher: dispatcher) }
  }

  static func unregister() {
    for name in names { ViewModifierRegistry.unregister(name) }
  }
}

@MainActor
@Observable
final class NativeChromeLook {
  static let shared = NativeChromeLook()
  var usesGlass = true
}

public final class SettingsUIModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneSettingsUI")

    OnCreate {
      SettingsUIModifiers.register()
      DispatchQueue.main.async { MainActor.assumeIsolated { ScrollBounceProbe.startIfAsked() } }
    }

    OnDestroy {
      SettingsUIModifiers.unregister()
    }

    ExpoUIView(SettingsIconTileView.self)
    ExpoUIView(SettingsRowLabelView.self)
    ExpoUIView(SettingsHeroContentView.self)
    ExpoUIView(SetupStepRowView.self)
    ExpoUIView(ColorSwatchView.self)
    ExpoUIView(CheckmarkLabelView.self)
    ExpoUIView(AppIconPreviewView.self)
    ExpoUIView(SettingsShortcutsView.self)
    ExpoUIView(SpaceTitleView.self)
    ExpoUIView(GlassCircleButtonView.self)
    ExpoUIView(SpacePageDotsView.self)
    ExpoUIView(PinnedTilesView.self)
    ExpoUIView(FullScreenCoverView.self)
    ExpoUIView(FilterTextEditorView.self)

    Function("setChromeUsesGlass") { (glass: Bool) in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { NativeChromeLook.shared.usesGlass = glass }
      }
    }

    Function("spaceMenuSymbol") { (name: String, icon: String?) -> String in
      SpaceGlyph.menuSymbol(for: SpaceFields.profile(name: name, icon: icon, color: nil, themeColors: [], themeDarkColors: nil))
    }

    Function("spaceSymbol") { (icon: String?) -> String? in
      SpaceColors.symbol(icon)
    }

    Function("spaceColor") { (name: String?) -> [String: String]? in
      guard let color = SpaceColors.color(named: name) else { return nil }
      let resolved = UIColor(color)
      return [
        "light": SpaceFields.hex(resolved.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))),
        "dark": SpaceFields.hex(resolved.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))),
      ]
    }
  }
}
