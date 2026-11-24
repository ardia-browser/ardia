import ArdiaBrowser
import ArdiaSync
import SwiftUI

#if canImport(UIKit)
public enum SpaceColors {
  nonisolated public static func color(named name: String?) -> Color? {
    guard let name = name?.lowercased(), !name.isEmpty else { return nil }
    if name.hasPrefix("#") { return LookRGB(hexString: name).map { Color(red: $0.red, green: $0.green, blue: $0.blue) } }
    switch name {
    case "red": return .red
    case "orange": return .orange
    case "yellow": return .yellow
    case "green": return .green
    case "mint": return .mint
    case "teal": return .teal
    case "cyan": return .cyan
    case "blue": return .blue
    case "indigo": return .indigo
    case "purple", "violet": return .purple
    case "pink": return .pink
    case "brown": return .brown
    case "gray", "grey": return .gray
    default: return nil
    }
  }

  nonisolated public static func symbol(_ name: String?) -> String? {
    guard let name, !name.isEmpty, UIImage(systemName: name) != nil else { return nil }
    return name
  }
}

public enum SpaceTone {
  public static func colors(for profile: SyncedProfile?, scheme: ColorScheme, contrast: ColorSchemeContrast) -> [Color] {
    let isDark = scheme == .dark
    let strong = contrast == .increased
    let toward: Color = isDark ? .black : .white
    let amount = isDark ? (strong ? 0.8 : 0.66) : (strong ? 0.9 : 0.8)
    if let theme = profile?.theme {
      let source = isDark ? (theme.darkColors ?? theme.colors) : theme.colors
      let colors = source.compactMap { LookRGB(hexString: $0) }.map { Color(red: $0.red, green: $0.green, blue: $0.blue) }
      if !colors.isEmpty {
        let themeAmount = isDark && theme.darkColors != nil ? (strong ? 0.5 : 0.25) : amount
        return colors.map { $0.mix(with: toward, by: themeAmount) }
      }
    }
    let base = ProfileLook(profile: profile).swatchColor
    return [base.mix(with: toward, by: amount), base.mix(with: toward, by: amount + (isDark ? 0.06 : -0.04))]
  }
}

public struct SpaceBackdrop: View {
  public let tones: [Color]
  @Environment(\.colorScheme) private var colorScheme

  public init(tones: [Color]) {
    self.tones = tones
  }

  public var body: some View {
    LinearGradient(colors: tones.count > 1 ? tones : tones + tones, startPoint: .top, endPoint: .bottom)
      .background(colorScheme == .dark ? Color.black : Color.white)
  }
}

public struct SpaceGlyph: View {
  public let space: SyncedProfile
  public var size: CGFloat

  public init(space: SyncedProfile, size: CGFloat = TabsLayout.spaceBadge) {
    self.space = space
    self.size = size
  }

  public var body: some View {
    Group {
      if let symbol = SpaceColors.symbol(space.icon) {
        Image(systemName: Self.filled(symbol))
          .font(.system(size: size * 0.85, weight: .semibold))
          .foregroundStyle(TabsPalette.spaceBadgeInk)
          .frame(width: size * 1.25, height: size)
      } else if let emoji = Self.emoji(space.icon) {
        Text(emoji)
          .font(.system(size: size * 0.8))
          .frame(width: size, height: size)
      }
    }
    .accessibilityHidden(true)
  }

  nonisolated public static func initial(of name: String) -> String {
    name.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "•"
  }

  nonisolated public static func filled(_ symbol: String) -> String {
    let fill = symbol + ".fill"
    return symbol.hasSuffix(".fill") || UIImage(systemName: fill) == nil ? symbol : fill
  }

  nonisolated public static func hasIcon(_ space: SyncedProfile) -> Bool {
    SpaceColors.symbol(space.icon) != nil || emoji(space.icon) != nil
  }

  nonisolated public static func emoji(_ icon: String?) -> String? {
    guard let icon, !icon.isEmpty, icon.count <= 2, icon.unicodeScalars.contains(where: { $0.properties.isEmojiPresentation }) else { return nil }
    return icon
  }

  nonisolated public static func menuSymbol(for space: SyncedProfile) -> String {
    if let symbol = SpaceColors.symbol(space.icon) { return filled(symbol) }
    let letter = initial(of: space.name).lowercased()
    let squared = "\(letter).square.fill"
    return UIImage(systemName: squared) == nil ? "square.fill" : squared
  }
}

public struct SpaceTitle: View {
  public let space: SyncedProfile
  public let showsChevron: Bool

  public init(space: SyncedProfile, showsChevron: Bool) {
    self.space = space
    self.showsChevron = showsChevron
  }

  public var body: some View {
    HStack(spacing: 8) {
      if SpaceGlyph.hasIcon(space) {
        SpaceGlyph(space: space)
      }
      Text(space.name)
        .font(.headline)
        .foregroundStyle(TabsPalette.headerText)
        .lineLimit(1)
      if showsChevron {
        Image(systemName: "chevron.down")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
      }
    }
    .frame(minHeight: BrowseLayout.hitTarget)
    .contentShape(.rect)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(space.name)
  }
}

public struct SpaceSwitcher: View {
  public let spaces: [SyncedProfile]
  public let current: SyncedProfile?
  public var fallbackTitle: LocalizedStringKey
  public let select: (String) -> Void
  @State private var choice = ""

  public init(spaces: [SyncedProfile], current: SyncedProfile?, fallbackTitle: LocalizedStringKey = "Tabs", select: @escaping (String) -> Void) {
    self.spaces = spaces
    self.current = current
    self.fallbackTitle = fallbackTitle
    self.select = select
  }

  public var body: some View {
    content
      .onAppear { choice = current?.syncId ?? "" }
      .onChange(of: current?.syncId) { _, id in choice = id ?? "" }
      .onChange(of: choice) { _, id in
        if !id.isEmpty, id != current?.syncId { select(id) }
      }
  }

  @ViewBuilder
  private var content: some View {
    if let current, spaces.count > 1 {
      Menu {
        Picker("Space", selection: $choice) {
          ForEach(spaces) { space in
            Label(space.name, systemImage: SpaceGlyph.menuSymbol(for: space)).tag(space.syncId)
          }
        }
      } label: {
        SpaceTitle(space: current, showsChevron: true)
      }
      .menuOrder(.fixed)
      .buttonStyle(.plain)
      .accessibilityLabel("Space, \(current.name)")
      .accessibilityHint("Shows your Mac’s spaces.")
    } else if let current {
      SpaceTitle(space: current, showsChevron: false)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    } else {
      Text(fallbackTitle)
        .font(.headline)
        .foregroundStyle(TabsPalette.headerText)
        .accessibilityAddTraits(.isHeader)
    }
  }
}

public struct SpacePageDots: View {
  public let count: Int
  public let index: Int

  public init(count: Int, index: Int) {
    self.count = count
    self.index = index
  }

  public var body: some View {
    HStack(spacing: TabsLayout.pageDotSpacing) {
      ForEach(0..<count, id: \.self) { dot in
        Circle()
          .fill(dot == index ? AnyShapeStyle(TabsPalette.spaceBadgeInk) : AnyShapeStyle(TabsPalette.pageDot))
          .frame(width: TabsLayout.pageDot, height: TabsLayout.pageDot)
      }
    }
    .animation(.easeOut(duration: 0.2), value: index)
    .accessibilityElement()
    .accessibilityLabel("Space \(index + 1) of \(count)")
  }
}

public struct SyncStatusBanner: View {
  public let phase: SyncPhase
  public let status: String
  public let openSettings: () -> Void

  public init(phase: SyncPhase, status: String, openSettings: @escaping () -> Void) {
    self.phase = phase
    self.status = status
    self.openSettings = openSettings
  }

  public var body: some View {
    if let symbol {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Image(systemName: symbol)
          .foregroundStyle(.orange)
        Text(status)
          .font(.subheadline)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        if needsAction {
          Button("Fix", action: openSettings)
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.bordered)
        }
      }
      .padding(12)
      .background(.primary.opacity(0.08), in: .rect(cornerRadius: 14, style: .continuous))
      .padding(.horizontal, Spacing.page)
      .padding(.bottom, Spacing.tight)
    }
  }

  private var needsAction: Bool {
    switch phase {
    case .needsFolderAccess, .locked, .reset: true
    default: false
    }
  }

  private var symbol: String? {
    switch phase {
    case .needsFolderAccess: "folder.badge.questionmark"
    case .locked: "lock.fill"
    case .reset: "exclamationmark.arrow.triangle.2.circlepath"
    case .stalled: "exclamationmark.icloud"
    case .offline: "wifi.slash"
    default: nil
    }
  }
}

public struct GlassCircleButton: View {
  public let symbol: String
  public let label: LocalizedStringKey
  public var diameter: CGFloat
  public let action: () -> Void

  public init(symbol: String, label: LocalizedStringKey, diameter: CGFloat = TabsLayout.barCircle, action: @escaping () -> Void) {
    self.symbol = symbol
    self.label = label
    self.diameter = diameter
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      GlassCircleFace(symbol: symbol, diameter: diameter)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

public struct GlassCircleFace: View {
  public let symbol: String
  public var diameter: CGFloat

  public init(symbol: String, diameter: CGFloat = TabsLayout.barCircle) {
    self.symbol = symbol
    self.diameter = diameter
  }

  public var body: some View {
    Image(systemName: symbol)
      .font(.system(size: 16, weight: .medium))
      .foregroundStyle(.primary)
      .frame(width: diameter, height: diameter)
      .contentShape(.circle)
      .chromeSurface(in: .circle)
  }
}
public struct PinnedTiles: View {
  public let tiles: [PinnedTile]
  public var perRow: Int
  public let open: (_ url: String, _ title: String) -> Void

  public init(tiles: [PinnedTile], perRow: Int = TabsLayout.tilesPerRow, open: @escaping (_ url: String, _ title: String) -> Void) {
    self.tiles = tiles
    self.perRow = perRow
    self.open = open
  }

  public var body: some View {
    let columns = max(1, min(perRow, tiles.count))
    Grid(horizontalSpacing: TabsLayout.tileGap, verticalSpacing: TabsLayout.tileGap) {
      ForEach(Array(stride(from: 0, to: tiles.count, by: columns)), id: \.self) { start in
        GridRow {
          ForEach(tiles[start..<min(start + columns, tiles.count)]) { tile in
            PinnedTileButton(tile: tile, open: open)
          }
          ForEach(0..<max(0, start + columns - tiles.count), id: \.self) { _ in
            Color.clear.frame(height: TabsLayout.tileHeight)
          }
        }
      }
    }
  }
}

private struct PinnedTileButton: View {
  let tile: PinnedTile
  let open: (_ url: String, _ title: String) -> Void

  var body: some View {
    if let folder = tile.folder, !folder.isEmpty {
      Menu {
        ForEach(folder) { tab in
          Button(tab.title.isEmpty ? (BrowserURL.host(of: tab.url) ?? tab.url) : tab.title) { open(tab.url, tab.title) }
        }
      } label: {
        PinnedTileFace(tile: tile, isFolder: true)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(PinnedTileFace.label(for: tile))
      .accessibilityHint("Shows the folder’s tabs.")
    } else {
      Button { open(tile.url, tile.title) } label: {
        PinnedTileFace(tile: tile, isFolder: false)
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel(PinnedTileFace.label(for: tile))
      .contextMenu {
        if let link = URL(string: tile.url) {
          Button("Copy Link") { UIPasteboard.general.url = link }
          ShareLink("Share", item: link)
        }
      }
    }
  }
}

public struct PinnedTileFace: View {
  public let tile: PinnedTile
  public let isFolder: Bool

  public init(tile: PinnedTile, isFolder: Bool) {
    self.tile = tile
    self.isFolder = isFolder
  }

  public var body: some View {
    icon
      .accessibilityHidden(true)
      .frame(maxWidth: .infinity)
      .frame(height: TabsLayout.tileHeight)
      .contentShape(.rect(cornerRadius: TabsLayout.tileRadius, style: .continuous))
      .chromeSurface(in: .rect(cornerRadius: TabsLayout.tileRadius, style: .continuous))
  }

  @ViewBuilder
  private var icon: some View {
    if isFolder {
      Image(systemName: "folder.fill")
        .font(.system(size: TabsLayout.tileIcon * 0.95))
        .foregroundStyle(Palette.formAccent.opacity(0.55))
    } else if let symbol = SpaceColors.symbol(tile.icon) {
      Image(systemName: symbol)
        .font(.system(size: TabsLayout.tileIcon * 0.9, weight: .medium))
        .foregroundStyle(.secondary)
    } else if let emoji = SpaceGlyph.emoji(tile.icon) {
      Text(emoji)
        .font(.system(size: TabsLayout.tileIcon))
    } else {
      FaviconImage(iconURL: nil, pageURL: tile.url, size: TabsLayout.tileIcon)
    }
  }

  public static func label(for tile: PinnedTile) -> String {
    tile.title.isEmpty ? (BrowserURL.host(of: tile.url) ?? tile.url) : tile.title
  }
}
#endif
