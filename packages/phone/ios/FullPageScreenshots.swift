import ArdiaBrowser
import CoreGraphics
import UIKit
import WebKit

@MainActor
final class FullPageScreenshots: NSObject {
  static let shared = FullPageScreenshots()
  static let providedEvent = "pages.fullPagePdf"
  private static var sceneDelegateKey: UInt8 = 0

  struct Provided {
    let data: Data
    let pageIndex: Int
    let visibleRect: CGRect
    let pageCount: Int
    let pageSize: CGSize
  }

  private var watchingScenes = false

  func install() {
    if !watchingScenes {
      watchingScenes = true
      for name in [UIScene.willEnterForegroundNotification, UIScene.didActivateNotification] {
        NotificationCenter.default.addObserver(self, selector: #selector(sceneChanged(_:)), name: name, object: nil)
      }
      NotificationCenter.default.addObserver(self, selector: #selector(sceneDisconnected(_:)), name: UIScene.didDisconnectNotification, object: nil)
      if PhoneTestBuild.isOn { FullPageProbe.listen() }
    }
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.forEach(adopt)
  }

  @objc private func sceneChanged(_ note: Notification) {
    guard let scene = note.object as? UIWindowScene else { return }
    adopt(scene)
  }

  @objc private func sceneDisconnected(_ note: Notification) {
    guard let scene = note.object as? UIWindowScene else { return }
    if let service = scene.screenshotService, service.delegate is FullPageSceneDelegate { service.delegate = nil }
    objc_setAssociatedObject(scene, &Self.sceneDelegateKey, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
  }

  private func adopt(_ scene: UIWindowScene) {
    guard let service = scene.screenshotService, (service.delegate as? FullPageSceneDelegate)?.scene !== scene else { return }
    let delegate = FullPageSceneDelegate(scene: scene)
    objc_setAssociatedObject(scene, &Self.sceneDelegateKey, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    service.delegate = delegate
  }

  func isDelegate(of scene: UIWindowScene) -> Bool { (scene.screenshotService?.delegate as? FullPageSceneDelegate)?.scene === scene }

  static func provide(in scene: UIWindowScene?) async -> Provided? {
    let target = FullPageTarget.find(in: scene)
    guard case .shown(let before) = target else {
      if PhoneTestBuild.isOn, case .refused(let reason) = target { NSLog("PAGELAB fullpage none: %@", reason) }
      return nil
    }
    let webView = before.webView
    if PhoneTestBuild.isOn { NSLog("PAGELAB fullpage rendering %@ offset %.0f", webView.url?.absoluteString ?? "-", webView.scrollView.contentOffset.y) }
    guard let data = try? await webView.pdf(configuration: WKPDFConfiguration()) else {
      if PhoneTestBuild.isOn { NSLog("PAGELAB fullpage none: WebKit made no PDF") }
      return nil
    }
    let settled = FullPageTarget.find(in: scene)
    guard case .shown(let after) = settled else {
      if PhoneTestBuild.isOn, case .refused(let reason) = settled { NSLog("PAGELAB fullpage none: while the PDF rendered, %@", reason) }
      return nil
    }
    guard after.document == before.document else {
      if PhoneTestBuild.isOn { NSLog("PAGELAB fullpage none: while the PDF rendered, the page changed (%@)", before.document.change(to: after.document)) }
      return nil
    }
    guard let placed = place(FullPageTarget.visibleContent(of: after.webView), content: after.webView.scrollView.contentSize, in: data) else {
      if PhoneTestBuild.isOn { NSLog("PAGELAB fullpage none: the PDF has no page") }
      return nil
    }
    PhonePages.shared.pageSink?(["name": providedEvent])
    return placed
  }

  static func place(_ seen: CGRect, content: CGSize, in data: Data) -> Provided? {
    let pages = pageBoxes(of: data)
    guard content.width > 0 else { return nil }
    guard let first = pages.first, first.width > 0 else { return nil }
    let scale = first.width / content.width
    var top = seen.minY * scale
    var index = 0
    while index < pages.count - 1, top >= pages[index].height {
      top -= pages[index].height
      index += 1
    }
    let page = pages[index]
    let height = min(seen.height * scale, page.height - top)
    let rect = CGRect(x: page.minX + seen.minX * scale, y: page.maxY - top - height, width: min(seen.width * scale, page.width), height: max(height, 0))
    return Provided(data: data, pageIndex: index, visibleRect: rect, pageCount: pages.count, pageSize: first.size)
  }

  nonisolated static func pageBoxes(of data: Data) -> [CGRect] {
    guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), document.numberOfPages > 0 else { return [] }
    return (1...document.numberOfPages).compactMap { document.page(at: $0)?.getBoxRect(.mediaBox) }
  }
}

@MainActor
final class FullPageSceneDelegate: NSObject, UIScreenshotServiceDelegate {
  weak var scene: UIWindowScene?

  init(scene: UIWindowScene) {
    self.scene = scene
  }

  func screenshotService(_ screenshotService: UIScreenshotService, generatePDFRepresentationWithCompletion completionHandler: @escaping (Data?, Int, CGRect) -> Void) {
    if PhoneTestBuild.isOn { NSLog("PAGELAB fullpage asked for a PDF") }
    Task { @MainActor [weak self] in
      let provided = await FullPageScreenshots.provide(in: self?.scene)
      completionHandler(provided?.data, provided?.pageIndex ?? 0, provided?.visibleRect ?? .zero)
    }
  }
}

@MainActor
enum FullPageTarget {
  enum Found {
    case shown(Shown)
    case refused(String)
  }

  struct Shown {
    let webView: WKWebView
    let document: Document
  }

  struct Document: Equatable {
    let webView: ObjectIdentifier
    let tab: UUID
    let navigation: Int
    let url: URL?
    let contentWidth: CGFloat

    func change(to other: Document) -> String {
      if webView != other.webView || tab != other.tab { return "another tab" }
      if navigation != other.navigation || url != other.url { return "navigated" }
      return "relaid out"
    }
  }

  static let coveredShare: CGFloat = 0.5

  static func find(in scene: UIWindowScene?) -> Found {
    guard let scene else { return .refused("no scene") }
    guard let window = scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first(where: { $0.rootViewController != nil }) else { return .refused("no window") }
    guard let root = window.rootViewController else { return .refused("no root") }
    if let presented = root.presentedViewController, !presented.isBeingDismissed { return .refused("a screen is presented over the page") }
    let center = CGPoint(x: window.bounds.midX, y: window.bounds.midY)
    guard let hit = window.hitTest(center, with: nil) else { return .refused("nothing at the centre") }
    guard let host = pageView(holding: hit) else { return .refused("no page at the centre") }
    guard let page = host.page, let webView = host.hostedWebView, webView.superview === host else { return .refused("no live page") }
    if host.isPrivate || page.isPrivate || PhonePages.shared.engine.tabs.isPrivate(page.id) { return .refused("private tab") }
    guard let address = webView.url?.absoluteString, BrowserURL.isSyncable(address) else { return .refused("not an http(s) page") }
    if host.summaryStage != nil || host.leaving != nil || host.summarySession != nil { return .refused("a summary is over the page") }
    guard PageSnapshots.isOnScreen(webView) else { return .refused("page hidden") }
    let frame = webView.convert(webView.bounds, to: window)
    guard abs(frame.width - webView.bounds.width) < 0.5, abs(frame.height - webView.bounds.height) < 0.5 else { return .refused("page scaled") }
    let shown = frame.intersection(window.bounds)
    guard shown.width >= window.bounds.width * coveredShare, shown.height >= window.bounds.height * coveredShare else { return .refused("page not filling the window") }
    let document = Document(webView: ObjectIdentifier(webView), tab: page.id, navigation: page.navigationGeneration, url: webView.url, contentWidth: webView.scrollView.contentSize.width)
    return .shown(Shown(webView: webView, document: document))
  }

  static func pageView(holding view: UIView) -> PageView? {
    var current: UIView? = view
    while let candidate = current {
      if let host = candidate as? PageView { return host }
      current = candidate.superview
    }
    return nil
  }

  static func visibleContent(of webView: WKWebView) -> CGRect {
    let scroll = webView.scrollView
    let content = CGRect(origin: .zero, size: scroll.contentSize)
    let seen = CGRect(origin: scroll.contentOffset, size: scroll.bounds.size).intersection(content)
    return seen.isNull ? .zero : seen
  }
}

@MainActor
enum FullPageProbe {
  static let notification = "com.ardia.browser.ios.lab.fullPage"
  static let disturbances = ["navigate", "scroll", "sheet"]
  private static var probes = 0

  static var folder: URL { URL.documentsDirectory.appending(path: "FullPageProbe", directoryHint: .isDirectory) }

  static func listen() {
    for name in [notification] + disturbances.map({ "\(notification).\($0)" }) {
      CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, name, _, _ in
        let posted = name.map { $0.rawValue as String } ?? ""
        DispatchQueue.main.async { MainActor.assumeIsolated { FullPageProbe.run(posted) } }
      }, name as CFString, nil, .deliverImmediately)
    }
    NSLog("PAGELAB fullpage probe listening for %@ and .%@", notification, disturbances.joined(separator: ", ."))
  }

  static func run(_ posted: String) {
    probes += 1
    let probe = probes
    let disturbance = disturbances.first { posted == "\(notification).\($0)" }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first, let service = scene.screenshotService else {
      NSLog("PAGELAB fullpage probe %d: no scene with a screenshot service", probe)
      return
    }
    let installed = FullPageScreenshots.shared.isDelegate(of: scene)
    guard let delegate = service.delegate else {
      NSLog("PAGELAB fullpage probe %d: the scene's screenshot service has no delegate", probe)
      return
    }
    var webView: WKWebView?
    if case .shown(let shown) = FullPageTarget.find(in: scene) { webView = shown.webView }
    delegate.screenshotService?(service, generatePDFRepresentationWithCompletion: { data, index, rect in
      MainActor.assumeIsolated { record(probe, installed: installed, data: data, index: index, rect: rect, webView: webView) }
    })
    if let disturbance { Task { @MainActor in disturb(disturbance, probe: probe, scene: scene, webView: webView) } }
  }

  private static func disturb(_ disturbance: String, probe: Int, scene: UIWindowScene, webView: WKWebView?) {
    switch disturbance {
    case "navigate":
      webView?.load(URLRequest(url: URL(string: "https://en.wikipedia.org/wiki/Beacon")!))
    case "scroll":
      if let scroll = webView?.scrollView { scroll.contentOffset.y += 600 }
    default:
      let sheet = UIViewController()
      sheet.view.backgroundColor = .systemBackground
      guard var top = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
      while let presented = top.presentedViewController { top = presented }
      top.present(sheet, animated: false)
      Task { @MainActor in
        try? await Task.sleep(for: .seconds(2))
        sheet.dismiss(animated: false)
      }
    }
    NSLog("PAGELAB fullpage probe %d: %@ while the PDF renders, now %@ offset %.0f", probe, disturbance, webView?.url?.absoluteString ?? "-", webView?.scrollView.contentOffset.y ?? 0)
  }

  private static func record(_ probe: Int, installed: Bool, data: Data?, index: Int, rect: CGRect, webView: WKWebView?) {
    let now = String(format: "page now %@ offset %.0f", webView?.url?.absoluteString ?? "-", webView?.scrollView.contentOffset.y ?? 0)
    guard let data else {
      NSLog("PAGELAB fullpage probe %d: delegate installed %@, answered nil; %@", probe, installed ? "yes" : "no", now)
      return
    }
    let file = folder.appending(path: "probe-\(probe).pdf")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let written = (try? data.write(to: file, options: .atomic)) != nil
    let pages = FullPageScreenshots.pageBoxes(of: data)
    let size = pages.first?.size ?? .zero
    NSLog("PAGELAB fullpage probe %d: delegate installed %@, answered %d bytes, %d pages of %.0fx%.0f, page %d rect %.0f,%.0f %.0fx%.0f (top %.0f); %@; %@ %@", probe, installed ? "yes" : "no", data.count, pages.count, size.width, size.height, index, rect.minX, rect.minY, rect.width, rect.height, size.height - rect.maxY, now, written ? "written to" : "not written to", file.path(percentEncoded: false))
  }
}
