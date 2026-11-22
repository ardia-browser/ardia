import SwiftUI

#if canImport(UIKit)
public struct SettingsRowLabel: View {
  var title: LocalizedStringKey
  var systemImage: String
  var tint: Color

  public init(_ title: LocalizedStringKey, systemImage: String, tint: Color) {
    self.title = title
    self.systemImage = systemImage
    self.tint = tint
  }

  public var body: some View {
    Label {
      Text(title)
    } icon: {
      SettingsIconTile(systemImage: systemImage, color: tint)
    }
  }
}

public struct SettingsHero<Accessory: View>: View {
  var title: LocalizedStringKey
  var subtitle: Text
  var systemImage: String
  var tint: Color
  var accessory: Accessory

  public init(_ title: LocalizedStringKey, subtitle: Text, systemImage: String, tint: Color, @ViewBuilder accessory: () -> Accessory) {
    self.title = title
    self.subtitle = subtitle
    self.systemImage = systemImage
    self.tint = tint
    self.accessory = accessory()
  }

  public var body: some View {
    Section {
      SettingsHeroContent(title, subtitle: subtitle, systemImage: systemImage, tint: tint) { accessory }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 0, leading: Spacing.page, bottom: 0, trailing: Spacing.page))
    }
  }
}

public struct SettingsHeroContent<Accessory: View>: View {
  var title: LocalizedStringKey
  var subtitle: Text
  var systemImage: String
  var tint: Color
  var accessory: Accessory

  public init(_ title: LocalizedStringKey, subtitle: Text, systemImage: String, tint: Color, @ViewBuilder accessory: () -> Accessory) {
    self.title = title
    self.subtitle = subtitle
    self.systemImage = systemImage
    self.tint = tint
    self.accessory = accessory()
  }

  public var body: some View {
    VStack(spacing: Spacing.small) {
      SettingsIconTile(systemImage: systemImage, color: tint, baseSide: 64)
      VStack(spacing: Spacing.hairline) {
        Text(title)
          .font(.title2.bold())
          .multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        subtitle
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .contentTransition(.opacity)
      }
      accessory
    }
    .frame(maxWidth: .infinity)
    .padding(.bottom, Spacing.hairline)
  }
}

public extension SettingsHero where Accessory == EmptyView {
  init(_ title: LocalizedStringKey, subtitle: Text, systemImage: String, tint: Color) {
    self.init(title, subtitle: subtitle, systemImage: systemImage, tint: tint) { EmptyView() }
  }
}

public struct LegibleInk: ShapeStyle {
  public var tint: Color

  public init(tint: Color) {
    self.tint = tint
  }

  public func resolve(in environment: EnvironmentValues) -> Color {
    let isDark = environment.colorScheme == .dark
    let target: Float = environment.colorSchemeContrast == .increased ? 7 : 4.5
    let surface = isDark
      ? Color.Resolved(red: 0.110, green: 0.110, blue: 0.118)
      : Color.Resolved(red: 0.949, green: 0.949, blue: 0.969)
    let destination = isDark ? Color.Resolved(red: 1, green: 1, blue: 1) : Color.Resolved(red: 0, green: 0, blue: 0)
    let start = tint.resolve(in: environment)
    var candidate = start
    var amount: Float = 0
    while candidate.contrast(against: surface) < target && amount < 1 {
      amount = min(1, amount + 0.03)
      candidate = start.mixed(with: destination, by: amount)
    }
    return Color(candidate)
  }
}

public extension ShapeStyle where Self == LegibleInk {
  static func ardiaInk(_ tint: Color) -> LegibleInk { LegibleInk(tint: tint) }
}

nonisolated extension Color.Resolved {
  func mixed(with other: Color.Resolved, by amount: Float) -> Color.Resolved {
    Color.Resolved(
      red: red + (other.red - red) * amount,
      green: green + (other.green - green) * amount,
      blue: blue + (other.blue - blue) * amount,
      opacity: opacity
    )
  }

  var relativeLuminance: Float {
    0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue
  }

  func contrast(against other: Color.Resolved) -> Float {
    let a = relativeLuminance
    let b = other.relativeLuminance
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
  }
}

public extension View {
  func ardiaSettingsPage(_ title: LocalizedStringKey) -> some View {
    modifier(SettingsPageTitle(title: title))
  }

  func ardiaSettingsChrome() -> some View {
    modifier(SettingsChrome())
  }
}

public enum SettingsSurface {
  #if canImport(UIKit)
  public static let page = Color(uiColor: .systemGroupedBackground)
  #else
  public static let page = Color(nsColor: .windowBackgroundColor)
  #endif
}

private struct SettingsChrome: ViewModifier {
  func body(content: Content) -> some View {
    content
      .scrollContentBackground(.hidden)
      .background { SettingsSurface.page.ignoresSafeArea() }
      .scrollEdgeEffectStyle(.hard, for: .top)
      .toolbarBackground(SettingsSurface.page, for: .navigationBar)
      .toolbarBackgroundVisibility(.visible, for: .navigationBar)
  }
}

private struct SettingsPageTitle: ViewModifier {
  var title: LocalizedStringKey
  @State private var isHeroHidden = false

  func body(content: Content) -> some View {
    content
      .navigationTitle(isHeroHidden ? title : "")
      .navigationBarTitleDisplayMode(.inline)
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentOffset.y + geometry.contentInsets.top > 150
      } action: { _, hidden in
        isHeroHidden = hidden
      }
  }
}

public struct SetupStepRow<Content: View>: View {
  public enum Progress: Equatable { case done, current, upcoming }

  var number: Int
  var title: Text
  var detail: Text
  var progress: Progress
  var content: Content

  @ScaledMetric(relativeTo: .body) private var badge: CGFloat = 26

  public init(_ number: Int, title: Text, detail: Text, progress: Progress, @ViewBuilder content: () -> Content) {
    self.number = number
    self.title = title
    self.detail = detail
    self.progress = progress
    self.content = content()
  }

  public var body: some View {
    HStack(alignment: .top, spacing: Spacing.small) {
      ZStack {
        Circle().fill(badgeFill)
        if progress == .done {
          Image(systemName: "checkmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .transition(.scale.combined(with: .opacity))
        } else {
          Text(number.formatted())
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(progress == .current ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
        }
      }
      .frame(width: badge, height: badge)
      .animation(Motion.snappy, value: progress)
      .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: Spacing.hairline) {
        title
          .font(.body.weight(.semibold))
          .foregroundStyle(progress == .upcoming ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
        detail
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        content
          .padding(.top, Spacing.hairline)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, Spacing.hairline)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(accessibilityTitle)
  }

  private var badgeFill: AnyShapeStyle {
    switch progress {
    case .done: AnyShapeStyle(Color.green)
    case .current: AnyShapeStyle(Palette.formAccent)
    case .upcoming: AnyShapeStyle(.fill.tertiary)
    }
  }

  private var accessibilityTitle: Text {
    switch progress {
    case .done: Text("Step \(number), done")
    case .current: Text("Step \(number)")
    case .upcoming: Text("Step \(number), later")
    }
  }
}

public extension SetupStepRow.Progress {
  static func step(done: Bool, after previous: Bool) -> Self {
    done ? .done : (previous ? .current : .upcoming)
  }
}

public struct AppIconPreview: View {
  public var side: CGFloat = 29
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  private var scaledSide: CGFloat { side * min(scale, 1.4) }

  public init(side: CGFloat = 29) {
    self.side = side
  }

  public var body: some View {
    Image("AppIconPreview")
      .resizable()
      .interpolation(.high)
      .frame(width: scaledSide, height: scaledSide)
      .clipShape(.rect(cornerRadius: scaledSide * 0.225, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: scaledSide * 0.225, style: .continuous)
          .strokeBorder(.primary.opacity(0.08), lineWidth: 0.5)
      }
      .accessibilityHidden(true)
  }
}

public struct SettingsSwitchStyle: ToggleStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    Toggle(configuration)
      .toggleStyle(.switch)
      .tint(Color(.systemGreen))
  }
}

public struct CheckmarkRow: View {
  public var title: String
  public var isChecked: Bool
  public var action: () -> Void

  public init(title: String, isChecked: Bool, action: @escaping () -> Void) {
    self.title = title
    self.isChecked = isChecked
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      CheckmarkLabel(title: title, isChecked: isChecked)
    }
    .tint(.primary)
    .accessibilityAddTraits(isChecked ? .isSelected : [])
  }
}

public struct CheckmarkLabel: View {
  public var title: String
  public var isChecked: Bool

  public init(title: String, isChecked: Bool) {
    self.title = title
    self.isChecked = isChecked
  }

  public var body: some View {
    HStack {
      Text(title)
        .foregroundStyle(.primary)
      Spacer()
      if isChecked {
        Image(systemName: "checkmark")
          .font(.body.weight(.semibold))
          .foregroundStyle(Palette.formAccent)
          .accessibilityHidden(true)
      }
    }
    .contentShape(.rect)
  }
}

public struct ColorSwatch: View {
  public static let side: CGFloat = 26
  public static let ringGap: CGFloat = 3
  public static let ringWidth: CGFloat = 2
  public static let hitHeight: CGFloat = 44

  public var fill: AnyShapeStyle
  public var ring: Color
  public var isSelected: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(color: Color, isSelected: Bool) {
    self.init(fill: AnyShapeStyle(color), ring: color, isSelected: isSelected)
  }

  public init(colors: [Color], ring: Color, isSelected: Bool) {
    let stops = colors.count > 1 ? colors : Array(repeating: colors.first ?? ring, count: 2)
    self.init(fill: AnyShapeStyle(LinearGradient(colors: stops, startPoint: .topLeading, endPoint: .bottomTrailing)), ring: ring, isSelected: isSelected)
  }

  public init(fill: AnyShapeStyle, ring: Color, isSelected: Bool) {
    self.fill = fill
    self.ring = ring
    self.isSelected = isSelected
  }

  public var body: some View {
    Circle()
      .fill(fill)
      .frame(width: Self.side, height: Self.side)
      .padding(Self.ringGap + Self.ringWidth)
      .overlay {
        if isSelected {
          Circle().strokeBorder(ring, lineWidth: Self.ringWidth)
        }
      }
      .frame(minHeight: Self.hitHeight)
      .contentShape(.rect)
      .animation(reduceMotion ? nil : Motion.snappy, value: isSelected)
  }
}

public struct PressableStyle: ButtonStyle {
  public enum Kind: Sendable {
    case icon
    case filled

    public var pressedOpacity: Double {
      switch self {
      case .icon: 0.35
      case .filled: 0.8
      }
    }
  }

  public let kind: Kind

  public init(_ kind: Kind = .icon) {
    self.kind = kind
  }

  public func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .opacity(configuration.isPressed ? kind.pressedOpacity : 1)
      .transaction { $0.animation = nil }
  }
}

public extension View {
  @ViewBuilder
  func chromeButtonStyle(prominent: Bool) -> some View {
    modifier(ChromeButtonStyle(prominent: prominent))
  }
}

private struct ChromeButtonStyle: ViewModifier {
  let prominent: Bool

  @Environment(\.usesGlass) private var usesGlass

  @ViewBuilder
  func body(content: Content) -> some View {
    switch (usesGlass, prominent) {
    case (true, true): content.buttonStyle(.glassProminent)
    case (true, false): content.buttonStyle(.glass)
    case (false, true): content.buttonStyle(.borderedProminent)
    case (false, false): content.buttonStyle(.bordered)
    }
  }
}

public struct SettingsShortcut: Identifiable, Equatable {
  public var id: String
  public var title: String

  public init(id: String, title: String) {
    self.id = id
    self.title = title
  }
}

public struct SettingsShortcuts: View {
  private static let corner: CGFloat = 12

  public var shortcuts: [SettingsShortcut]
  public var action: (SettingsShortcut) -> Void
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  public init(_ shortcuts: [SettingsShortcut], action: @escaping (SettingsShortcut) -> Void) {
    self.shortcuts = shortcuts
    self.action = action
  }

  public var body: some View {
    let layout = dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(spacing: Spacing.small))
      : AnyLayout(HStackLayout(spacing: Spacing.small))
    layout {
      ForEach(shortcuts) { shortcut in
        Button {
          action(shortcut)
        } label: {
          Text(LocalizedStringKey(shortcut.title))
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
        }
        .buttonStyle(PressableStyle())
        .foregroundStyle(.primary)
      }
    }
  }
}
#endif
