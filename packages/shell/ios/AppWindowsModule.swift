import AppKit
import ArdiaCore
import ExpoModulesCore

public class AppWindowsModule: Module, AppWindowsNative {
  private let lifetime = ModuleLifetime()

  static func windowCornerRadius() -> Double { Double(InterfaceScale.rootLength(fromWindow: ArdiaChromeWindowHost.windowCornerRadius)) }

  static func drawnWindowCornerRadius() -> Double { Double(InterfaceScale.rootLength(fromWindow: ArdiaChromeWindowHost.drawnWindowCornerRadius)) }

  static func frameCornerRadius(_ id: String) -> Double {
    guard let window = WindowManager.shared.window(id) else { return 0 }
    return Double(InterfaceScale.rootLength(fromWindow: ArdiaChromeWindowHost.frameCornerRadius(of: window)))
  }

  static func openWindow(_ id: String, _ options: OpenWindowOptions) { WindowManager.shared.open(id: id, options, focus: options.focus) }

  static func closeWindow(_ id: String) { WindowManager.shared.close(id: id) }

  static func animateWindowClose(_ id: String, _ after: String?, _ promise: Promise) { WindowManager.shared.animateClose(id: id, after: after) { promise.resolve(nil) } }

  static func setTrafficLightsCenter(_ id: String, _ center: CGPoint?, _ trailing: Bool) { WindowManager.shared.setTrafficLightsCenter(id: id, center: center, trailing: trailing) }

  static func watchSidebarEdge(_ id: String, _ on: Bool, _ hold: Double, _ right: Bool, _ whilePressed: Bool) { SidebarEdgeWatcher.shared.watch(id: id, on: on, hold: CGFloat(hold), right: right, whilePressed: whilePressed) }

  static func focusWindow(_ id: String) { WindowManager.shared.focus(id: id) }

  static func setWindowShown(_ id: String, _ shown: Bool, _ burst: Bool) { WindowManager.shared.setShown(id: id, shown: shown, burst: burst) }

  static func restoreFullScreen(_ ids: [String], _ focus: String?) { WindowManager.shared.fullScreen.restore(ids: ids, focus: focus) }

  static func dragPreviewBegin(_ windowId: String, _ chip: CGRect, _ grab: CGPoint) { DragPreview.shared.begin(windowId: windowId, chip: chip, grab: grab) }

  static func dragPreviewPage(_ base64: String, _ frame: CGRect) {
    guard let data = Data(base64Encoded: base64) else { return }
    DragPreview.shared.setPage(data, frame: frame)
  }

  static func dragPreviewUpdate(_ shape: String, _ point: CGPoint) { DragPreview.shared.update(shape: shape, at: point) }

  static func dragPreviewCancel() { DragPreview.shared.cancel() }

  func raiseView(_ tag: Int, _ levels: Int, _ raised: Bool) {
    guard var view = self.appContext?.findView(withTag: tag, ofType: NSView.self) else { return }
    for _ in 0...max(0, levels) {
      guard let parent = view.superview else { return }
      let layers = view.layer.flatMap { layer in parent.layer.flatMap { $0 === layer.superlayer ? (layer, $0) : nil } }
      if raised {
        if parent.subviews.last !== view { parent.addSubview(view, positioned: .above, relativeTo: nil) }
        if let (layer, host) = layers, host.sublayers?.last !== layer { host.addSublayer(layer) }
      } else if let order = parent.value(forKey: "reactSubviews") as? [NSView], let index = order.firstIndex(where: { $0 === view }) {
        if let next = order[(index + 1)...].first(where: { $0.superview === parent }) {
          parent.addSubview(view, positioned: .below, relativeTo: next)
          if let (layer, host) = layers, let below = next.layer, below.superlayer === host { host.insertSublayer(layer, below: below) }
        } else if parent.subviews.last !== view {
          parent.addSubview(view, positioned: .above, relativeTo: nil)
          if let (layer, host) = layers { host.addSublayer(layer) }
        }
      }
      view = parent
    }
  }

  static func dragPreviewPlaceholder(_ title: String, _ favicon: String?) { DragPreview.shared.setPlaceholder(title: title, favicon: favicon) }

  static func windowFrame(_ id: String) -> [Double]? {
    guard let f = WindowManager.shared.window(id)?.frame else { return nil }
    return [f.minX, f.minY, f.width, f.height]
  }

  static func windowGeometry(_ id: String) -> [String: Any]? { WindowManager.shared.geometry(id: id) }

  static func setWindowFrame(_ id: String, _ frame: CGRect) -> [String: Any]? { WindowManager.shared.setFrame(id: id, frame: frame) }

  static func setWindowZoomed(_ id: String, _ on: Bool) -> [String: Any]? { WindowManager.shared.setZoomed(id: id, on: on) }

  static func setWindowFullScreen(_ id: String, _ on: Bool, _ promise: Promise) { WindowManager.shared.setFullScreen(id: id, on: on) { promise.resolve($0) } }

  static func dragPreviewEnd(_ windowId: String?, _ frame: CGRect?) { DragPreview.shared.end(windowId: windowId, fallback: frame) }

  static func setWindowTitle(_ id: String, _ title: String) { WindowManager.shared.setTitle(id: id, title: title) }

  static func windowIds() -> [String] { WindowManager.shared.windowIds }

  static func replyToTerminate(_ ok: Bool) { QuitFlow.shared.replyToTerminate(ok) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)
    Self.eventsDefinition

    OnCreate {
      self.lifetime.begin(self) {
        DragPreview.shared.cancel()
        SidebarEdgeWatcher.shared.reset()
        ShellEvents.retire(self)
      }
      ShellEvents.attach(.window, to: self, while: self.lifetime)
    }

    OnDestroy {
      ShellEvents.detach(self) { owned in
        guard owned.contains(.window) else { return }
        WindowManager.shared.runtimeGone()
        SidebarEdgeWatcher.shared.reset()
      }
      self.lifetime.end()
    }

    Self.windowCornerRadiusFunction
    Self.drawnWindowCornerRadiusFunction
    Self.frameCornerRadiusFunction

    Self.openWindowFunction
    Self.closeWindowFunction
    Self.animateWindowCloseFunction
    Self.setTrafficLightsCenterFunction
    Self.watchSidebarEdgeFunction
    Self.focusWindowFunction
    Self.setWindowShownFunction
    Self.restoreFullScreenFunction
    Self.dragPreviewBeginFunction
    Self.dragPreviewPageFunction
    Self.dragPreviewUpdateFunction
    Self.dragPreviewCancelFunction
    raiseViewFunction
    Self.dragPreviewPlaceholderFunction
    Self.windowFrameFunction
    Self.windowGeometryFunction
    Self.setWindowFrameFunction
    Self.setWindowZoomedFunction
    Self.setWindowFullScreenFunction
    Self.dragPreviewEndFunction
    Self.setWindowTitleFunction
    Self.windowIdsFunction
    Self.replyToTerminateFunction

    View(WindowDragRegion.self) {
      Events("onRegionDoubleClick", "onRegionClick")
      Prop("titleBarDoubleClick") { (view: WindowDragRegion, on: Bool) in view.titleBarDoubleClick = on }
      Prop("clickable") { (view: WindowDragRegion, on: Bool) in view.clickable = on }
    }
  }
}
