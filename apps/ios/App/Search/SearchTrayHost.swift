import ArdiaDesign
import SwiftUI

struct SearchTrayHost: View {
  @Environment(AppModel.self) private var app
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.screenLayout) private var screenLayout
  @Environment(\.profileLook) private var look
  @Environment(\.usesGlass) private var usesGlass
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .title3) private var fieldScale: CGFloat = 1
  @State private var shown: BrowseSession.SearchRequest?
  @State private var presentation = 0
  @State private var motion = TrayMotion()
  @State private var removalTask: Task<Void, Never>?
  @State private var barSnapshotTask: Task<Void, Never>?

  private static let removalPoll: Duration = .milliseconds(16)
  private static let removalDeadline: Duration = .seconds(1.5)
  private static let barRest: Duration = .milliseconds(350)

  var body: some View {
    GeometryReader { proxy in
      let command = screenLayout.isWide ? CommandBarPlacement(proxy: proxy, lift: motion.lift) : nil
      let maxHeight = command?.maxHeight ?? maxHeight(in: proxy)
      TrayStage(
        motion: motion,
        content: shown.map { tray(for: $0, maxHeight: maxHeight, isCommandBar: command != nil) },
        commandTop: command.map { proxy.safeAreaInsets.top + $0.top }
      )
      .ignoresSafeArea()
      .accessibilityAddTraits(shown == nil ? [] : .isModal)
    }
    .ignoresSafeArea(.keyboard)
    .onAppear {
      motion.startTrackingKeyboard()
      motion.barAnchor = { [app] in app.barAnchor }
    }
    .onChange(of: reduceMotion, initial: true) { _, reduced in
      motion.reduceMotion = reduced
      reserveBarPill()
    }
    .onChange(of: screenLayout) { _, _ in reserveBarPill() }
    .onChange(of: app.browse.bar.anchors) { _, _ in rememberBarAtRest() }
    .task { await SearchSuggestionsModel.loadRecents(from: app.tabs) }
    .onChange(of: app.browse.search, initial: true) { _, request in
      if let request {
        present(request)
      } else if shown != nil {
        beginClosing()
      }
    }
  }

  private func tray(for request: BrowseSession.SearchRequest, maxHeight: CGFloat, isCommandBar: Bool) -> AnyView {
    AnyView(
      SearchTray(request: request, isFocused: focus, maxHeight: maxHeight, dismissDrag: dismissDrag, reveal: reveal)
        .id(presentation)
        .padding(.horizontal, isCommandBar ? DuoLayout.commandSide : 0)
        .environment(app)
        .environment(\.screenLayout, screenLayout)
        .environment(\.profileLook, look)
        .environment(\.usesGlass, usesGlass)
    )
  }

  private var reveal: TrayReveal {
    TrayReveal(revealsContents: motion.revealsContents, isLeaving: motion.isClosing) { [motion] base in motion.fieldDidReveal(at: base) }
  }

  private var focus: Binding<Bool> {
    Binding { motion.isFocused } set: { motion.isFocused = $0 }
  }

  private func maxHeight(in proxy: GeometryProxy) -> CGFloat {
    let preferred = BrowseLayout.sheetAboveKeyboard + BrowseLayout.searchFieldHeight * (fieldScale - 1)
    let available = proxy.size.height + proxy.safeAreaInsets.bottom - motion.lift - Spacing.tight - BrowseLayout.panelAboveKeyboard
    return max(min(preferred, available), 0)
  }

  private func present(_ request: BrowseSession.SearchRequest) {
    removalTask?.cancel()
    if shown == nil, !app.browse.trayHoldsKeyboard {
      let anchor = app.barAnchor
      barSnapshotTask?.cancel()
      motion.emerge(from: morphsIntoBar ? anchor : nil, fieldCenter: BrowseLayout.panelFieldCenter(fieldHeight: BrowseLayout.searchFieldHeight * fieldScale))
    }
    if shown == nil || motion.isClosing { presentation += 1 }
    shown = request
    reserveBarPill()
    app.browse.trayHoldsKeyboard = true
    app.browse.bar.stopLanding()
    motion.present(dimLevel: request.origin == .page ? BrowseLayout.trayDim : BrowseLayout.trayInvisibleDim) { [app] in app.cancelSearch() }
  }

  private func refreshRecents() {
    let tabs = app.tabs
    Task {
      await SearchSuggestionsModel.loadRecents(from: tabs)
      try? await Task.sleep(for: .seconds(3))
      guard shown == nil else { return }
      await SearchSuggestionsModel.loadRecents(from: tabs)
    }
  }

  private func beginClosing() {
    guard !motion.isClosing else { return }
    motion.isFocused = false
    motion.close(exit)
    removalTask?.cancel()
    removalTask = Task {
      guard await SettlePoll.until(every: Self.removalPoll, within: Self.removalDeadline, { motion.hasSettled }), motion.isClosing else { return }
      finish()
      refreshRecents()
    }
  }

  private func finish() {
    let lands = motion.isFlyingToBar
    motion.finish()
    shown = nil
    if lands { app.browse.bar.land(for: Motion.trayHandOff.duration) } else { app.browse.bar.stopLanding() }
    app.browse.trayHoldsKeyboard = false
    rememberBarAtRest()
  }

  private var exit: TrayExit {
    if app.browse.searchLandsInBar { return .morph(morphLook) }
    return app.browse.searchEnding == .submitted ? .depart : .drop
  }

  private var morphsIntoBar: Bool {
    screenLayout.morphsSearchIntoBar(reduceMotion: reduceMotion)
  }

  private func rememberBarAtRest() {
    barSnapshotTask?.cancel()
    barSnapshotTask = Task {
      try? await Task.sleep(for: Self.barRest)
      guard !Task.isCancelled, shown == nil, !app.browse.trayHoldsKeyboard else { return }
      guard let anchor = app.barAnchor else {
        motion.barFace = nil
        return
      }
      let image = await BarFace.render(anchor.content, size: anchor.frame.size, isDark: anchor.isDark, dynamicType: dynamicTypeSize, scale: displayScale)
      guard !Task.isCancelled, shown == nil else { return }
      motion.barFace = image.map { BarFaceImage(image: $0, of: anchor) }
    }
  }

  private func reserveBarPill() {
    guard app.browse.search != nil else { return }
    app.browse.bar.morphsIntoBar = morphsIntoBar
  }

  private var morphLook: TrayMorphLook {
    let isIncognito = app.isIncognito
    return TrayMorphLook(
      usesGlass: usesGlass,
      panelTint: UIColor(TrayPanel.tint(look: look, isIncognito: isIncognito, reduceTransparency: reduceTransparency)),
      panelStyle: isIncognito ? .dark : .unspecified,
      classicPanel: UIColor(look.surface)
    )
  }

  private var dismissDrag: some Gesture {
    DragGesture(minimumDistance: 6, coordinateSpace: .global)
      .onChanged { value in
        guard !motion.isClosing else { return }
        let translation = value.translation.height
        let releasesKeyboard = TrayDrag.releasesKeyboard(translation: translation) && motion.isFocused
        motion.dragChanged(translation: translation, releasingKeyboard: releasesKeyboard)
        if releasesKeyboard { motion.isFocused = false }
      }
      .onEnded { value in
        let release = motion.release(
          translation: value.translation.height,
          fingerVelocity: value.velocity.height,
          refocusesHeldKeyboard: app.searchFieldMayFocus
        )
        if release == .dismiss { app.cancelSearch() }
      }
  }
}
