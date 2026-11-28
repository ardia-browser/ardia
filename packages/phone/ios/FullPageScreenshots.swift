import ArdiaBrowser
import CoreGraphics
import UIKit
import WebKit

@MainActor
final class FullPageScreenshots: NSObject, UIScreenshotServiceDelegate {
  static let shared = FullPageScreenshots()
  static let providedEvent = "pages.fullPagePdf"

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
      if PhoneTestBuild.isOn { FullPageProbe.listen() }
    }
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.forEach(adopt)
  }

  @objc private func sceneChanged(_ note: Notification) {
    guard let scene = note.object as? UIWindowScene else { return }
    adopt(scene)
  }

  private func adopt(_ scene: UIWindowScene) {
    guard let service = scene.screenshotService, service.delegate !== self else { return }
    service.delegate = self
  }

  func isDelegate(of scene: UIWindowScene) -> Bool { scene.screenshotService?.delegate === self }

  func screenshotService(_ screenshotService: UIScreenshotService, generatePDFRepresentationWithCompletion completionHandler: @escaping (Data?, Int, CGRect) -> Void) {
    if PhoneTestBuild.isOn { NSLog("PAGELAB fullpage asked for a PDF") }
    Task { @MainActor in
      let provided = await self.provide(in: screenshotService.windowScene)
      completionHandler(provided?.data, provided?.pageIndex ?? 0, provided?.visibleRect ?? .zero)
    }
  }

  func provide(in scene: UIWindowScene?) async -> Provided? {
    let target = FullPageTarget.find(in: scene)
    guard case .shown(let webView) = target else {
      if PhoneTestBuild.isOn, case .refused(let reason) = target { NSLog("PAGELAB fullpage none: %@", reason) }
      return nil
    }
    let seen = FullPageTarget.visibleContent(of: webView)
    let content = webView.scrollView.contentSize
    guard let data = try? await webView.pdf(configuration: WKPDFConfiguration()), let placed = Self.place(seen, content: content, in: data) else {
      if PhoneTestBuild.isOn { NSLog("PAGELAB fullpage none: WebKit made no PDF") }
      return nil
    }
    PhonePages.shared.pageSink?(["name": Self.providedEvent])
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
enum FullPageTarget {
  enum Found {
    case shown(WKWebView)
    case refused(String)
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
    return .shown(webView)
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
  private static var probes = 0

  static var folder: URL { URL.documentsDirectory.appending(path: "FullPageProbe", directoryHint: .isDirectory) }

  static func listen() {
    CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { FullPageProbe.run() } }
    }, notification as CFString, nil, .deliverImmediately)
    NSLog("PAGELAB fullpage probe listening for %@", notification)
  }

  static func run() {
    probes += 1
    let probe = probes
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
    delegate.screenshotService?(service, generatePDFRepresentationWithCompletion: { data, index, rect in
      MainActor.assumeIsolated { record(probe, installed: installed, data: data, index: index, rect: rect) }
    })
  }

  private static func record(_ probe: Int, installed: Bool, data: Data?, index: Int, rect: CGRect) {
    guard let data else {
      NSLog("PAGELAB fullpage probe %d: delegate installed %@, answered nil", probe, installed ? "yes" : "no")
      return
    }
    let file = folder.appending(path: "probe-\(probe).pdf")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let written = (try? data.write(to: file, options: .atomic)) != nil
    let pages = FullPageScreenshots.pageBoxes(of: data)
    let size = pages.first?.size ?? .zero
    NSLog("PAGELAB fullpage probe %d: delegate installed %@, answered %d bytes, %d pages of %.0fx%.0f, page %d rect %.0f,%.0f %.0fx%.0f, %@ %@", probe, installed ? "yes" : "no", data.count, pages.count, size.width, size.height, index, rect.minX, rect.minY, rect.width, rect.height, written ? "written to" : "not written to", file.path(percentEncoded: false))
  }
}
