import ArdiaBrowser
import ArdiaDesign
import SwiftUI
import UIKit

struct DuoBrowsingView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.screenLayout) private var layout
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var isSidebarShown = false
  @State private var isCaptured = false

  var body: some View {
    GeometryReader { proxy in
      let insets = proxy.safeAreaInsets
      ZStack(alignment: .topLeading) {
        backdrop
        if let fold = layout.fold {
          split(fold: fold, insets: insets, size: fullSize(proxy))
        } else {
          open(insets: insets, size: fullSize(proxy))
        }
      }
      .ignoresSafeArea()
    }
    .ignoresSafeArea(.keyboard)
    .background { CaptureStateProbe(isCaptured: $isCaptured) }
    .onChange(of: app.surface, initial: true) { _, surface in
      guard surface == .tabSwitcher else { return }
      if app.tabs.selectedTab != nil { app.surface = .browsing }
      if layout.fold == nil { setSidebar(true) }
    }
    .onChange(of: app.tabs.selectedTabID) { _, selected in
      if selected != nil, app.surface == .tabSwitcher { app.surface = .browsing }
    }
    .onChange(of: app.browse.search != nil) { _, searching in
      if searching { setSidebar(false) }
    }
    .onChange(of: layout.fold != nil) { _, _ in setSidebar(false) }
  }

  private func fullSize(_ proxy: GeometryProxy) -> CGSize {
    let insets = proxy.safeAreaInsets
    return CGSize(width: proxy.size.width + insets.leading + insets.trailing, height: proxy.size.height + insets.top + insets.bottom)
  }

  @ViewBuilder
  private var backdrop: some View {
    if app.isIncognito {
      ProfileBackdrop(look: .incognito)
    } else {
      ProfileBackdrop(themed: true)
    }
  }

  private static func cardTop(_ insets: EdgeInsets) -> CGFloat {
    DuoLayout.cardTop(safeTop: insets.top)
  }

  private static func cardBottom(_ insets: EdgeInsets) -> CGFloat {
    max(DuoLayout.cardBottom, insets.bottom - DuoLayout.cardIntoHomeIndicator)
  }

  private func open(insets: EdgeInsets, size: CGSize) -> some View {
    let top = Self.cardTop(insets)
    let card = CGRect(
      x: DuoLayout.cardInset + insets.leading,
      y: top,
      width: size.width - DuoLayout.cardInset * 2 - insets.leading - insets.trailing,
      height: size.height - top - Self.cardBottom(insets)
    )
    return ZStack(alignment: .topLeading) {
      pageCard(card)
      DuoToolbar(showsAddress: true, isSidebarShown: isSidebarShown, toggleSidebar: { setSidebar(!isSidebarShown) })
        .frame(width: card.width)
        .offset(x: card.minX, y: card.minY + DuoLayout.toolbarTop)
      if isSidebarShown {
        Color.black.opacity(DuoLayout.pageDim)
          .contentShape(.rect)
          .onTapGesture { setSidebar(false) }
          .accessibilityLabel("Hide Sidebar")
          .accessibilityAddTraits(.isButton)
          .transition(.opacity)
        DuoSidebar(style: .overlay, close: { setSidebar(false) })
          .frame(width: DuoLayout.sidebarWidth, height: size.height - DuoLayout.cardInset - Self.cardBottom(insets))
          .offset(x: DuoLayout.cardInset + insets.leading, y: DuoLayout.cardInset)
          .transition(reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
      }
      if let rail = Self.rail(insets: insets, size: size, isCaptured: isCaptured) {
        DuoTabRail(edge: rail.edge, frame: rail.frame, screen: size, openPinned: openPinnedFromRail, openTab: openTabFromRail, newTab: newTabFromRail)
      }
    }
    .frame(width: size.width, height: size.height, alignment: .topLeading)
  }

  private static func rail(insets: EdgeInsets, size: CGSize, isCaptured: Bool) -> (edge: HorizontalEdge, frame: CGRect)? {
    let edge: HorizontalEdge = insets.trailing >= insets.leading ? .trailing : .leading
    let gutter = edge == .trailing ? insets.trailing : insets.leading
    guard gutter >= DuoLayout.railMinimumInset else { return nil }
    let strip = gutter + DuoLayout.cardInset
    let width = min(strip - DuoLayout.railSideMargin * 2, DuoLayout.railMaxCell * CGFloat(DuoLayout.railColumns) + DuoLayout.railPadding * 2)
    let centerX = edge == .trailing ? size.width - strip / 2 : strip / 2
    let top = DuoLayout.railTop + (isCaptured ? DuoLayout.railCaptureIndicator : 0)
    let height = size.height - top - cardBottom(insets)
    guard height >= BrowseLayout.barControl else { return nil }
    return (edge, CGRect(x: centerX - width / 2, y: top, width: width, height: height))
  }

  private func openPinnedFromRail(key: String, url: String, title: String) {
    setSidebar(false)
    app.openPinnedPage(key: key, url: url, title: title)
  }

  private func openTabFromRail(_ id: UUID) {
    setSidebar(false)
    app.openTab(id)
  }

  private func newTabFromRail() {
    setSidebar(false)
    app.newTab()
  }

  private func split(fold: ScreenLayout.Fold, insets: EdgeInsets, size: CGSize) -> some View {
    let top = Self.cardTop(insets)
    let card = CGRect(
      x: DuoLayout.cardInset,
      y: top,
      width: size.width - DuoLayout.cardInset * 2,
      height: max(fold.top - top - DuoLayout.cardInset, 120)
    )
    return ZStack(alignment: .topLeading) {
      pageCard(card)
      DuoToolbar(showsAddress: false, isSidebarShown: false, toggleSidebar: {})
        .frame(width: card.width)
        .offset(x: card.minX, y: card.minY + DuoLayout.toolbarTop)
      DuoSidebar(style: .panel, close: {})
        .padding(.bottom, insets.bottom)
        .frame(width: size.width, height: size.height - fold.bottom)
        .offset(y: fold.bottom)
    }
    .frame(width: size.width, height: size.height, alignment: .topLeading)
  }

  @ViewBuilder
  private func pageCard(_ card: CGRect) -> some View {
    let shape = RoundedRectangle(cornerRadius: DuoLayout.cardRadius, style: .continuous)
    ZStack {
      if app.tabs.selectedTab != nil {
        BrowsingView(isFront: app.surface == .browsing && !isSidebarShown)
      } else {
        Color.clear
      }
    }
    .frame(width: card.width, height: card.height)
    .clipShape(shape)
    .shadow(color: .black.opacity(0.12), radius: 10, y: 2)
    .offset(x: card.minX, y: card.minY)
  }

  private func setSidebar(_ shown: Bool) {
    if !shown, app.surface == .tabSwitcher, app.tabs.selectedTab == nil { app.surface = .search }
    guard shown != isSidebarShown else { return }
    withAnimation(reduceMotion ? Motion.reducedMotion : DuoLayout.slide) { isSidebarShown = shown }
  }
}

private struct CaptureStateProbe: UIViewRepresentable {
  @Binding var isCaptured: Bool

  func makeUIView(context: Context) -> CaptureStateProbeView {
    let view = CaptureStateProbeView()
    view.onChange = { isCaptured = $0 }
    return view
  }

  func updateUIView(_ view: CaptureStateProbeView, context: Context) {
    view.onChange = { isCaptured = $0 }
  }
}

final class CaptureStateProbeView: UIView {
  var onChange: ((Bool) -> Void)?
  private var reported: Bool?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    registerForTraitChanges([UITraitSceneCaptureState.self]) { (view: CaptureStateProbeView, _: UITraitCollection) in
      view.report()
    }
  }

  required init?(coder: NSCoder) { nil }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    report()
  }

  private func report() {
    let captured = traitCollection.sceneCaptureState == .active
    guard reported != captured else { return }
    reported = captured
    let onChange = onChange
    Task { @MainActor in onChange?(captured) }
  }
}
