import ExpoModulesCore

protocol ShellNative {
  static func setAppearance(_ mode: String)
  static func isDarkAppearance() -> Bool
  static func startDictation()
  static func fetchBangList(_ etag: String?, _ promise: Promise)
  static func copyText(_ text: String)
  static func copyURL(_ address: String)
  static func readText() -> String
}

extension ShellNative {
  static var moduleName: String { "ArdiaShell" }

  static var eventsDefinition: AnyDefinition {
    Events("onOpenURLs", "onAppEvent")
  }

  static var setAppearanceFunction: AnyDefinition {
    AsyncFunction("setAppearance") { (mode: String) in Self.setAppearance(mode) }.runOnQueue(.main)
  }

  static var isDarkAppearanceFunction: AnyDefinition {
    AsyncFunction("isDarkAppearance") { () -> Bool in Self.isDarkAppearance() }.runOnQueue(.main)
  }

  static var startDictationFunction: AnyDefinition {
    Function("startDictation") { () in Self.startDictation() }
  }

  static var fetchBangListFunction: AnyDefinition {
    AsyncFunction("fetchBangList") { (etag: String?, promise: Promise) in Self.fetchBangList(etag, promise) }
  }

  static var copyTextFunction: AnyDefinition {
    Function("copyText") { (text: String) in Self.copyText(text) }
  }

  static var copyURLFunction: AnyDefinition {
    Function("copyURL") { (address: String) in Self.copyURL(address) }
  }

  static var readTextFunction: AnyDefinition {
    AsyncFunction("readText") { () -> String in Self.readText() }.runOnQueue(.main)
  }
}

extension ShellNative where Self: Module {
  func sendOnOpenURLs(_ payload: [String: Any?]) { sendEvent("onOpenURLs", payload) }
  func sendOnAppEvent(_ payload: [String: Any?]) { sendEvent("onAppEvent", payload) }
}

protocol AppWindowsNative {
  static func windowCornerRadius() -> Double
  static func drawnWindowCornerRadius() -> Double
  static func frameCornerRadius(_ id: String) -> Double
  static func openWindow(_ id: String, _ options: OpenWindowOptions)
  static func closeWindow(_ id: String)
  static func animateWindowClose(_ id: String, _ after: String?, _ promise: Promise)
  static func setTrafficLightsCenter(_ id: String, _ center: CGPoint?, _ trailing: Bool)
  static func watchSidebarEdge(_ id: String, _ on: Bool, _ hold: Double, _ right: Bool, _ whilePressed: Bool)
  static func focusWindow(_ id: String)
  static func setWindowShown(_ id: String, _ shown: Bool, _ burst: Bool)
  static func restoreFullScreen(_ ids: [String], _ focus: String?)
  static func dragPreviewBegin(_ windowId: String, _ chip: CGRect, _ grab: CGPoint)
  static func dragPreviewPage(_ base64: String, _ frame: CGRect)
  static func dragPreviewUpdate(_ shape: String, _ point: CGPoint)
  static func dragPreviewCancel()
  func raiseView(_ tag: Int, _ levels: Int, _ raised: Bool)
  static func dragPreviewPlaceholder(_ title: String, _ favicon: String?)
  static func windowFrame(_ id: String) -> [Double]?
  static func windowGeometry(_ id: String) -> [String: Any]?
  static func setWindowFrame(_ id: String, _ frame: CGRect) -> [String: Any]?
  static func setWindowZoomed(_ id: String, _ on: Bool) -> [String: Any]?
  static func setWindowFullScreen(_ id: String, _ on: Bool, _ promise: Promise)
  static func dragPreviewEnd(_ windowId: String?, _ frame: CGRect?)
  static func setWindowTitle(_ id: String, _ title: String)
  static func windowIds() -> [String]
  static func replyToTerminate(_ ok: Bool)
}

extension AppWindowsNative {
  static var moduleName: String { "ArdiaAppWindows" }

  static var eventsDefinition: AnyDefinition {
    Events("onWindowEvent")
  }

  static var windowCornerRadiusFunction: AnyDefinition {
    Function("windowCornerRadius") { () -> Double in Self.windowCornerRadius() }
  }

  static var drawnWindowCornerRadiusFunction: AnyDefinition {
    Function("drawnWindowCornerRadius") { () -> Double in Self.drawnWindowCornerRadius() }
  }

  static var frameCornerRadiusFunction: AnyDefinition {
    AsyncFunction("frameCornerRadius") { (id: String) -> Double in Self.frameCornerRadius(id) }.runOnQueue(.main)
  }

  static var openWindowFunction: AnyDefinition {
    AsyncFunction("openWindow") { (id: String, options: OpenWindowOptions) in Self.openWindow(id, options) }.runOnQueue(.main)
  }

  static var closeWindowFunction: AnyDefinition {
    AsyncFunction("closeWindow") { (id: String) in Self.closeWindow(id) }.runOnQueue(.main)
  }

  static var animateWindowCloseFunction: AnyDefinition {
    AsyncFunction("animateWindowClose") { (id: String, after: String?, promise: Promise) in Self.animateWindowClose(id, after, promise) }.runOnQueue(.main)
  }

  static var setTrafficLightsCenterFunction: AnyDefinition {
    AsyncFunction("setTrafficLightsCenter") { (id: String, center: CGPoint?, trailing: Bool) in Self.setTrafficLightsCenter(id, center, trailing) }.runOnQueue(.main)
  }

  static var watchSidebarEdgeFunction: AnyDefinition {
    AsyncFunction("watchSidebarEdge") { (id: String, on: Bool, hold: Double, right: Bool, whilePressed: Bool) in Self.watchSidebarEdge(id, on, hold, right, whilePressed) }.runOnQueue(.main)
  }

  static var focusWindowFunction: AnyDefinition {
    AsyncFunction("focusWindow") { (id: String) in Self.focusWindow(id) }.runOnQueue(.main)
  }

  static var setWindowShownFunction: AnyDefinition {
    AsyncFunction("setWindowShown") { (id: String, shown: Bool, burst: Bool) in Self.setWindowShown(id, shown, burst) }.runOnQueue(.main)
  }

  static var restoreFullScreenFunction: AnyDefinition {
    AsyncFunction("restoreFullScreen") { (ids: [String], focus: String?) in Self.restoreFullScreen(ids, focus) }.runOnQueue(.main)
  }

  static var dragPreviewBeginFunction: AnyDefinition {
    AsyncFunction("dragPreviewBegin") { (windowId: String, chip: CGRect, grab: CGPoint) in Self.dragPreviewBegin(windowId, chip, grab) }.runOnQueue(.main)
  }

  static var dragPreviewPageFunction: AnyDefinition {
    AsyncFunction("dragPreviewPage") { (base64: String, frame: CGRect) in Self.dragPreviewPage(base64, frame) }.runOnQueue(.main)
  }

  static var dragPreviewUpdateFunction: AnyDefinition {
    AsyncFunction("dragPreviewUpdate") { (shape: String, point: CGPoint) in Self.dragPreviewUpdate(shape, point) }.runOnQueue(.main)
  }

  static var dragPreviewCancelFunction: AnyDefinition {
    AsyncFunction("dragPreviewCancel") { () in Self.dragPreviewCancel() }.runOnQueue(.main)
  }

  static var dragPreviewPlaceholderFunction: AnyDefinition {
    AsyncFunction("dragPreviewPlaceholder") { (title: String, favicon: String?) in Self.dragPreviewPlaceholder(title, favicon) }.runOnQueue(.main)
  }

  static var windowFrameFunction: AnyDefinition {
    AsyncFunction("windowFrame") { (id: String) -> [Double]? in Self.windowFrame(id) }.runOnQueue(.main)
  }

  static var windowGeometryFunction: AnyDefinition {
    AsyncFunction("windowGeometry") { (id: String) -> [String: Any]? in Self.windowGeometry(id) }.runOnQueue(.main)
  }

  static var setWindowFrameFunction: AnyDefinition {
    AsyncFunction("setWindowFrame") { (id: String, frame: CGRect) -> [String: Any]? in Self.setWindowFrame(id, frame) }.runOnQueue(.main)
  }

  static var setWindowZoomedFunction: AnyDefinition {
    AsyncFunction("setWindowZoomed") { (id: String, on: Bool) -> [String: Any]? in Self.setWindowZoomed(id, on) }.runOnQueue(.main)
  }

  static var setWindowFullScreenFunction: AnyDefinition {
    AsyncFunction("setWindowFullScreen") { (id: String, on: Bool, promise: Promise) in Self.setWindowFullScreen(id, on, promise) }.runOnQueue(.main)
  }

  static var dragPreviewEndFunction: AnyDefinition {
    AsyncFunction("dragPreviewEnd") { (windowId: String?, frame: CGRect?) in Self.dragPreviewEnd(windowId, frame) }.runOnQueue(.main)
  }

  static var setWindowTitleFunction: AnyDefinition {
    AsyncFunction("setWindowTitle") { (id: String, title: String) in Self.setWindowTitle(id, title) }.runOnQueue(.main)
  }

  static var windowIdsFunction: AnyDefinition {
    AsyncFunction("windowIds") { () -> [String] in Self.windowIds() }.runOnQueue(.main)
  }

  static var replyToTerminateFunction: AnyDefinition {
    AsyncFunction("replyToTerminate") { (ok: Bool) in Self.replyToTerminate(ok) }.runOnQueue(.main)
  }
}

extension AppWindowsNative where Self: Module {
  func sendOnWindowEvent(_ payload: [String: Any?]) { sendEvent("onWindowEvent", payload) }

  var raiseViewFunction: AnyDefinition {
    AsyncFunction("raiseView") { (tag: Int, levels: Int, raised: Bool) in self.raiseView(tag, levels, raised) }.runOnQueue(.main)
  }
}

protocol FocusNative {
  static func pressesWithoutRelease() -> Int
  static func takeFocusHandoffCounts() -> [String: [String: Int]]
  static func setConsentEpoch(_ epoch: String)
  static func pressRepeated() -> [String: Any]?
  static func takeEditKeyAcks() -> [String: Int]
  static func takeInputSourceKeys() -> Int
  static func cancelFocusMove(_ generation: Int, _ restoringSource: Bool)
  func claimFocus(_ generation: Int, _ tag: Int)
  static func saveKeyResponder(_ windowId: String) -> Int
  static func restoreKeyResponder(_ token: Int) -> Bool
  static func discardKeyResponder(_ token: Int)
  static func fieldBlurCause(_ fieldTag: Int) -> String
  static func watchFieldBlurs(_ fieldTag: Int, _ watch: Bool)
  func setSwitcherCapture(_ active: Bool)
  func setDragEscapeCapture(_ active: Bool)
  static func takeHoverCounts() -> [String: [String: Int]]
  func switcherPointerMoved() -> Bool
}

extension FocusNative {
  static var moduleName: String { "ArdiaFocus" }

  static var pressesWithoutReleaseFunction: AnyDefinition {
    Function("pressesWithoutRelease") { () -> Int in Self.pressesWithoutRelease() }
  }

  static var takeFocusHandoffCountsFunction: AnyDefinition {
    Function("takeFocusHandoffCounts") { () -> [String: [String: Int]] in Self.takeFocusHandoffCounts() }
  }

  static var setConsentEpochFunction: AnyDefinition {
    Function("setConsentEpoch") { (epoch: String) in Self.setConsentEpoch(epoch) }
  }

  static var pressRepeatedFunction: AnyDefinition {
    AsyncFunction("pressRepeated") { () -> [String: Any]? in Self.pressRepeated() }.runOnQueue(.main)
  }

  static var takeEditKeyAcksFunction: AnyDefinition {
    Function("takeEditKeyAcks") { () -> [String: Int] in Self.takeEditKeyAcks() }
  }

  static var takeInputSourceKeysFunction: AnyDefinition {
    Function("takeInputSourceKeys") { () -> Int in Self.takeInputSourceKeys() }
  }

  static var cancelFocusMoveFunction: AnyDefinition {
    AsyncFunction("cancelFocusMove") { (generation: Int, restoringSource: Bool) in Self.cancelFocusMove(generation, restoringSource) }.runOnQueue(.main)
  }

  static var saveKeyResponderFunction: AnyDefinition {
    AsyncFunction("saveKeyResponder") { (windowId: String) -> Int in Self.saveKeyResponder(windowId) }.runOnQueue(.main)
  }

  static var restoreKeyResponderFunction: AnyDefinition {
    AsyncFunction("restoreKeyResponder") { (token: Int) -> Bool in Self.restoreKeyResponder(token) }.runOnQueue(.main)
  }

  static var discardKeyResponderFunction: AnyDefinition {
    AsyncFunction("discardKeyResponder") { (token: Int) in Self.discardKeyResponder(token) }.runOnQueue(.main)
  }

  static var fieldBlurCauseFunction: AnyDefinition {
    Function("fieldBlurCause") { (fieldTag: Int) -> String in Self.fieldBlurCause(fieldTag) }
  }

  static var watchFieldBlursFunction: AnyDefinition {
    Function("watchFieldBlurs") { (fieldTag: Int, watch: Bool) in Self.watchFieldBlurs(fieldTag, watch) }
  }

  static var takeHoverCountsFunction: AnyDefinition {
    Function("takeHoverCounts") { () -> [String: [String: Int]] in Self.takeHoverCounts() }
  }
}

extension FocusNative where Self: Module {
  var claimFocusFunction: AnyDefinition {
    AsyncFunction("claimFocus") { [weak self] (generation: Int, tag: Int) in self?.claimFocus(generation, tag) }.runOnQueue(.main)
  }

  var setSwitcherCaptureFunction: AnyDefinition {
    AsyncFunction("setSwitcherCapture") { [weak self] (active: Bool) in self?.setSwitcherCapture(active) }.runOnQueue(.main)
  }

  var setDragEscapeCaptureFunction: AnyDefinition {
    AsyncFunction("setDragEscapeCapture") { [weak self] (active: Bool) in self?.setDragEscapeCapture(active) }.runOnQueue(.main)
  }

  var switcherPointerMovedFunction: AnyDefinition {
    Function("switcherPointerMoved") { [weak self] () -> Bool in guard let self else { return true }; return self.switcherPointerMoved() }
  }
}

protocol MenusNative {
  static func setMenuState(_ state: MenuStateUpdate)
  static func setMenuBookmarks(_ bookmarks: MenuBookmarks)
  func showMenu(_ items: [MenuItem], _ promise: Promise)
  static func updateMenu(_ items: [MenuItem])
  static func openSurfaces() -> [[String: Any]]
  static func capturePageMenus(_ captures: Bool)
  static func dismissSurface(_ id: String) throws
  static func menuBar() throws -> [[String: Any]]
  static func performMenuBarItem(_ ref: String, _ windowId: String) throws -> String
  static func menuShortcuts() -> [[String: Any]]
  func recordShortcut(_ promise: Promise)
  static func cancelRecording()
  static func mouseShortcutMonitor() -> [String: Any]
}

extension MenusNative {
  static var moduleName: String { "ArdiaMenus" }

  static var eventsDefinition: AnyDefinition {
    Events("onCommand", "onSurface")
  }

  static var setMenuStateFunction: AnyDefinition {
    AsyncFunction("setMenuState") { (state: MenuStateUpdate) in Self.setMenuState(state) }.runOnQueue(.main)
  }

  static var setMenuBookmarksFunction: AnyDefinition {
    AsyncFunction("setMenuBookmarks") { (bookmarks: MenuBookmarks) in Self.setMenuBookmarks(bookmarks) }.runOnQueue(.main)
  }

  static var updateMenuFunction: AnyDefinition {
    AsyncFunction("updateMenu") { (items: [MenuItem]) in Self.updateMenu(items) }.runOnQueue(.main)
  }

  static var openSurfacesFunction: AnyDefinition {
    AsyncFunction("openSurfaces") { () -> [[String: Any]] in Self.openSurfaces() }.runOnQueue(.main)
  }

  static var capturePageMenusFunction: AnyDefinition {
    AsyncFunction("capturePageMenus") { (captures: Bool) in Self.capturePageMenus(captures) }.runOnQueue(.main)
  }

  static var dismissSurfaceFunction: AnyDefinition {
    AsyncFunction("dismissSurface") { (id: String) throws in try Self.dismissSurface(id) }.runOnQueue(.main)
  }

  static var menuBarFunction: AnyDefinition {
    AsyncFunction("menuBar") { () throws -> [[String: Any]] in try Self.menuBar() }.runOnQueue(.main)
  }

  static var performMenuBarItemFunction: AnyDefinition {
    AsyncFunction("performMenuBarItem") { (ref: String, windowId: String) throws -> String in try Self.performMenuBarItem(ref, windowId) }.runOnQueue(.main)
  }

  static var menuShortcutsFunction: AnyDefinition {
    AsyncFunction("menuShortcuts") { () -> [[String: Any]] in Self.menuShortcuts() }.runOnQueue(.main)
  }

  static var cancelRecordingFunction: AnyDefinition {
    AsyncFunction("cancelRecording") { () in Self.cancelRecording() }.runOnQueue(.main)
  }

  static var mouseShortcutMonitorFunction: AnyDefinition {
    AsyncFunction("mouseShortcutMonitor") { () -> [String: Any] in Self.mouseShortcutMonitor() }.runOnQueue(.main)
  }
}

extension MenusNative where Self: Module {
  func sendOnCommand(_ payload: [String: Any?]) { sendEvent("onCommand", payload) }
  func sendOnSurface(_ payload: [String: Any?]) { sendEvent("onSurface", payload) }

  var showMenuFunction: AnyDefinition {
    AsyncFunction("showMenu") { (items: [MenuItem], promise: Promise) in self.showMenu(items, promise) }.runOnQueue(.main)
  }

  var recordShortcutFunction: AnyDefinition {
    AsyncFunction("recordShortcut") { [weak self] (promise: Promise) in if let self { self.recordShortcut(promise) } else { promise.resolve(nil) } }.runOnQueue(.main)
  }
}

protocol DialogsNative {
  static var dismissesShownOnly: Bool { get }
  static func confirm(_ options: ConfirmOptions, _ promise: Promise)
  static func dismissShownOnly(_ key: String?)
  static func choose(_ options: ChooseOptions, _ promise: Promise)
  static func prompt(_ options: PromptOptions, _ promise: Promise)
  static func pickFiles(_ promise: Promise)
  static func pickFolder(_ current: String?, _ prompt: String?, _ promise: Promise)
}

extension DialogsNative {
  static var moduleName: String { "ArdiaDialogs" }

  static var dismissesShownOnlyConstant: AnyDefinition {
    Constant("dismissesShownOnly") { () -> Bool in Self.dismissesShownOnly }
  }

  static var confirmFunction: AnyDefinition {
    AsyncFunction("confirm") { (options: ConfirmOptions, promise: Promise) in Self.confirm(options, promise) }.runOnQueue(.main)
  }

  static var dismissShownOnlyFunction: AnyDefinition {
    AsyncFunction("dismissShownOnly") { (key: String?) in Self.dismissShownOnly(key) }.runOnQueue(.main)
  }

  static var chooseFunction: AnyDefinition {
    AsyncFunction("choose") { (options: ChooseOptions, promise: Promise) in Self.choose(options, promise) }.runOnQueue(.main)
  }

  static var promptFunction: AnyDefinition {
    AsyncFunction("prompt") { (options: PromptOptions, promise: Promise) in Self.prompt(options, promise) }.runOnQueue(.main)
  }

  static var pickFilesFunction: AnyDefinition {
    AsyncFunction("pickFiles") { (promise: Promise) in Self.pickFiles(promise) }.runOnQueue(.main)
  }

  static var pickFolderFunction: AnyDefinition {
    AsyncFunction("pickFolder") { (current: String?, prompt: String?, promise: Promise) in Self.pickFolder(current, prompt, promise) }.runOnQueue(.main)
  }
}

protocol DocumentsNative {
  static func readDocument(_ name: String) -> String?
  static func documentExists(_ name: String) -> Bool
  static func writeDocument(_ name: String, _ contents: String) throws
  static func documentSaved(_ name: String, _ promise: Promise) throws
  static func createDocument(_ name: String, _ contents: String, _ promise: Promise) throws
  static func listDocuments(_ prefix: String) -> [String]
  static func removeDocument(_ name: String) throws
  static func copyDocument(_ name: String, _ copyName: String, _ promise: Promise) throws
  static func syncDocument(_ name: String, _ promise: Promise) throws
  static func saveDocument(_ name: String, _ contents: String, _ promise: Promise) throws
}

extension DocumentsNative {
  static var moduleName: String { "ArdiaDocuments" }

  static var readDocumentFunction: AnyDefinition {
    Function("readDocument") { (name: String) -> String? in Self.readDocument(name) }
  }

  static var documentExistsFunction: AnyDefinition {
    Function("documentExists") { (name: String) -> Bool in Self.documentExists(name) }
  }

  static var writeDocumentFunction: AnyDefinition {
    Function("writeDocument") { (name: String, contents: String) throws in try Self.writeDocument(name, contents) }
  }

  static var documentSavedFunction: AnyDefinition {
    AsyncFunction("documentSaved") { (name: String, promise: Promise) throws in try Self.documentSaved(name, promise) }
  }

  static var createDocumentFunction: AnyDefinition {
    AsyncFunction("createDocument") { (name: String, contents: String, promise: Promise) throws in try Self.createDocument(name, contents, promise) }
  }

  static var listDocumentsFunction: AnyDefinition {
    Function("listDocuments") { (prefix: String) -> [String] in Self.listDocuments(prefix) }
  }

  static var removeDocumentFunction: AnyDefinition {
    Function("removeDocument") { (name: String) throws in try Self.removeDocument(name) }
  }

  static var copyDocumentFunction: AnyDefinition {
    AsyncFunction("copyDocument") { (name: String, copyName: String, promise: Promise) throws in try Self.copyDocument(name, copyName, promise) }
  }

  static var syncDocumentFunction: AnyDefinition {
    AsyncFunction("syncDocument") { (name: String, promise: Promise) throws in try Self.syncDocument(name, promise) }
  }

  static var saveDocumentFunction: AnyDefinition {
    AsyncFunction("saveDocument") { (name: String, contents: String, promise: Promise) throws in try Self.saveDocument(name, contents, promise) }
  }
}

protocol AppNative {
  static var apiVersion: Int { get }
  static func interfaceScale() -> Double
  static func interfaceScaleRange() -> [Double]
  static func setInterfaceScale(_ scale: Double) -> Double
  static func setWindowActivity(_ windowId: String, _ url: String?, _ title: String?)
  static func share(_ url: String, _ title: String?, _ windowId: String?, _ anchor: [Double]?, _ promise: Promise)
  static func shareText(_ text: String, _ windowId: String?, _ anchor: [Double]?, _ promise: Promise)
  static func shareVia(_ service: String, _ url: String, _ title: String?, _ windowId: String?)
  static func isInDock() -> Bool
  static func addToDock() -> Bool
  static func appIcons(_ size: Double) -> [[String: Any]]
  static func appIcon() -> String
  static func setAppIcon(_ id: String)
  static func systemInfo() -> [String: Any]
  static func crashReports(_ since: Double) -> [[String: Any]]
  static func hardwareInfo() -> [String: Any]
  static func diagnosticsSample() -> [String: Any]
  static func openExternalURL(_ url: String) -> Bool
  static func playIntroMusic(_ cues: [String: Double], _ muted: Bool)
  static func setIntroMusicMuted(_ muted: Bool)
  static func stopIntroMusic(_ fade: Double)
  static func launchConfig() -> [String: Any]
}

extension AppNative {
  static var moduleName: String { "ArdiaApp" }

  static var apiVersionConstant: AnyDefinition {
    Constant("apiVersion") { () -> Int in Self.apiVersion }
  }

  static var interfaceScaleFunction: AnyDefinition {
    Function("interfaceScale") { () -> Double in Self.interfaceScale() }
  }

  static var interfaceScaleRangeFunction: AnyDefinition {
    Function("interfaceScaleRange") { () -> [Double] in Self.interfaceScaleRange() }
  }

  static var setInterfaceScaleFunction: AnyDefinition {
    AsyncFunction("setInterfaceScale") { (scale: Double) -> Double in Self.setInterfaceScale(scale) }.runOnQueue(.main)
  }

  static var setWindowActivityFunction: AnyDefinition {
    AsyncFunction("setWindowActivity") { (windowId: String, url: String?, title: String?) in Self.setWindowActivity(windowId, url, title) }.runOnQueue(.main)
  }

  static var shareFunction: AnyDefinition {
    AsyncFunction("share") { (url: String, title: String?, windowId: String?, anchor: [Double]?, promise: Promise) in Self.share(url, title, windowId, anchor, promise) }.runOnQueue(.main)
  }

  static var shareTextFunction: AnyDefinition {
    AsyncFunction("shareText") { (text: String, windowId: String?, anchor: [Double]?, promise: Promise) in Self.shareText(text, windowId, anchor, promise) }.runOnQueue(.main)
  }

  static var shareViaFunction: AnyDefinition {
    AsyncFunction("shareVia") { (service: String, url: String, title: String?, windowId: String?) in Self.shareVia(service, url, title, windowId) }.runOnQueue(.main)
  }

  static var isInDockFunction: AnyDefinition {
    AsyncFunction("isInDock") { () -> Bool in Self.isInDock() }.runOnQueue(.main)
  }

  static var addToDockFunction: AnyDefinition {
    AsyncFunction("addToDock") { () -> Bool in Self.addToDock() }.runOnQueue(.main)
  }

  static var appIconsFunction: AnyDefinition {
    AsyncFunction("appIcons") { (size: Double) -> [[String: Any]] in Self.appIcons(size) }.runOnQueue(.main)
  }

  static var appIconFunction: AnyDefinition {
    AsyncFunction("appIcon") { () -> String in Self.appIcon() }.runOnQueue(.main)
  }

  static var setAppIconFunction: AnyDefinition {
    AsyncFunction("setAppIcon") { (id: String) in Self.setAppIcon(id) }.runOnQueue(.main)
  }

  static var systemInfoFunction: AnyDefinition {
    Function("systemInfo") { () -> [String: Any] in Self.systemInfo() }
  }

  static var crashReportsFunction: AnyDefinition {
    AsyncFunction("crashReports") { (since: Double) -> [[String: Any]] in Self.crashReports(since) }
  }

  static var hardwareInfoFunction: AnyDefinition {
    AsyncFunction("hardwareInfo") { () -> [String: Any] in Self.hardwareInfo() }
  }

  static var diagnosticsSampleFunction: AnyDefinition {
    AsyncFunction("diagnosticsSample") { () -> [String: Any] in Self.diagnosticsSample() }
  }

  static var openExternalURLFunction: AnyDefinition {
    AsyncFunction("openExternalURL") { (url: String) -> Bool in Self.openExternalURL(url) }.runOnQueue(.main)
  }

  static var playIntroMusicFunction: AnyDefinition {
    AsyncFunction("playIntroMusic") { (cues: [String: Double], muted: Bool) in Self.playIntroMusic(cues, muted) }.runOnQueue(.main)
  }

  static var setIntroMusicMutedFunction: AnyDefinition {
    AsyncFunction("setIntroMusicMuted") { (muted: Bool) in Self.setIntroMusicMuted(muted) }.runOnQueue(.main)
  }

  static var stopIntroMusicFunction: AnyDefinition {
    AsyncFunction("stopIntroMusic") { (fade: Double) in Self.stopIntroMusic(fade) }.runOnQueue(.main)
  }

  static var launchConfigFunction: AnyDefinition {
    Function("launchConfig") { () -> [String: Any] in Self.launchConfig() }
  }
}

protocol UpdaterNative {
  static func updaterState() -> [String: Any]
  static func checkForUpdates()
  static func setAutomaticUpdateChecks(_ on: Bool)
  static func setAutomaticUpdateDownloads(_ on: Bool)
  static func setUpdateChannel(_ channel: UpdateChannel)
}

extension UpdaterNative {
  static var moduleName: String { "ArdiaUpdater" }

  static var updaterStateFunction: AnyDefinition {
    AsyncFunction("updaterState") { () -> [String: Any] in Self.updaterState() }.runOnQueue(.main)
  }

  static var checkForUpdatesFunction: AnyDefinition {
    AsyncFunction("checkForUpdates") { () in Self.checkForUpdates() }.runOnQueue(.main)
  }

  static var setAutomaticUpdateChecksFunction: AnyDefinition {
    AsyncFunction("setAutomaticUpdateChecks") { (on: Bool) in Self.setAutomaticUpdateChecks(on) }.runOnQueue(.main)
  }

  static var setAutomaticUpdateDownloadsFunction: AnyDefinition {
    AsyncFunction("setAutomaticUpdateDownloads") { (on: Bool) in Self.setAutomaticUpdateDownloads(on) }.runOnQueue(.main)
  }

  static var setUpdateChannelFunction: AnyDefinition {
    AsyncFunction("setUpdateChannel") { (channel: UpdateChannel) in Self.setUpdateChannel(channel) }.runOnQueue(.main)
  }
}

protocol NotificationsNative {
  static func notificationPermission(_ promise: Promise)
  static func requestNotificationPermission(_ promise: Promise)
  static func postNotification(_ options: NotificationOptions, _ promise: Promise)
  static func removeNotifications(_ ids: [String])
  static func openNotificationSettings()
}

extension NotificationsNative {
  static var moduleName: String { "ArdiaNotifications" }

  static var eventsDefinition: AnyDefinition {
    Events("onNotificationResponse")
  }

  static var notificationPermissionFunction: AnyDefinition {
    AsyncFunction("notificationPermission") { (promise: Promise) in Self.notificationPermission(promise) }.runOnQueue(.main)
  }

  static var requestNotificationPermissionFunction: AnyDefinition {
    AsyncFunction("requestNotificationPermission") { (promise: Promise) in Self.requestNotificationPermission(promise) }.runOnQueue(.main)
  }

  static var postNotificationFunction: AnyDefinition {
    AsyncFunction("postNotification") { (options: NotificationOptions, promise: Promise) in Self.postNotification(options, promise) }.runOnQueue(.main)
  }

  static var removeNotificationsFunction: AnyDefinition {
    AsyncFunction("removeNotifications") { (ids: [String]) in Self.removeNotifications(ids) }.runOnQueue(.main)
  }

  static var openNotificationSettingsFunction: AnyDefinition {
    AsyncFunction("openNotificationSettings") { () in Self.openNotificationSettings() }.runOnQueue(.main)
  }
}

extension NotificationsNative where Self: Module {
  func sendOnNotificationResponse(_ payload: [String: Any?]) { sendEvent("onNotificationResponse", payload) }
}

protocol LocationNative {
  static func locationPermission() -> String
  static func requestLocationPermission(_ promise: Promise)
  static func openLocationSettings()
  static func devLocationRequests() -> Int
}

extension LocationNative {
  static var moduleName: String { "ArdiaLocation" }

  static var locationPermissionFunction: AnyDefinition {
    AsyncFunction("locationPermission") { () -> String in Self.locationPermission() }.runOnQueue(.main)
  }

  static var requestLocationPermissionFunction: AnyDefinition {
    AsyncFunction("requestLocationPermission") { (promise: Promise) in Self.requestLocationPermission(promise) }.runOnQueue(.main)
  }

  static var openLocationSettingsFunction: AnyDefinition {
    AsyncFunction("openLocationSettings") { () in Self.openLocationSettings() }.runOnQueue(.main)
  }

  static var devLocationRequestsFunction: AnyDefinition {
    AsyncFunction("devLocationRequests") { () -> Int in Self.devLocationRequests() }.runOnQueue(.main)
  }
}

protocol ScriptingNative {
  static func setScriptState(_ state: [String: Any])
  static func replyToScript(_ id: String, _ result: [String: Any]?, _ error: String?)
}

extension ScriptingNative {
  static var moduleName: String { "ArdiaScripting" }

  static var eventsDefinition: AnyDefinition {
    Events("onScriptCommand")
  }

  static var setScriptStateFunction: AnyDefinition {
    AsyncFunction("setScriptState") { (state: [String: Any]) in Self.setScriptState(state) }
  }

  static var replyToScriptFunction: AnyDefinition {
    AsyncFunction("replyToScript") { (id: String, result: [String: Any]?, error: String?) in Self.replyToScript(id, result, error) }.runOnQueue(.main)
  }
}

extension ScriptingNative where Self: Module {
  func sendOnScriptCommand(_ payload: [String: Any?]) { sendEvent("onScriptCommand", payload) }
}

protocol DevNative {
  #if DEBUG
  static func devCrash(_ kind: String?)
  static func devBlockMain(_ ms: Double) -> Double
  static func devNotificationCenter(_ actAsEngine: Bool, _ promise: Promise)
  static func devNotificationCategoryRace(_ promise: Promise)
  static func devRenderIntroMusic(_ cues: [String: Double], _ path: String) -> Double?
  static func devLittleArdiaHotKey(_ press: Bool) -> [String: Any]
  static func devMenuCommand(_ command: String, _ arg: String?)
  static func devPostKey(_ windowId: String, _ key: String, _ keyCode: Int, _ modifiers: [String]) -> Bool
  static func devPostKeys(_ windowId: String, _ presses: [[String: Any]], _ promise: Promise)
  func devMenuItems(_ title: String, _ perform: [String]?, _ asTitleBar: Bool?) -> [[String: Any]]
  static func devDragBlockedRects(_ windowId: String) -> [[Double]]
  static func devDragRegionRects(_ windowId: String) -> [[Double]]
  static func devDragRegionState(_ windowId: String) -> [String: Any]
  static func devDragRegionPointer(_ windowId: String, _ x: Double, _ top: Double, _ on: Bool) -> Bool
  static func devReceiveURLsWhenDetached(_ urls: [String], _ timeoutMs: Double)
  static func devURLDelivery() -> [String: Any]
  static func devOpenURLDeliveries() -> [[String: Any]]
  static func devShortcutRecording() -> Bool
  static func devDragPreviewState() -> [String: Any]
  static func devWindowMoveProbe(_ id: String, _ probe: [String: Double], _ promise: Promise)
  static func devWindowResizeProbe(_ id: String, _ probe: [String: Double], _ promise: Promise)
  static func devWindowReplayAfterMove(_ id: String, _ rect: [Double]) -> [String: Any]
  static func devSetWindowFrame(_ id: String, _ rect: [Double]) -> [Double]
  static func devSnapshotWindow(_ windowId: String, _ path: String, _ transparent: Bool?) -> Bool
  static func devSnapshotBurst(_ windowId: String, _ dir: String, _ rect: [Double], _ durationMs: Double, _ promise: Promise)
  static func devSetPointer(_ windowId: String, _ x: Double, _ y: Double, _ on: Bool) -> Bool
  static func devPointerSweep(_ windowId: String, _ sweep: [String: Any], _ promise: Promise)
  static func devSidebarEdgePointer(_ windowId: String, _ x: Double, _ y: Double, _ on: Bool) -> Bool
  static func devSidebarEdgeStats(_ reset: Bool) -> [String: Any]
  static func devHoverStats(_ reset: Bool) -> [String: Any]
  static func devSetMouseButtons(_ pressed: Int) -> Bool
  static func devTypeKeys(_ windowId: String, _ text: String, _ interval: Double, _ promise: Promise)
  static func devFieldTrace(_ on: Bool) -> [[String: Any]]
  static func devKeyEquivalent(_ windowId: String, _ press: [String: Any], _ promise: Promise)
  static func devMenuBar() -> [[String: Any]]
  static func devKeyEquivalentTrace() -> [String]
  static func devFocusHandoffTrace() -> [String]
  static func devClick(_ windowId: String, _ click: [String: Any], _ promise: Promise)
  static func devRunAppleScript(_ source: String, _ promise: Promise)
  #endif
}

extension DevNative {
  static var moduleName: String { "ArdiaDev" }

  #if DEBUG
  static var devCrashFunction: AnyDefinition {
    AsyncFunction("devCrash") { (kind: String?) in Self.devCrash(kind) }
  }

  static var devBlockMainFunction: AnyDefinition {
    AsyncFunction("devBlockMain") { (ms: Double) -> Double in Self.devBlockMain(ms) }
  }

  static var devNotificationCenterFunction: AnyDefinition {
    AsyncFunction("devNotificationCenter") { (actAsEngine: Bool, promise: Promise) in Self.devNotificationCenter(actAsEngine, promise) }
  }

  static var devNotificationCategoryRaceFunction: AnyDefinition {
    AsyncFunction("devNotificationCategoryRace") { (promise: Promise) in Self.devNotificationCategoryRace(promise) }
  }

  static var devRenderIntroMusicFunction: AnyDefinition {
    AsyncFunction("devRenderIntroMusic") { (cues: [String: Double], path: String) -> Double? in Self.devRenderIntroMusic(cues, path) }
  }

  static var devLittleArdiaHotKeyFunction: AnyDefinition {
    AsyncFunction("devLittleArdiaHotKey") { (press: Bool) -> [String: Any] in Self.devLittleArdiaHotKey(press) }.runOnQueue(.main)
  }

  static var devMenuCommandFunction: AnyDefinition {
    AsyncFunction("devMenuCommand") { (command: String, arg: String?) in Self.devMenuCommand(command, arg) }.runOnQueue(.main)
  }

  static var devPostKeyFunction: AnyDefinition {
    AsyncFunction("devPostKey") { (windowId: String, key: String, keyCode: Int, modifiers: [String]) -> Bool in Self.devPostKey(windowId, key, keyCode, modifiers) }.runOnQueue(.main)
  }

  static var devPostKeysFunction: AnyDefinition {
    AsyncFunction("devPostKeys") { (windowId: String, presses: [[String: Any]], promise: Promise) in Self.devPostKeys(windowId, presses, promise) }.runOnQueue(.main)
  }

  static var devDragBlockedRectsFunction: AnyDefinition {
    AsyncFunction("devDragBlockedRects") { (windowId: String) -> [[Double]] in Self.devDragBlockedRects(windowId) }.runOnQueue(.main)
  }

  static var devDragRegionRectsFunction: AnyDefinition {
    AsyncFunction("devDragRegionRects") { (windowId: String) -> [[Double]] in Self.devDragRegionRects(windowId) }.runOnQueue(.main)
  }

  static var devDragRegionStateFunction: AnyDefinition {
    AsyncFunction("devDragRegionState") { (windowId: String) -> [String: Any] in Self.devDragRegionState(windowId) }.runOnQueue(.main)
  }

  static var devDragRegionPointerFunction: AnyDefinition {
    AsyncFunction("devDragRegionPointer") { (windowId: String, x: Double, top: Double, on: Bool) -> Bool in Self.devDragRegionPointer(windowId, x, top, on) }.runOnQueue(.main)
  }

  static var devReceiveURLsWhenDetachedFunction: AnyDefinition {
    Function("devReceiveURLsWhenDetached") { (urls: [String], timeoutMs: Double) in Self.devReceiveURLsWhenDetached(urls, timeoutMs) }
  }

  static var devURLDeliveryFunction: AnyDefinition {
    AsyncFunction("devURLDelivery") { () -> [String: Any] in Self.devURLDelivery() }.runOnQueue(.main)
  }

  static var devOpenURLDeliveriesFunction: AnyDefinition {
    AsyncFunction("devOpenURLDeliveries") { () -> [[String: Any]] in Self.devOpenURLDeliveries() }.runOnQueue(.main)
  }

  static var devShortcutRecordingFunction: AnyDefinition {
    AsyncFunction("devShortcutRecording") { () -> Bool in Self.devShortcutRecording() }.runOnQueue(.main)
  }

  static var devDragPreviewStateFunction: AnyDefinition {
    AsyncFunction("devDragPreviewState") { () -> [String: Any] in Self.devDragPreviewState() }.runOnQueue(.main)
  }

  static var devWindowMoveProbeFunction: AnyDefinition {
    AsyncFunction("devWindowMoveProbe") { (id: String, probe: [String: Double], promise: Promise) in Self.devWindowMoveProbe(id, probe, promise) }.runOnQueue(.main)
  }

  static var devWindowResizeProbeFunction: AnyDefinition {
    AsyncFunction("devWindowResizeProbe") { (id: String, probe: [String: Double], promise: Promise) in Self.devWindowResizeProbe(id, probe, promise) }.runOnQueue(.main)
  }

  static var devWindowReplayAfterMoveFunction: AnyDefinition {
    AsyncFunction("devWindowReplayAfterMove") { (id: String, rect: [Double]) -> [String: Any] in Self.devWindowReplayAfterMove(id, rect) }.runOnQueue(.main)
  }

  static var devSetWindowFrameFunction: AnyDefinition {
    AsyncFunction("devSetWindowFrame") { (id: String, rect: [Double]) -> [Double] in Self.devSetWindowFrame(id, rect) }.runOnQueue(.main)
  }

  static var devSnapshotWindowFunction: AnyDefinition {
    AsyncFunction("devSnapshotWindow") { (windowId: String, path: String, transparent: Bool?) -> Bool in Self.devSnapshotWindow(windowId, path, transparent) }.runOnQueue(.main)
  }

  static var devSnapshotBurstFunction: AnyDefinition {
    AsyncFunction("devSnapshotBurst") { (windowId: String, dir: String, rect: [Double], durationMs: Double, promise: Promise) in Self.devSnapshotBurst(windowId, dir, rect, durationMs, promise) }.runOnQueue(.main)
  }

  static var devSetPointerFunction: AnyDefinition {
    AsyncFunction("devSetPointer") { (windowId: String, x: Double, y: Double, on: Bool) -> Bool in Self.devSetPointer(windowId, x, y, on) }.runOnQueue(.main)
  }

  static var devPointerSweepFunction: AnyDefinition {
    AsyncFunction("devPointerSweep") { (windowId: String, sweep: [String: Any], promise: Promise) in Self.devPointerSweep(windowId, sweep, promise) }.runOnQueue(.main)
  }

  static var devSidebarEdgePointerFunction: AnyDefinition {
    AsyncFunction("devSidebarEdgePointer") { (windowId: String, x: Double, y: Double, on: Bool) -> Bool in Self.devSidebarEdgePointer(windowId, x, y, on) }.runOnQueue(.main)
  }

  static var devSidebarEdgeStatsFunction: AnyDefinition {
    AsyncFunction("devSidebarEdgeStats") { (reset: Bool) -> [String: Any] in Self.devSidebarEdgeStats(reset) }.runOnQueue(.main)
  }

  static var devHoverStatsFunction: AnyDefinition {
    AsyncFunction("devHoverStats") { (reset: Bool) -> [String: Any] in Self.devHoverStats(reset) }.runOnQueue(.main)
  }

  static var devSetMouseButtonsFunction: AnyDefinition {
    AsyncFunction("devSetMouseButtons") { (pressed: Int) -> Bool in Self.devSetMouseButtons(pressed) }.runOnQueue(.main)
  }

  static var devTypeKeysFunction: AnyDefinition {
    AsyncFunction("devTypeKeys") { (windowId: String, text: String, interval: Double, promise: Promise) in Self.devTypeKeys(windowId, text, interval, promise) }
  }

  static var devFieldTraceFunction: AnyDefinition {
    AsyncFunction("devFieldTrace") { (on: Bool) -> [[String: Any]] in Self.devFieldTrace(on) }.runOnQueue(.main)
  }

  static var devKeyEquivalentFunction: AnyDefinition {
    AsyncFunction("devKeyEquivalent") { (windowId: String, press: [String: Any], promise: Promise) in Self.devKeyEquivalent(windowId, press, promise) }.runOnQueue(.main)
  }

  static var devMenuBarFunction: AnyDefinition {
    AsyncFunction("devMenuBar") { () -> [[String: Any]] in Self.devMenuBar() }.runOnQueue(.main)
  }

  static var devKeyEquivalentTraceFunction: AnyDefinition {
    AsyncFunction("devKeyEquivalentTrace") { () -> [String] in Self.devKeyEquivalentTrace() }.runOnQueue(.main)
  }

  static var devFocusHandoffTraceFunction: AnyDefinition {
    AsyncFunction("devFocusHandoffTrace") { () -> [String] in Self.devFocusHandoffTrace() }.runOnQueue(.main)
  }

  static var devClickFunction: AnyDefinition {
    AsyncFunction("devClick") { (windowId: String, click: [String: Any], promise: Promise) in Self.devClick(windowId, click, promise) }.runOnQueue(.main)
  }

  static var devRunAppleScriptFunction: AnyDefinition {
    AsyncFunction("devRunAppleScript") { (source: String, promise: Promise) in Self.devRunAppleScript(source, promise) }
  }
  #endif
}

extension DevNative where Self: Module {
  #if DEBUG
  var devMenuItemsFunction: AnyDefinition {
    AsyncFunction("devMenuItems") { (title: String, perform: [String]?, asTitleBar: Bool?) -> [[String: Any]] in self.devMenuItems(title, perform, asTitleBar) }.runOnQueue(.main)
  }
  #endif
}

protocol SystemNative {
  static var backgroundInstance: Bool { get }
  static func isDefaultBrowser() -> Bool
  static func setAsDefaultBrowser(_ promise: Promise)
  static func launchAtLoginStatus() -> String
  static func setLaunchAtLogin(_ enabled: Bool) throws
  static func fileExists(_ path: String) -> Bool
  static func openFile(_ path: String, _ promise: Promise)
  static func revealFile(_ path: String) -> Bool
  static func moveToTrash(_ path: String) -> Bool
  static func fileIcon(_ path: String, _ size: Double) -> String?
  static func runningAppIcon(_ pid: Int, _ size: Double) -> String?
  static func hapticTick()
  static func setThinScrollBars(_ thin: Bool)
}

extension SystemNative {
  static var moduleName: String { "ArdiaSystem" }

  static var backgroundInstanceConstant: AnyDefinition {
    Constant("backgroundInstance") { () -> Bool in Self.backgroundInstance }
  }

  static var isDefaultBrowserFunction: AnyDefinition {
    AsyncFunction("isDefaultBrowser") { () -> Bool in Self.isDefaultBrowser() }.runOnQueue(.main)
  }

  static var setAsDefaultBrowserFunction: AnyDefinition {
    AsyncFunction("setAsDefaultBrowser") { (promise: Promise) in Self.setAsDefaultBrowser(promise) }.runOnQueue(.main)
  }

  static var launchAtLoginStatusFunction: AnyDefinition {
    AsyncFunction("launchAtLoginStatus") { () -> String in Self.launchAtLoginStatus() }.runOnQueue(DispatchQueue.global(qos: .utility))
  }

  static var setLaunchAtLoginFunction: AnyDefinition {
    AsyncFunction("setLaunchAtLogin") { (enabled: Bool) throws in try Self.setLaunchAtLogin(enabled) }.runOnQueue(.main)
  }

  static var fileExistsFunction: AnyDefinition {
    Function("fileExists") { (path: String) -> Bool in Self.fileExists(path) }
  }

  static var openFileFunction: AnyDefinition {
    AsyncFunction("openFile") { (path: String, promise: Promise) in Self.openFile(path, promise) }.runOnQueue(.main)
  }

  static var revealFileFunction: AnyDefinition {
    AsyncFunction("revealFile") { (path: String) -> Bool in Self.revealFile(path) }.runOnQueue(.main)
  }

  static var moveToTrashFunction: AnyDefinition {
    AsyncFunction("moveToTrash") { (path: String) -> Bool in Self.moveToTrash(path) }.runOnQueue(.main)
  }

  static var fileIconFunction: AnyDefinition {
    AsyncFunction("fileIcon") { (path: String, size: Double) -> String? in Self.fileIcon(path, size) }.runOnQueue(.main)
  }

  static var runningAppIconFunction: AnyDefinition {
    AsyncFunction("runningAppIcon") { (pid: Int, size: Double) -> String? in Self.runningAppIcon(pid, size) }.runOnQueue(.main)
  }

  static var hapticTickFunction: AnyDefinition {
    Function("hapticTick") { () in Self.hapticTick() }
  }

  static var setThinScrollBarsFunction: AnyDefinition {
    AsyncFunction("setThinScrollBars") { (thin: Bool) in Self.setThinScrollBars(thin) }.runOnQueue(.main)
  }
}

protocol CalendarNative {
  static func authorizationStatus() -> String
  func requestAccess(_ promise: Promise)
  func calendars() -> [[String: Any]]
  func events(_ start: Double, _ end: Double, _ calendarIds: [String]) -> [[String: Any]]
}

extension CalendarNative {
  static var moduleName: String { "ArdiaCalendar" }

  static var eventsDefinition: AnyDefinition {
    Events("onCalendarChanged")
  }

  static var authorizationStatusFunction: AnyDefinition {
    Function("authorizationStatus") { () -> String in Self.authorizationStatus() }
  }
}

extension CalendarNative where Self: Module {
  func sendOnCalendarChanged(_ payload: [String: Any?]) { sendEvent("onCalendarChanged", payload) }

  var requestAccessFunction: AnyDefinition {
    AsyncFunction("requestAccess") { (promise: Promise) in self.requestAccess(promise) }.runOnQueue(.main)
  }

  var calendarsFunction: AnyDefinition {
    AsyncFunction("calendars") { () -> [[String: Any]] in self.calendars() }.runOnQueue(.main)
  }

  var eventsFunction: AnyDefinition {
    AsyncFunction("events") { (start: Double, end: Double, calendarIds: [String]) -> [[String: Any]] in self.events(start, end, calendarIds) }.runOnQueue(.main)
  }
}

protocol KeychainNative {
  static func get(_ account: String) -> String?
  static func read(_ account: String) -> [String: Any]
  static func set(_ account: String, _ secret: String) -> Bool
  static func delete(_ account: String) -> Bool
}

extension KeychainNative {
  static var moduleName: String { "ArdiaKeychain" }

  static var getFunction: AnyDefinition {
    AsyncFunction("get") { (account: String) -> String? in Self.get(account) }
  }

  static var readFunction: AnyDefinition {
    AsyncFunction("read") { (account: String) -> [String: Any] in Self.read(account) }
  }

  static var setFunction: AnyDefinition {
    AsyncFunction("set") { (account: String, secret: String) -> Bool in Self.set(account, secret) }
  }

  static var deleteFunction: AnyDefinition {
    AsyncFunction("delete") { (account: String) -> Bool in Self.delete(account) }
  }
}

protocol GlassEffectNative {
  static func isLiquidGlass() -> Bool
}

extension GlassEffectNative {
  static var moduleName: String { "ArdiaGlassEffect" }

  static var isLiquidGlassFunction: AnyDefinition {
    Function("isLiquidGlass") { () -> Bool in Self.isLiquidGlass() }
  }
}

protocol DockSelectionNative {
  static func iconTheme(_ uri: String?, _ emoji: String?) -> [String: Any]?
  static func iconAccent(_ uri: String) -> String?
}

extension DockSelectionNative {
  static var moduleName: String { "ArdiaDockSelection" }

  static var iconThemeFunction: AnyDefinition {
    AsyncFunction("iconTheme") { (uri: String?, emoji: String?) -> [String: Any]? in Self.iconTheme(uri, emoji) }
  }

  static var iconAccentFunction: AnyDefinition {
    AsyncFunction("iconAccent") { (uri: String) -> String? in Self.iconAccent(uri) }
  }
}

protocol InlineCompletionNative {
  func complete(_ tag: Int, _ typed: String, _ completion: String) -> Int
  static func keepWhileTyping(_ tag: Int, _ on: Bool)
  static func takeKept(_ tag: Int, _ start: Int, _ end: Int) -> [String]
  static func copyFieldAs(_ shown: String?, _ url: String?)
}

extension InlineCompletionNative {
  static var moduleName: String { "ArdiaInlineCompletion" }

  static var keepWhileTypingFunction: AnyDefinition {
    AsyncFunction("keepWhileTyping") { (tag: Int, on: Bool) in Self.keepWhileTyping(tag, on) }.runOnQueue(.main)
  }

  static var takeKeptFunction: AnyDefinition {
    Function("takeKept") { (tag: Int, start: Int, end: Int) -> [String] in Self.takeKept(tag, start, end) }
  }

  static var copyFieldAsFunction: AnyDefinition {
    AsyncFunction("copyFieldAs") { (shown: String?, url: String?) in Self.copyFieldAs(shown, url) }.runOnQueue(.main)
  }
}

extension InlineCompletionNative where Self: Module {
  var completeFunction: AnyDefinition {
    AsyncFunction("complete") { (tag: Int, typed: String, completion: String) -> Int in self.complete(tag, typed, completion) }.runOnQueue(.main)
  }
}

protocol TranslateNative {
  static var available: Bool { get }
  static func userLanguages() -> [String]
  static func languageName(_ identifier: String) -> String
  static func detect(_ text: String) -> String?
  static func status(_ source: String, _ target: String) async -> String
  static func supportedLanguages() async -> [String]
  static func prepare(_ source: String, _ target: String) async throws
  static func translateBlocks(_ source: String, _ target: String, _ blocks: [[String]], _ owner: String) async -> [[String]?]
  static func `open`(_ owner: String) async
  static func cancel(_ owner: String) async
  static func translate(_ source: String, _ target: String, _ texts: [String]) async throws -> [String?]
}

extension TranslateNative {
  static var moduleName: String { "ArdiaTranslate" }

  static var availableConstant: AnyDefinition {
    Constant("available") { () -> Bool in Self.available }
  }

  static var userLanguagesFunction: AnyDefinition {
    Function("userLanguages") { () -> [String] in Self.userLanguages() }
  }

  static var languageNameFunction: AnyDefinition {
    Function("languageName") { (identifier: String) -> String in Self.languageName(identifier) }
  }

  static var detectFunction: AnyDefinition {
    AsyncFunction("detect") { (text: String) -> String? in Self.detect(text) }
  }

  static var statusFunction: AnyDefinition {
    AsyncFunction("status") { (source: String, target: String) async -> String in await Self.status(source, target) }
  }

  static var supportedLanguagesFunction: AnyDefinition {
    AsyncFunction("supportedLanguages") { () async -> [String] in await Self.supportedLanguages() }
  }

  static var prepareFunction: AnyDefinition {
    AsyncFunction("prepare") { (source: String, target: String) async throws in try await Self.prepare(source, target) }
  }

  static var translateBlocksFunction: AnyDefinition {
    AsyncFunction("translateBlocks") { (source: String, target: String, blocks: [[String]], owner: String) async -> [[String]?] in await Self.translateBlocks(source, target, blocks, owner) }
  }

  static var openFunction: AnyDefinition {
    AsyncFunction("open") { (owner: String) async in await Self.`open`(owner) }
  }

  static var cancelFunction: AnyDefinition {
    AsyncFunction("cancel") { (owner: String) async in await Self.cancel(owner) }
  }

  static var translateFunction: AnyDefinition {
    AsyncFunction("translate") { (source: String, target: String, texts: [String]) async throws -> [String?] in try await Self.translate(source, target, texts) }
  }
}

protocol MagnifyAreaNative {
  static func devMagnify(_ windowId: String, _ x: Double, _ y: Double, _ steps: [[String: Any]]) -> [String: Any]
}

extension MagnifyAreaNative {
  static var moduleName: String { "ArdiaMagnifyArea" }

  static var devMagnifyFunction: AnyDefinition {
    AsyncFunction("devMagnify") { (windowId: String, x: Double, y: Double, steps: [[String: Any]]) -> [String: Any] in Self.devMagnify(windowId, x, y, steps) }.runOnQueue(.main)
  }
}

protocol WheelAreaNative {
  static func devWheel(_ windowId: String, _ x: Double, _ y: Double, _ steps: [[String: Any]], _ promise: Promise)
  func glideScroll(_ tag: Int, _ y: Double, _ durationMs: Double)
  func steerScroll(_ tag: Int, _ lo: Double, _ hi: Double, _ glideMs: Double, _ canForward: Bool, _ canBack: Bool)
}

extension WheelAreaNative {
  static var moduleName: String { "ArdiaWheelArea" }

  static var devWheelFunction: AnyDefinition {
    AsyncFunction("devWheel") { (windowId: String, x: Double, y: Double, steps: [[String: Any]], promise: Promise) in Self.devWheel(windowId, x, y, steps, promise) }.runOnQueue(.main)
  }
}

extension WheelAreaNative where Self: Module {
  var glideScrollFunction: AnyDefinition {
    AsyncFunction("glideScroll") { (tag: Int, y: Double, durationMs: Double) in self.glideScroll(tag, y, durationMs) }.runOnQueue(.main)
  }

  var steerScrollFunction: AnyDefinition {
    AsyncFunction("steerScroll") { (tag: Int, lo: Double, hi: Double, glideMs: Double, canForward: Bool, canBack: Bool) in self.steerScroll(tag, lo, hi, glideMs, canForward, canBack) }.runOnQueue(.main)
  }
}

protocol PeekStageNative {
  static func devState(_ windowId: String) -> [[String: Any]]
  static func devPageFrames(_ windowId: String) -> [[String: Any]]
  static func devPostMagnify(_ windowId: String, _ x: Double, _ y: Double, _ phase: String, _ magnification: Double) -> [String: Any]
  static func devPostScroll(_ windowId: String, _ x: Double, _ y: Double, _ dy: Int) -> [String: Any]
  static func devPostButton(_ windowId: String, _ x: Double, _ y: Double, _ button: Int) -> [String: Any]
}

extension PeekStageNative {
  static var moduleName: String { "ArdiaPeekStage" }

  static var devStateFunction: AnyDefinition {
    AsyncFunction("devState") { (windowId: String) -> [[String: Any]] in Self.devState(windowId) }.runOnQueue(.main)
  }

  static var devPageFramesFunction: AnyDefinition {
    AsyncFunction("devPageFrames") { (windowId: String) -> [[String: Any]] in Self.devPageFrames(windowId) }.runOnQueue(.main)
  }

  static var devPostMagnifyFunction: AnyDefinition {
    AsyncFunction("devPostMagnify") { (windowId: String, x: Double, y: Double, phase: String, magnification: Double) -> [String: Any] in Self.devPostMagnify(windowId, x, y, phase, magnification) }.runOnQueue(.main)
  }

  static var devPostScrollFunction: AnyDefinition {
    AsyncFunction("devPostScroll") { (windowId: String, x: Double, y: Double, dy: Int) -> [String: Any] in Self.devPostScroll(windowId, x, y, dy) }.runOnQueue(.main)
  }

  static var devPostButtonFunction: AnyDefinition {
    AsyncFunction("devPostButton") { (windowId: String, x: Double, y: Double, button: Int) -> [String: Any] in Self.devPostButton(windowId, x, y, button) }.runOnQueue(.main)
  }
}

protocol FileDropNative {
  static func devDrag(_ windowId: String, _ action: String, _ x: Double, _ y: Double, _ payload: [String: Any]?) -> String
  static func devLastFileDrag() -> [String]
}

extension FileDropNative {
  static var moduleName: String { "ArdiaFileDrop" }

  static var devDragFunction: AnyDefinition {
    AsyncFunction("devDrag") { (windowId: String, action: String, x: Double, y: Double, payload: [String: Any]?) -> String in Self.devDrag(windowId, action, x, y, payload) }.runOnQueue(.main)
  }

  static var devLastFileDragFunction: AnyDefinition {
    AsyncFunction("devLastFileDrag") { () -> [String] in Self.devLastFileDrag() }.runOnQueue(.main)
  }
}

protocol UserScriptsNative {
  static var queue: DispatchQueue { get }
  static func watch(_ on: Bool)
  static func read() -> [String: Any]
  static func readStatus() -> String?
  static func writeStatus(_ json: String) throws
}

extension UserScriptsNative {
  static var moduleName: String { "ArdiaUserScripts" }

  static var eventsDefinition: AnyDefinition {
    Events("onChange")
  }

  static var watchFunction: AnyDefinition {
    Function("watch") { (on: Bool) in Self.watch(on) }
  }

  static var readFunction: AnyDefinition {
    AsyncFunction("read") { () -> [String: Any] in Self.read() }.runOnQueue(Self.queue)
  }

  static var readStatusFunction: AnyDefinition {
    AsyncFunction("readStatus") { () -> String? in Self.readStatus() }.runOnQueue(Self.queue)
  }

  static var writeStatusFunction: AnyDefinition {
    AsyncFunction("writeStatus") { (json: String) throws in try Self.writeStatus(json) }.runOnQueue(Self.queue)
  }
}

extension UserScriptsNative where Self: Module {
  func sendOnChange(_ payload: [String: Any?]) { sendEvent("onChange", payload) }
}

protocol ConfigNative {
  static func readFile(_ name: String) -> [String: Any]
  func watch(_ names: [String], _ promise: Promise)
  static func writeSchemas(_ files: [String: String]) throws -> [String]
}

extension ConfigNative {
  static var moduleName: String { "ArdiaConfig" }

  static var eventsDefinition: AnyDefinition {
    Events("onChange")
  }

  static var readFileFunction: AnyDefinition {
    Function("readFile") { (name: String) -> [String: Any] in Self.readFile(name) }
  }

  static var writeSchemasFunction: AnyDefinition {
    AsyncFunction("writeSchemas") { (files: [String: String]) throws -> [String] in try Self.writeSchemas(files) }.runOnQueue(DispatchQueue.global(qos: .utility))
  }
}

extension ConfigNative where Self: Module {
  func sendOnChange(_ payload: [String: Any?]) { sendEvent("onChange", payload) }

  var watchFunction: AnyDefinition {
    AsyncFunction("watch") { [weak self] (names: [String], promise: Promise) in if let self { self.watch(names, promise) } else { promise.resolve(nil) } }
  }
}

protocol AutomationNative {
  static func start(_ promise: Promise)
  static func stop(_ promise: Promise)
  static func reply(_ connection: Int, _ line: String, _ ticket: Int)
  static func cutOff() -> Bool
  static func broadcast(_ connections: [Int], _ line: String)
  static func devtoolsEndpoint(_ connection: Int, _ promise: Promise)
  static func answerPeer(_ ask: Int, _ outcome: String, _ promise: Promise)
  static func approvals(_ promise: Promise)
  static func revokeApproval(_ key: String, _ promise: Promise)
  static func armFiles(_ spec: [String: Any], _ promise: Promise)
  static func disarmFiles(_ ids: [String]?, _ purge: Bool) -> Double
  static func fileArms() -> [[String: Any]]
  static func claimArmedDownload(_ arm: String, _ download: String, _ path: String) -> [String: Any]
  static func placeArmedDownload(_ arm: String, _ download: String, _ path: String, _ promise: Promise)
  static func releaseArmedDownload(_ arm: String, _ download: String, _ state: String) -> Bool
}

extension AutomationNative {
  static var moduleName: String { "ArdiaAutomation" }

  static var eventsDefinition: AnyDefinition {
    Events("onRequest", "onClose", "onWritten", "onPeerAsk", "onPeerAskEnded")
  }

  static var startFunction: AnyDefinition {
    AsyncFunction("start") { (promise: Promise) in Self.start(promise) }
  }

  static var stopFunction: AnyDefinition {
    AsyncFunction("stop") { (promise: Promise) in Self.stop(promise) }
  }

  static var replyFunction: AnyDefinition {
    Function("reply") { (connection: Int, line: String, ticket: Int) in Self.reply(connection, line, ticket) }
  }

  static var cutOffFunction: AnyDefinition {
    Function("cutOff") { () -> Bool in Self.cutOff() }
  }

  static var broadcastFunction: AnyDefinition {
    Function("broadcast") { (connections: [Int], line: String) in Self.broadcast(connections, line) }
  }

  static var devtoolsEndpointFunction: AnyDefinition {
    AsyncFunction("devtoolsEndpoint") { (connection: Int, promise: Promise) in Self.devtoolsEndpoint(connection, promise) }
  }

  static var answerPeerFunction: AnyDefinition {
    AsyncFunction("answerPeer") { (ask: Int, outcome: String, promise: Promise) in Self.answerPeer(ask, outcome, promise) }
  }

  static var approvalsFunction: AnyDefinition {
    AsyncFunction("approvals") { (promise: Promise) in Self.approvals(promise) }
  }

  static var revokeApprovalFunction: AnyDefinition {
    AsyncFunction("revokeApproval") { (key: String, promise: Promise) in Self.revokeApproval(key, promise) }
  }

  static var armFilesFunction: AnyDefinition {
    AsyncFunction("armFiles") { (spec: [String: Any], promise: Promise) in Self.armFiles(spec, promise) }
  }

  static var disarmFilesFunction: AnyDefinition {
    Function("disarmFiles") { (ids: [String]?, purge: Bool) -> Double in Self.disarmFiles(ids, purge) }
  }

  static var fileArmsFunction: AnyDefinition {
    AsyncFunction("fileArms") { () -> [[String: Any]] in Self.fileArms() }.runOnQueue(DispatchQueue.global(qos: .userInitiated))
  }

  static var claimArmedDownloadFunction: AnyDefinition {
    Function("claimArmedDownload") { (arm: String, download: String, path: String) -> [String: Any] in Self.claimArmedDownload(arm, download, path) }
  }

  static var placeArmedDownloadFunction: AnyDefinition {
    AsyncFunction("placeArmedDownload") { (arm: String, download: String, path: String, promise: Promise) in Self.placeArmedDownload(arm, download, path, promise) }
  }

  static var releaseArmedDownloadFunction: AnyDefinition {
    Function("releaseArmedDownload") { (arm: String, download: String, state: String) -> Bool in Self.releaseArmedDownload(arm, download, state) }
  }
}

extension AutomationNative where Self: Module {
  func sendOnRequest(_ payload: [String: Any?]) { sendEvent("onRequest", payload) }
  func sendOnClose(_ payload: [String: Any?]) { sendEvent("onClose", payload) }
  func sendOnWritten(_ payload: [String: Any?]) { sendEvent("onWritten", payload) }
  func sendOnPeerAsk(_ payload: [String: Any?]) { sendEvent("onPeerAsk", payload) }
  func sendOnPeerAskEnded(_ payload: [String: Any?]) { sendEvent("onPeerAskEnded", payload) }
}

protocol PluginsNative {
  static var queue: DispatchQueue { get }
  static func folder() -> String
  static func list() -> [[String: Any]]
  static func start(_ spec: [String: Any], _ promise: Promise)
  static func stop(_ name: String, _ run: Int, _ graceMs: Int, _ promise: Promise)
  static func reply(_ name: String, _ run: Int, _ line: String)
  static func event(_ name: String, _ run: Int, _ line: String)
  static func call(_ name: String, _ run: Int, _ line: String)
  static func linkPrograms(_ spec: [String: Any], _ promise: Promise)
  static func takeAfterUpdateQuitStops(_ promise: Promise)
  static func setAfterUpdateQuitConsent(_ consent: String)
  static func legacyProgramsInstalled(_ promise: Promise)
  static func programRegistry(_ promise: Promise)
  static func sweepPrograms(_ active: [String], _ promise: Promise)
  static func unlinkPrograms(_ name: String, _ programs: [String], _ remove: Bool, _ promise: Promise)
  static func officialPlugins() -> [[String: Any]]?
  static func fetchOfficial(_ name: String, _ promise: Promise)
  static func cancelOfficialFetch(_ name: String)
  static func promoteOfficial(_ name: String, _ folderId: String, _ approved: String) -> [String: Any]
  static func hostFetch(_ spec: [String: Any], _ promise: Promise)
  static func storageRead(_ name: String) -> [String: Any]
  static func storageWrite(_ name: String, _ text: String) -> [String: Any]
  static func readPluginFile(_ name: String, _ folderId: String, _ approved: String, _ path: String) -> [String: Any]
  static func remove(_ name: String, _ official: Bool, _ folderId: String?, _ promise: Promise)
  static func revealLog(_ name: String)
  static func revealFolder()
  static func devSnapshotPage(_ name: String, _ path: String, _ promise: Promise)
}

extension PluginsNative {
  static var moduleName: String { "ArdiaPlugins" }

  static var eventsDefinition: AnyDefinition {
    Events("onLine", "onExit", "onOfficialFetch")
  }

  static var folderFunction: AnyDefinition {
    Function("folder") { () -> String in Self.folder() }
  }

  static var listFunction: AnyDefinition {
    AsyncFunction("list") { () -> [[String: Any]] in Self.list() }.runOnQueue(DispatchQueue.global(qos: .utility))
  }

  static var startFunction: AnyDefinition {
    AsyncFunction("start") { (spec: [String: Any], promise: Promise) in Self.start(spec, promise) }
  }

  static var stopFunction: AnyDefinition {
    AsyncFunction("stop") { (name: String, run: Int, graceMs: Int, promise: Promise) in Self.stop(name, run, graceMs, promise) }
  }

  static var replyFunction: AnyDefinition {
    Function("reply") { (name: String, run: Int, line: String) in Self.reply(name, run, line) }
  }

  static var eventFunction: AnyDefinition {
    Function("event") { (name: String, run: Int, line: String) in Self.event(name, run, line) }
  }

  static var callFunction: AnyDefinition {
    Function("call") { (name: String, run: Int, line: String) in Self.call(name, run, line) }
  }

  static var linkProgramsFunction: AnyDefinition {
    AsyncFunction("linkPrograms") { (spec: [String: Any], promise: Promise) in Self.linkPrograms(spec, promise) }
  }

  static var takeAfterUpdateQuitStopsFunction: AnyDefinition {
    AsyncFunction("takeAfterUpdateQuitStops") { (promise: Promise) in Self.takeAfterUpdateQuitStops(promise) }
  }

  static var setAfterUpdateQuitConsentFunction: AnyDefinition {
    Function("setAfterUpdateQuitConsent") { (consent: String) in Self.setAfterUpdateQuitConsent(consent) }
  }

  static var legacyProgramsInstalledFunction: AnyDefinition {
    AsyncFunction("legacyProgramsInstalled") { (promise: Promise) in Self.legacyProgramsInstalled(promise) }
  }

  static var programRegistryFunction: AnyDefinition {
    AsyncFunction("programRegistry") { (promise: Promise) in Self.programRegistry(promise) }
  }

  static var sweepProgramsFunction: AnyDefinition {
    AsyncFunction("sweepPrograms") { (active: [String], promise: Promise) in Self.sweepPrograms(active, promise) }
  }

  static var unlinkProgramsFunction: AnyDefinition {
    AsyncFunction("unlinkPrograms") { (name: String, programs: [String], remove: Bool, promise: Promise) in Self.unlinkPrograms(name, programs, remove, promise) }
  }

  static var officialPluginsFunction: AnyDefinition {
    AsyncFunction("officialPlugins") { () -> [[String: Any]]? in Self.officialPlugins() }.runOnQueue(DispatchQueue.global(qos: .utility))
  }

  static var fetchOfficialFunction: AnyDefinition {
    AsyncFunction("fetchOfficial") { (name: String, promise: Promise) in Self.fetchOfficial(name, promise) }
  }

  static var cancelOfficialFetchFunction: AnyDefinition {
    Function("cancelOfficialFetch") { (name: String) in Self.cancelOfficialFetch(name) }
  }

  static var promoteOfficialFunction: AnyDefinition {
    AsyncFunction("promoteOfficial") { (name: String, folderId: String, approved: String) -> [String: Any] in Self.promoteOfficial(name, folderId, approved) }.runOnQueue(DispatchQueue.global(qos: .userInitiated))
  }

  static var hostFetchFunction: AnyDefinition {
    AsyncFunction("hostFetch") { (spec: [String: Any], promise: Promise) in Self.hostFetch(spec, promise) }
  }

  static var storageReadFunction: AnyDefinition {
    AsyncFunction("storageRead") { (name: String) -> [String: Any] in Self.storageRead(name) }.runOnQueue(Self.queue)
  }

  static var storageWriteFunction: AnyDefinition {
    AsyncFunction("storageWrite") { (name: String, text: String) -> [String: Any] in Self.storageWrite(name, text) }.runOnQueue(Self.queue)
  }

  static var readPluginFileFunction: AnyDefinition {
    AsyncFunction("readPluginFile") { (name: String, folderId: String, approved: String, path: String) -> [String: Any] in Self.readPluginFile(name, folderId, approved, path) }.runOnQueue(DispatchQueue.global(qos: .userInitiated))
  }

  static var removeFunction: AnyDefinition {
    AsyncFunction("remove") { (name: String, official: Bool, folderId: String?, promise: Promise) in Self.remove(name, official, folderId, promise) }.runOnQueue(.main)
  }

  static var revealLogFunction: AnyDefinition {
    Function("revealLog") { (name: String) in Self.revealLog(name) }
  }

  static var revealFolderFunction: AnyDefinition {
    Function("revealFolder") { () in Self.revealFolder() }
  }

  static var devSnapshotPageFunction: AnyDefinition {
    AsyncFunction("devSnapshotPage") { (name: String, path: String, promise: Promise) in Self.devSnapshotPage(name, path, promise) }.runOnQueue(.main)
  }
}

extension PluginsNative where Self: Module {
  func sendOnLine(_ payload: [String: Any?]) { sendEvent("onLine", payload) }
  func sendOnExit(_ payload: [String: Any?]) { sendEvent("onExit", payload) }
  func sendOnOfficialFetch(_ payload: [String: Any?]) { sendEvent("onOfficialFetch", payload) }
}

protocol SystemSignalsNative {
  func watchIdle(_ thresholds: [Double])
  static func holdsIncomingLinks() -> Bool
  static func setHoldIncomingLinks(_ hold: Bool, _ hooksStamp: String?)
  static func setApprovedDownloadFolders(_ folders: [String])
  static func moveCompletedDownload(_ path: String, _ folder: String) -> [String: Any]
  static func devPost(_ name: String) -> Bool
}

extension SystemSignalsNative {
  static var moduleName: String { "ArdiaSystemSignals" }

  static var eventsDefinition: AnyDefinition {
    Events("onSystemSignal")
  }

  static var holdsIncomingLinksFunction: AnyDefinition {
    Function("holdsIncomingLinks") { () -> Bool in Self.holdsIncomingLinks() }
  }

  static var setHoldIncomingLinksFunction: AnyDefinition {
    Function("setHoldIncomingLinks") { (hold: Bool, hooksStamp: String?) in Self.setHoldIncomingLinks(hold, hooksStamp) }
  }

  static var setApprovedDownloadFoldersFunction: AnyDefinition {
    Function("setApprovedDownloadFolders") { (folders: [String]) in Self.setApprovedDownloadFolders(folders) }
  }

  static var moveCompletedDownloadFunction: AnyDefinition {
    AsyncFunction("moveCompletedDownload") { (path: String, folder: String) -> [String: Any] in Self.moveCompletedDownload(path, folder) }.runOnQueue(DispatchQueue.global(qos: .userInitiated))
  }

  static var devPostFunction: AnyDefinition {
    AsyncFunction("devPost") { (name: String) -> Bool in Self.devPost(name) }.runOnQueue(.main)
  }
}

extension SystemSignalsNative where Self: Module {
  func sendOnSystemSignal(_ payload: [String: Any?]) { sendEvent("onSystemSignal", payload) }

  var watchIdleFunction: AnyDefinition {
    Function("watchIdle") { (thresholds: [Double]) in self.watchIdle(thresholds) }
  }
}

protocol ReportNative {
  static func draftDirectory() -> String
  static func fileSize(_ path: String) -> Int
  static func removeFile(_ path: String)
  func startRecording(_ windowId: String, _ includePages: Bool, _ path: String, _ maxSeconds: Double?, _ fps: Double?, _ maxPixelWidth: Double?) -> Bool
  func stopRecording() -> Bool
  func cancelRecording()
  func isRecording() -> Bool
  static func recordingThumbnail(_ path: String, _ out: String) -> Bool
  static func gzipFile(_ source: String, _ destination: String, _ removeSource: Bool) throws -> Int
  static func gzipText(_ text: String, _ destination: String) throws -> Int
  func upload(_ id: String, _ url: String, _ method: String, _ headers: [String: String], _ path: String, _ promise: Promise)
  func cancelUploads()
  static func devRenderCost(_ windowId: String) -> [[String: Any]]
  func devSnapshotPill(_ path: String) -> [String: Double]?
  static func devRecordingPages(_ windowId: String) -> [[String: Any]]
  static func devPlaceWindow(_ windowId: String, _ frame: [Double]) -> Bool
  func devWindowServerAlpha(_ windowNumber: Int, _ alpha: Double) -> Bool
  static func devPages(_ windowId: String) -> [[String: Any]]
}

extension ReportNative {
  static var moduleName: String { "ArdiaReport" }

  static var eventsDefinition: AnyDefinition {
    Events("onReport")
  }

  static var draftDirectoryFunction: AnyDefinition {
    Function("draftDirectory") { () -> String in Self.draftDirectory() }
  }

  static var fileSizeFunction: AnyDefinition {
    Function("fileSize") { (path: String) -> Int in Self.fileSize(path) }
  }

  static var removeFileFunction: AnyDefinition {
    Function("removeFile") { (path: String) in Self.removeFile(path) }
  }

  static var recordingThumbnailFunction: AnyDefinition {
    AsyncFunction("recordingThumbnail") { (path: String, out: String) -> Bool in Self.recordingThumbnail(path, out) }.runOnQueue(DispatchQueue.global(qos: .userInitiated))
  }

  static var gzipFileFunction: AnyDefinition {
    AsyncFunction("gzipFile") { (source: String, destination: String, removeSource: Bool) throws -> Int in try Self.gzipFile(source, destination, removeSource) }.runOnQueue(DispatchQueue.global(qos: .utility))
  }

  static var gzipTextFunction: AnyDefinition {
    AsyncFunction("gzipText") { (text: String, destination: String) throws -> Int in try Self.gzipText(text, destination) }.runOnQueue(DispatchQueue.global(qos: .utility))
  }

  static var devRenderCostFunction: AnyDefinition {
    AsyncFunction("devRenderCost") { (windowId: String) -> [[String: Any]] in Self.devRenderCost(windowId) }.runOnQueue(.main)
  }

  static var devRecordingPagesFunction: AnyDefinition {
    AsyncFunction("devRecordingPages") { (windowId: String) -> [[String: Any]] in Self.devRecordingPages(windowId) }.runOnQueue(.main)
  }

  static var devPlaceWindowFunction: AnyDefinition {
    AsyncFunction("devPlaceWindow") { (windowId: String, frame: [Double]) -> Bool in Self.devPlaceWindow(windowId, frame) }.runOnQueue(.main)
  }

  static var devPagesFunction: AnyDefinition {
    AsyncFunction("devPages") { (windowId: String) -> [[String: Any]] in Self.devPages(windowId) }.runOnQueue(.main)
  }
}

extension ReportNative where Self: Module {
  func sendOnReport(_ payload: [String: Any?]) { sendEvent("onReport", payload) }

  var startRecordingFunction: AnyDefinition {
    AsyncFunction("startRecording") { (windowId: String, includePages: Bool, path: String, maxSeconds: Double?, fps: Double?, maxPixelWidth: Double?) -> Bool in self.startRecording(windowId, includePages, path, maxSeconds, fps, maxPixelWidth) }.runOnQueue(.main)
  }

  var stopRecordingFunction: AnyDefinition {
    AsyncFunction("stopRecording") { () -> Bool in self.stopRecording() }.runOnQueue(.main)
  }

  var cancelRecordingFunction: AnyDefinition {
    AsyncFunction("cancelRecording") { () in self.cancelRecording() }.runOnQueue(.main)
  }

  var isRecordingFunction: AnyDefinition {
    Function("isRecording") { () -> Bool in self.isRecording() }
  }

  var uploadFunction: AnyDefinition {
    AsyncFunction("upload") { (id: String, url: String, method: String, headers: [String: String], path: String, promise: Promise) in self.upload(id, url, method, headers, path, promise) }
  }

  var cancelUploadsFunction: AnyDefinition {
    Function("cancelUploads") { () in self.cancelUploads() }
  }

  var devSnapshotPillFunction: AnyDefinition {
    AsyncFunction("devSnapshotPill") { (path: String) -> [String: Double]? in self.devSnapshotPill(path) }.runOnQueue(.main)
  }

  var devWindowServerAlphaFunction: AnyDefinition {
    AsyncFunction("devWindowServerAlpha") { (windowNumber: Int, alpha: Double) -> Bool in self.devWindowServerAlpha(windowNumber, alpha) }.runOnQueue(.main)
  }
}

protocol TelemetryLocalNative {
  static func append(_ day: String, _ text: String)
  static func appendNow(_ day: String, _ text: String)
  static func configure(_ maxBytes: Int, _ keepDays: Int)
  static func prune(_ now: Double, _ promise: Promise)
  static func clear(_ promise: Promise)
  static func exportForReport(_ since: Double, _ promise: Promise)
  static func exportToDownloads(_ now: Double, _ promise: Promise)
}

extension TelemetryLocalNative {
  static var moduleName: String { "ArdiaTelemetryLocal" }

  static var appendFunction: AnyDefinition {
    Function("append") { (day: String, text: String) in Self.append(day, text) }
  }

  static var appendNowFunction: AnyDefinition {
    Function("appendNow") { (day: String, text: String) in Self.appendNow(day, text) }
  }

  static var configureFunction: AnyDefinition {
    Function("configure") { (maxBytes: Int, keepDays: Int) in Self.configure(maxBytes, keepDays) }
  }

  static var pruneFunction: AnyDefinition {
    AsyncFunction("prune") { (now: Double, promise: Promise) in Self.prune(now, promise) }
  }

  static var clearFunction: AnyDefinition {
    AsyncFunction("clear") { (promise: Promise) in Self.clear(promise) }
  }

  static var exportForReportFunction: AnyDefinition {
    AsyncFunction("exportForReport") { (since: Double, promise: Promise) in Self.exportForReport(since, promise) }
  }

  static var exportToDownloadsFunction: AnyDefinition {
    AsyncFunction("exportToDownloads") { (now: Double, promise: Promise) in Self.exportToDownloads(now, promise) }
  }
}

protocol FieldGlowNative {
  static func show(_ id: String, _ timings: [Double])
  static func progress(_ id: String, _ progress: Double, _ still: Bool)
  static func pulse(_ id: String, _ period: Double, _ low: Double)
  static func finish(_ id: String, _ still: Bool)
  static func reset(_ id: String)
}

extension FieldGlowNative {
  static var moduleName: String { "ArdiaFieldGlow" }

  static var showFunction: AnyDefinition {
    Function("show") { (id: String, timings: [Double]) in Self.show(id, timings) }
  }

  static var progressFunction: AnyDefinition {
    Function("progress") { (id: String, progress: Double, still: Bool) in Self.progress(id, progress, still) }
  }

  static var pulseFunction: AnyDefinition {
    Function("pulse") { (id: String, period: Double, low: Double) in Self.pulse(id, period, low) }
  }

  static var finishFunction: AnyDefinition {
    Function("finish") { (id: String, still: Bool) in Self.finish(id, still) }
  }

  static var resetFunction: AnyDefinition {
    Function("reset") { (id: String) in Self.reset(id) }
  }
}
