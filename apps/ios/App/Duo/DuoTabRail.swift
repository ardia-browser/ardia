import ArdiaBrowser
import ArdiaDesign
import ArdiaSync
import SwiftUI
import UIKit

struct DuoTabRail: View {
  let edge: HorizontalEdge
  let frame: CGRect
  let screen: CGSize
  let openPinned: (_ key: String, _ url: String, _ title: String) -> Void
  let openTab: (UUID) -> Void
  let newTab: () -> Void

  @State private var menu: DuoRailMenuState?

  var body: some View {
    ZStack(alignment: .topLeading) {
      if menu != nil {
        Color.black.opacity(0.001)
          .frame(width: screen.width, height: screen.height)
          .contentShape(.rect)
          .onTapGesture { menu = nil }
          .accessibilityHidden(true)
      }
      VStack(spacing: DuoLayout.railControlsGap) {
        DuoRailGrid(edge: edge, width: frame.width, maxHeight: gridRoom, menu: $menu, openPinned: openPinned, openTab: openTab)
        BarPlusButton(action: newTab)
      }
      .frame(width: frame.width, height: frame.height, alignment: .bottom)
      .offset(x: frame.minX, y: frame.minY)
      if let menu {
        DuoRailMenu(rows: menu.rows)
          .offset(menuOrigin(menu))
          .transition(.opacity.combined(with: .scale(scale: 0.92, anchor: edge == .trailing ? .trailing : .leading)))
          .accessibilityAction(.escape) { self.menu = nil }
      }
    }
    .frame(width: screen.width, height: screen.height, alignment: .topLeading)
    .animation(.snappy(duration: 0.22), value: menu?.cellID)
    .sensoryFeedback(.impact(weight: .medium), trigger: menu?.cellID) { _, new in new != nil }
  }

  private var gridRoom: CGFloat {
    frame.height - DuoLayout.railControlsGap - BrowseLayout.barControl
  }

  private func menuOrigin(_ menu: DuoRailMenuState) -> CGSize {
    let menuHeight = DuoRailMenu.height(menu.rows)
    let gridTop = frame.minY + gridRoom - menu.gridHeight
    let centered = gridTop + menu.cellFrame.midY - menuHeight / 2
    let y = min(max(centered, DuoLayout.cardInset), frame.maxY - menuHeight)
    let x = edge == .trailing
      ? frame.minX - DuoLayout.railBubbleGap - DuoLayout.railMenuWidth
      : frame.maxX + DuoLayout.railBubbleGap
    return CGSize(width: x, height: y)
  }
}

struct DuoRailMenuState {
  var cellID: String
  var cellFrame: CGRect
  var gridHeight: CGFloat
  var rows: [DuoRailMenuRow]
}

private enum DuoRailItem: Identifiable {
  case pinned(PinnedTile)
  case tab(BrowserTab)

  var id: String {
    switch self {
    case .pinned(let tile): "p:" + tile.key
    case .tab(let tab): "t:" + tab.id.uuidString
    }
  }

  var title: String {
    switch self {
    case .pinned(let tile): PinnedTileFace.label(for: tile)
    case .tab(let tab): TabText.title(for: tab)
    }
  }

  var detail: String {
    switch self {
    case .pinned(let tile):
      if let folder = tile.folder, !folder.isEmpty {
        return folder.count == 1 ? String(localized: "1 tab") : String(localized: "\(folder.count) tabs")
      }
      return BrowserURL.host(of: tile.url) ?? ""
    case .tab(let tab): return TabText.host(for: tab)
    }
  }
}

private struct DuoRailCell: Identifiable {
  let item: DuoRailItem
  let frame: CGRect

  var id: String { item.id }
}

private struct DuoRailLayout {
  var cells: [DuoRailCell] = []
  var dividerY: CGFloat?
  var size: CGSize = .zero

  init(pinned: [PinnedTile], tabs: [BrowserTab], width: CGFloat, maxHeight: CGFloat) {
    let pad = DuoLayout.railPadding
    let columns = DuoLayout.railColumns
    let cell = (width - pad * 2) / CGFloat(columns)
    let room = maxHeight - pad * 2
    guard cell > 0, room >= cell else { return }
    let pinnedRows = min(Self.rows(pinned.count, columns), Int((room / cell).rounded(.down)))
    let shownPinned = Array(pinned.prefix(pinnedRows * columns))
    let dividerRoom = pinnedRows > 0 ? DuoLayout.railDividerHeight : 0
    let tabRows = max(Int(((room - CGFloat(pinnedRows) * cell - dividerRoom) / cell).rounded(.down)), 0)
    let shownTabs = Array(Self.newestFirst(tabs).prefix(tabRows * columns))
    var y = pad
    cells += Self.place(shownPinned.map(DuoRailItem.pinned), top: y, cell: cell, columns: columns)
    y += CGFloat(Self.rows(shownPinned.count, columns)) * cell
    if !shownPinned.isEmpty, !shownTabs.isEmpty {
      dividerY = y + DuoLayout.railDividerHeight / 2
      y += DuoLayout.railDividerHeight
    }
    cells += Self.place(shownTabs.map(DuoRailItem.tab), top: y, cell: cell, columns: columns)
    y += CGFloat(Self.rows(shownTabs.count, columns)) * cell
    size = cells.isEmpty ? .zero : CGSize(width: width, height: y + pad)
  }

  private static func rows(_ count: Int, _ columns: Int) -> Int {
    (count + columns - 1) / columns
  }

  private static func newestFirst(_ tabs: [BrowserTab]) -> [BrowserTab] {
    tabs.sorted { lhs, rhs in
      if lhs.isPrivate != rhs.isPrivate { return rhs.isPrivate }
      if lhs.created != rhs.created { return lhs.created > rhs.created }
      return lhs.position > rhs.position
    }
  }

  private static func place(_ items: [DuoRailItem], top: CGFloat, cell: CGFloat, columns: Int) -> [DuoRailCell] {
    items.enumerated().map { index, item in
      let row = index / columns
      let column = index % columns
      return DuoRailCell(item: item, frame: CGRect(x: DuoLayout.railPadding + CGFloat(column) * cell, y: top + CGFloat(row) * cell, width: cell, height: cell))
    }
  }

  func cell(at point: CGPoint) -> DuoRailCell? {
    let bounds = CGRect(origin: .zero, size: size)
    guard bounds.insetBy(dx: -DuoLayout.railCancelDistance, dy: -DuoLayout.railCancelDistance).contains(point) else { return nil }
    let inside = CGPoint(x: min(max(point.x, bounds.minX + 0.5), bounds.maxX - 0.5), y: min(max(point.y, bounds.minY + 0.5), bounds.maxY - 0.5))
    return cells.first { $0.frame.contains(inside) }
  }
}

private struct DuoRailTouch {
  var start: CGPoint
  var cellID: String?
  var moved = false
  var token: Int
}

private struct DuoRailGrid: View {
  let edge: HorizontalEdge
  let width: CGFloat
  let maxHeight: CGFloat
  @Binding var menu: DuoRailMenuState?
  let openPinned: (_ key: String, _ url: String, _ title: String) -> Void
  let openTab: (UUID) -> Void

  @Environment(AppModel.self) private var app
  @Environment(\.dynamicTypeSize) private var typeSize
  @GestureState private var isTouching = false
  @State private var touch: DuoRailTouch?
  @State private var touchCount = 0
  @State private var holdsMenu = false
  @State private var pointerID: String?
  @State private var previewID: String?
  @State private var openFolder: PinnedTile?
  @State private var isConfirmingCloseAll = false

  private var hoveredID: String? {
    if holdsMenu || menu != nil { return menu?.cellID }
    if let touch { return touch.cellID }
    return pointerID ?? previewID
  }

  var body: some View {
    let pinned = app.visiblePinnedTiles
    let linked = Set(pinned.compactMap { app.linkedPinnedTab(key: $0.key)?.id })
    let tabs = app.deckTabs.filter { !linked.contains($0.id) }
    let layout = DuoRailLayout(pinned: pinned, tabs: tabs, width: width, maxHeight: maxHeight)
    let selectedID = selectedID(in: layout)
    let hovered = layout.cells.first { $0.id == hoveredID }
    if !layout.cells.isEmpty {
      ZStack(alignment: .topLeading) {
        if let dividerY = layout.dividerY {
          Capsule()
            .fill(.primary.opacity(0.18))
            .frame(width: width - DuoLayout.railDividerInset * 2, height: 1)
            .position(x: width / 2, y: dividerY)
            .accessibilityHidden(true)
        }
        ForEach(layout.cells) { cell in
          DuoRailIcon(item: cell.item, tint: tint(for: cell.item), isSelected: cell.id == selectedID, isHovered: cell.id == hoveredID, isMenuOpen: cell.id == menu?.cellID, side: cell.frame.width)
            .frame(width: cell.frame.width, height: cell.frame.height)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(cell.item.title)
            .accessibilityValue(cell.item.detail)
            .accessibilityAddTraits(cell.id == selectedID ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { activate(cell.item) }
            .accessibilityAction(named: Text("Show Menu")) { showMenu(for: cell, in: layout) }
            .position(x: cell.frame.midX, y: cell.frame.midY)
        }
      }
      .frame(width: layout.size.width, height: layout.size.height)
      .chromeSurface(in: .rect(cornerRadius: DuoLayout.railRadius, style: .continuous), interactive: false)
      .contentShape(.rect(cornerRadius: DuoLayout.railRadius, style: .continuous))
      .gesture(scrub(layout))
      .onChange(of: isTouching) { _, touching in
        if !touching {
          touch = nil
          holdsMenu = false
        }
      }
      .onContinuousHover { phase in
        switch phase {
        case .active(let point): pointerID = layout.cell(at: point)?.id
        case .ended: pointerID = nil
        }
      }
      .overlay(alignment: edge == .trailing ? .topTrailing : .topLeading) {
        if let hovered, menu == nil {
          DuoRailBubble(item: hovered.item, tint: tint(for: hovered.item), fitted: DuoBubbleText.fitted(title: hovered.item.title, detail: hovered.item.detail, typeSize: typeSize), edge: edge)
            .id(hovered.id)
            .offset(
              x: (width + DuoLayout.railBubbleGap) * (edge == .trailing ? -1 : 1),
              y: hovered.frame.midY - DuoLayout.railBubbleHeight / 2
            )
            .transition(.opacity)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
      }
      .animation(.easeOut(duration: 0.12), value: hovered == nil || menu != nil)
      .sensoryFeedback(.selection, trigger: touch?.cellID) { _, new in new != nil }
      .confirmationDialog(openFolder.map(PinnedTileFace.label(for:)) ?? "", isPresented: folderBinding, titleVisibility: .visible) {
        ForEach(openFolder?.folder ?? []) { tab in
          Button(tab.title.isEmpty ? (BrowserURL.host(of: tab.url) ?? tab.url) : tab.title) { openPinned(tab.key, tab.url, tab.title) }
        }
      }
      .alert(closeAllTitle, isPresented: $isConfirmingCloseAll) {
        Button("Cancel", role: .cancel) {}
        Button("Close All", role: .destructive) { app.closeAllTabs() }
      } message: {
        Text(app.tabs.privateTabs.isEmpty ? "They’ll stay in your Archive." : "Incognito tabs aren’t saved. Other tabs stay in your Archive.")
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Tabs")
      .onAppear {
        for cell in layout.cells { _ = DuoBubbleText.fitted(title: cell.item.title, detail: cell.item.detail, typeSize: typeSize) }
        previewHover(layout)
      }
    }
  }

  private var folderBinding: Binding<Bool> {
    Binding(get: { openFolder != nil }, set: { if !$0 { openFolder = nil } })
  }

  private var closeAllTitle: String {
    let count = app.deckTabs.count
    return count == 1 ? String(localized: "Close 1 Tab?") : String(localized: "Close \(count) Tabs?")
  }

  private func selectedID(in layout: DuoRailLayout) -> String? {
    guard let selected = app.tabs.selectedTab else { return nil }
    for cell in layout.cells {
      if case .pinned(let tile) = cell.item, app.linkedPinnedTab(key: tile.key)?.id == selected.id { return cell.id }
    }
    let tabID = DuoRailItem.tab(selected).id
    if layout.cells.contains(where: { $0.id == tabID }) { return tabID }
    for cell in layout.cells {
      if case .pinned(let tile) = cell.item, tile.url == selected.url || (tile.folder ?? []).contains(where: { $0.url == selected.url }) { return cell.id }
    }
    return nil
  }

  private func tint(for item: DuoRailItem) -> Color? {
    switch item {
    case .tab(let tab):
      return tab.themeColorHex.flatMap { Color(hexString: $0) }
    case .pinned(let tile):
      guard let host = BrowserURL.host(of: tile.url) else { return nil }
      let tab = app.tabs.openTabs.first { BrowserURL.host(of: $0.url) == host && $0.themeColorHex != nil }
      return tab?.themeColorHex.flatMap { Color(hexString: $0) }
    }
  }

  private func activate(_ item: DuoRailItem) {
    switch item {
    case .tab(let tab):
      openTab(tab.id)
    case .pinned(let tile):
      if let folder = tile.folder, !folder.isEmpty {
        openFolder = tile
      } else {
        openPinned(tile.key, tile.url, tile.title)
      }
    }
  }

  private func menuRows(for item: DuoRailItem) -> [DuoRailMenuRow] {
    var rows: [DuoRailMenuRow] = []
    switch item {
    case .pinned(let tile):
      if tile.folder?.isEmpty ?? true {
        if let linked = app.linkedPinnedTab(key: tile.key), linked.url != tile.url {
          rows.append(DuoRailMenuRow(title: String(localized: "Back to Pinned Page"), symbol: "arrow.uturn.backward") {
            app.returnToPinnedPage(key: tile.key, url: tile.url, title: tile.title)
          })
        }
        if let link = URL(string: tile.url) {
          rows.append(DuoRailMenuRow(title: String(localized: "Copy Link"), symbol: "doc.on.doc") { UIPasteboard.general.url = link })
        }
      }
      rows.append(DuoRailMenuRow(title: String(localized: "Unpin on This iPhone"), symbol: "pin.slash", isDestructive: true) {
        app.unpinFromPhone(key: tile.key)
      })
    case .tab(let tab):
      if !tab.isPrivate, URL(string: tab.url) != nil {
        rows.append(DuoRailMenuRow(title: String(localized: "Copy Link"), symbol: "doc.on.doc") { app.copyLink(of: tab) })
      }
      rows.append(DuoRailMenuRow(title: String(localized: "Close Tab"), symbol: "xmark", isDestructive: true) { app.closeTab(tab.id) })
    }
    if !app.deckTabs.isEmpty {
      rows.append(DuoRailMenuRow(title: String(localized: "Close All Tabs"), symbol: "xmark.square", isDestructive: true, startsSection: true) {
        Task {
          try? await Task.sleep(for: .milliseconds(350))
          isConfirmingCloseAll = true
        }
      })
    }
    return rows.map { row in
      var row = row
      let action = row.action
      row.action = {
        menu = nil
        action()
      }
      return row
    }
  }

  private func scrub(_ layout: DuoRailLayout) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .updating($isTouching) { _, state, _ in state = true }
      .onChanged { value in
        guard !holdsMenu else { return }
        let id = layout.cell(at: value.location)?.id
        if var current = touch {
          current.cellID = id
          if hypot(value.location.x - current.start.x, value.location.y - current.start.y) > DuoLayout.railHoldSlop { current.moved = true }
          touch = current
        } else {
          touchCount += 1
          let token = touchCount
          touch = DuoRailTouch(start: value.startLocation, cellID: id, token: token)
          Task {
            try? await Task.sleep(for: DuoLayout.railHoldDuration)
            showMenuIfHeld(token, layout: layout)
          }
        }
      }
      .onEnded { value in
        let held = holdsMenu
        touch = nil
        guard !held, let target = layout.cell(at: value.location) else { return }
        activate(target.item)
      }
  }

  private func showMenuIfHeld(_ token: Int, layout: DuoRailLayout) {
    guard let touch, touch.token == token, !touch.moved, let cell = layout.cells.first(where: { $0.id == touch.cellID }) else { return }
    holdsMenu = true
    showMenu(for: cell, in: layout)
  }

  private func showMenu(for cell: DuoRailCell, in layout: DuoRailLayout) {
    menu = DuoRailMenuState(cellID: cell.id, cellFrame: cell.frame, gridHeight: layout.size.height, rows: menuRows(for: cell.item))
  }

  private func previewHover(_ layout: DuoRailLayout) {
    #if DEBUG
    let arguments = ProcessInfo.processInfo.arguments
    guard let flag = arguments.firstIndex(of: "-DuoRailHover"), arguments.indices.contains(flag + 1),
          let index = Int(arguments[flag + 1]), layout.cells.indices.contains(index) else { return }
    previewID = layout.cells[index].id
    #endif
  }
}

struct DuoRailMenuRow: Identifiable {
  let id = UUID()
  var title: String
  var symbol: String
  var isDestructive = false
  var startsSection = false
  var action: () -> Void
}

private struct DuoRailMenu: View {
  let rows: [DuoRailMenuRow]

  @Environment(\.usesGlass) private var usesGlass

  static func height(_ rows: [DuoRailMenuRow]) -> CGFloat {
    rows.enumerated().reduce(0) { total, entry in
      total + DuoLayout.railMenuRow + (entry.offset == 0 ? 0 : entry.element.startsSection ? DuoLayout.railMenuSectionGap : 0.5)
    }
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: DuoLayout.railMenuRadius, style: .continuous)
    let list = VStack(spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
        if index > 0 {
          Rectangle()
            .fill(.primary.opacity(row.startsSection ? 0.06 : 0.12))
            .frame(height: row.startsSection ? DuoLayout.railMenuSectionGap : 0.5)
        }
        Button(action: row.action) {
          HStack(spacing: 12) {
            Text(row.title)
              .lineLimit(1)
            Spacer(minLength: 12)
            Image(systemName: row.symbol)
              .frame(width: 22)
          }
          .font(.body)
          .foregroundStyle(row.isDestructive ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
          .padding(.horizontal, 16)
          .frame(height: DuoLayout.railMenuRow)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
      }
    }
    .frame(width: DuoLayout.railMenuWidth)
    .clipShape(shape)
    if usesGlass {
      list.glassEffect(.regular, in: shape)
    } else {
      list
        .background(.regularMaterial, in: shape)
        .shadow(color: .black.opacity(0.18), radius: 14, y: 4)
    }
  }
}

private struct DuoRailGlyph: View {
  let item: DuoRailItem
  let tint: Color?
  let size: CGFloat

  var body: some View {
    switch item {
    case .tab(let tab):
      if tab.isPrivate {
        Image(systemName: "eyeglasses")
          .font(.system(size: size * 0.7, weight: .medium))
          .foregroundStyle(.primary)
      } else {
        FaviconImage(iconURL: tab.faviconURL, pageURL: tab.url, size: size, monogramTint: tint)
      }
    case .pinned(let tile):
      if let folder = tile.folder, !folder.isEmpty {
        Image(systemName: "folder.fill")
          .font(.system(size: size * 0.8))
          .foregroundStyle(Palette.formAccent.opacity(0.7))
      } else if let symbol = SpaceColors.symbol(tile.icon) {
        Image(systemName: symbol)
          .font(.system(size: size * 0.75, weight: .medium))
          .foregroundStyle(.primary)
      } else if let emoji = SpaceGlyph.emoji(tile.icon) {
        Text(emoji)
          .font(.system(size: size * 0.85))
      } else {
        FaviconImage(iconURL: nil, pageURL: tile.url, size: size, monogramTint: tint)
      }
    }
  }
}

private struct DuoRailIcon: View {
  let item: DuoRailItem
  let tint: Color?
  let isSelected: Bool
  let isHovered: Bool
  let isMenuOpen: Bool
  let side: CGFloat

  var body: some View {
    ZStack {
      if isSelected || isHovered || isMenuOpen {
        Circle()
          .fill(.primary.opacity(isMenuOpen ? DuoLayout.railMenuFill : isSelected ? DuoLayout.railSelectedFill : DuoLayout.railHoverFill))
          .overlay {
            if isSelected || isMenuOpen {
              Circle().strokeBorder(.primary.opacity(isMenuOpen ? 0.4 : 0.18), lineWidth: isMenuOpen ? 1.5 : 1)
            }
          }
          .padding(DuoLayout.railDiscInset)
      }
      DuoRailGlyph(item: item, tint: tint, size: DuoLayout.railIcon)
    }
    .frame(width: side, height: side)
    .scaleEffect(isMenuOpen ? DuoLayout.railMenuScale : 1)
  }
}

nonisolated struct DuoFittedBubble: Sendable {
  var title: String
  var detail: String
  var textWidth: CGFloat
  var width: CGFloat
}

@MainActor
enum DuoBubbleText {
  private static var cache: [String: DuoFittedBubble] = [:]

  static func fitted(title: String, detail: String, typeSize: DynamicTypeSize) -> DuoFittedBubble {
    let key = "\(typeSize)\u{1}\(title)\u{1}\(detail)"
    if let hit = cache[key] { return hit }
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
    let titleFont = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traits).pointSize, weight: .semibold)
    let detailFont = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traits)
    let chrome = DuoLayout.railBubbleLead + DuoLayout.railBubbleIcon + DuoLayout.railBubbleSpacing + DuoLayout.railBubbleTrail
    let limit = DuoLayout.railBubbleMaxWidth - chrome
    let fittedTitle = shorten(title, font: titleFont, to: limit)
    let fittedDetail = shorten(detail, font: detailFont, to: limit)
    let textWidth = ceil(max(measure(fittedTitle, font: titleFont), measure(fittedDetail, font: detailFont))) + 2
    let fitted = DuoFittedBubble(title: fittedTitle, detail: fittedDetail, textWidth: textWidth, width: textWidth + chrome)
    if cache.count > 512 { cache.removeAll() }
    cache[key] = fitted
    return fitted
  }

  private static func measure(_ text: String, font: UIFont) -> CGFloat {
    (text as NSString).size(withAttributes: [.font: font]).width
  }

  private static func shorten(_ text: String, font: UIFont, to limit: CGFloat) -> String {
    guard measure(text, font: font) > limit else { return text }
    let characters = Array(text)
    var low = 0
    var high = characters.count
    while low < high {
      let mid = (low + high + 1) / 2
      let candidate = String(characters[0..<mid]).trimmingCharacters(in: .whitespaces) + "…"
      if measure(candidate, font: font) <= limit { low = mid } else { high = mid - 1 }
    }
    return String(characters[0..<low]).trimmingCharacters(in: .whitespaces) + "…"
  }
}

private struct DuoRailBubble: View {
  let item: DuoRailItem
  let tint: Color?
  let fitted: DuoFittedBubble
  let edge: HorizontalEdge

  @Environment(\.usesGlass) private var usesGlass

  var body: some View {
    surface
      .frame(width: DuoLayout.railBubbleMaxWidth, alignment: edge == .trailing ? .trailing : .leading)
      .transaction { $0.animation = nil }
  }

  private var content: some View {
    HStack(spacing: DuoLayout.railBubbleSpacing) {
      DuoRailGlyph(item: item, tint: tint, size: DuoLayout.railBubbleIcon)
        .frame(width: DuoLayout.railBubbleIcon, height: DuoLayout.railBubbleIcon)
      VStack(alignment: .leading, spacing: 1) {
        Text(verbatim: fitted.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.primary)
        if !fitted.detail.isEmpty {
          Text(verbatim: fitted.detail)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
      .lineLimit(1)
      .frame(width: fitted.textWidth, alignment: .leading)
    }
    .padding(.leading, DuoLayout.railBubbleLead)
    .padding(.trailing, DuoLayout.railBubbleTrail)
    .frame(width: fitted.width, height: DuoLayout.railBubbleHeight)
  }

  @ViewBuilder
  private var surface: some View {
    if usesGlass {
      content.glassEffect(.regular, in: .capsule)
    } else {
      content
        .background(.regularMaterial, in: .capsule)
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
    }
  }
}
