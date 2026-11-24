import ArdiaBrowser
import ExpoModulesCore
import QuartzCore
import UIKit
import WebKit

struct PageSetupRecord: Record {
  @Field var url: String? = nil
  @Field var title: String? = nil
  @Field var isPrivate: Bool = false
  @Field var savedState: String? = nil
}

struct SnapshotOptionsRecord: Record {
  @Field var maxWidth: Int? = nil
  @Field var quality: Int? = nil
  @Field var coveredInsets: [Double]? = nil
  @Field var quiet: Bool = false
}

struct RequestAnswerRecord: Record {
  @Field var type: String = ""
  @Field var text: String? = nil
  @Field var user: String? = nil
  @Field var password: String? = nil
}

public final class PageViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhonePageView")

    Constant("obscuresInsets") { true }

    Constant("reportsDrawn") { true }

    Events("onPageEngineEvent")

    OnCreate {
      onMain {
        PhonePages.shared.pageSink = { [weak self] event in self?.sendEvent("onPageEngineEvent", event) }
      }
    }

    OnDestroy {
      onMain { PhonePages.shared.pageSink = nil }
    }

    Function("capabilities") { () -> [String: Any] in
      [
        "engineName": "WebKit",
        "isDevelopmentOnly": false,
        "supportsPrivatePages": true,
        "pageZoomLevels": WebTab.zoomLevels,
        "pageZoomScalesTextOnly": false,
        "snapshotsIncludeVideo": false,
      ]
    }

    Function("appRelease") { () -> [String: Any?] in
      let info = Bundle.main.infoDictionary
      return [
        "releaseVersion": info?["ArdiaReleaseVersion"] as? String ?? "",
        "build": info?["CFBundleVersion"] as? String ?? "1",
        "receiptName": Bundle.main.appStoreReceiptURL?.lastPathComponent,
      ]
    }

    Function("launchOptions") { () -> [String: Any] in
      ["lab": PhoneTestBuild.isOn, "pageLab": PhoneTestBuild.flag("ArdiaPageLab"), "syncDemo": PhoneTestBuild.isDemo, "arguments": PhoneTestBuild.launchArguments]
    }

    AsyncFunction("openPage") { (pageID: String, setup: PageSetupRecord) in
      try MainActor.assumeIsolated {
        _ = try PhonePages.shared.open(pageID, url: setup.url, title: setup.title, isPrivate: setup.isPrivate, savedState: setup.savedState)
      }
    }.runOnQueue(.main)

    AsyncFunction("closePage") { (pageID: String) in
      MainActor.assumeIsolated { PhonePages.shared.close(pageID) }
    }.runOnQueue(.main)

    AsyncFunction("pageIds") { () -> [String] in
      MainActor.assumeIsolated { PhonePages.shared.pageIDList }
    }.runOnQueue(.main)

    AsyncFunction("pageState") { (pageID: String) -> [String: Any]? in
      MainActor.assumeIsolated { PhonePages.shared.page(pageID).map(PhonePages.shared.state) }
    }.runOnQueue(.main)

    AsyncFunction("load") { (pageID: String, url: String) in
      try MainActor.assumeIsolated {
        guard let target = URL(string: url) else { throw PagePayloads.badArgs("Not a URL: \(url)") }
        _ = try PhonePages.shared.require(pageID)
        PhonePages.shared.activate(pageID)?.load(target)
      }
    }.runOnQueue(.main)

    AsyncFunction("reload") { (pageID: String) in
      try MainActor.assumeIsolated { try PhonePages.shared.require(pageID).reload() }
    }.runOnQueue(.main)

    AsyncFunction("stopLoading") { (pageID: String) in
      try MainActor.assumeIsolated { try PhonePages.shared.require(pageID).stopLoading() }
    }.runOnQueue(.main)

    AsyncFunction("goBack") { (pageID: String) -> Bool in
      try MainActor.assumeIsolated {
        let page = try PhonePages.shared.require(pageID)
        guard page.canGoBack else { return false }
        page.goBack()
        return true
      }
    }.runOnQueue(.main)

    AsyncFunction("goForward") { (pageID: String) -> Bool in
      try MainActor.assumeIsolated {
        let page = try PhonePages.shared.require(pageID)
        guard page.canGoForward else { return false }
        page.goForward()
        return true
      }
    }.runOnQueue(.main)

    AsyncFunction("find") { (pageID: String, text: String, promise: Promise) in
      Self.main(promise) { try await PhonePages.shared.find(pageID).start(text) }
    }.runOnQueue(.main)

    AsyncFunction("findNext") { (pageID: String, promise: Promise) in
      Self.main(promise) { try await PhonePages.shared.find(pageID).step(backwards: false) }
    }.runOnQueue(.main)

    AsyncFunction("findPrevious") { (pageID: String, promise: Promise) in
      Self.main(promise) { try await PhonePages.shared.find(pageID).step(backwards: true) }
    }.runOnQueue(.main)

    AsyncFunction("endFind") { (pageID: String, promise: Promise) in
      Self.main(promise) {
        FindPresentation.cancel(for: pageID)
        await PhonePages.shared.endFind(pageID)
      }
    }.runOnQueue(.main)

    AsyncFunction("presentSystemFind") { (pageID: String, text: String?) -> Bool in
      MainActor.assumeIsolated {
        FindPresentation.current?.cancel()
        guard let page = PhonePages.shared.page(pageID), let webView = page.webView, let interaction = webView.findInteraction else { return false }
        if let text { interaction.searchText = text }
        page.presentFindInPage()
        if !interaction.isFindNavigatorVisible { FindPresentation(pageID: pageID, webView: webView, interaction: interaction, generation: page.navigationGeneration).watch() }
        return interaction.isFindNavigatorVisible
      }
    }.runOnQueue(.main)

    AsyncFunction("setPageZoom") { (pageID: String, zoom: Double) -> Double in
      try MainActor.assumeIsolated {
        let page = try PhonePages.shared.require(pageID)
        page.setPageZoom(zoom)
        return page.pageZoom
      }
    }.runOnQueue(.main)

    AsyncFunction("zoomIn") { (pageID: String) -> Double in
      try MainActor.assumeIsolated {
        let page = try PhonePages.shared.require(pageID)
        page.zoomIn()
        return page.pageZoom
      }
    }.runOnQueue(.main)

    AsyncFunction("zoomOut") { (pageID: String) -> Double in
      try MainActor.assumeIsolated {
        let page = try PhonePages.shared.require(pageID)
        page.zoomOut()
        return page.pageZoom
      }
    }.runOnQueue(.main)

    AsyncFunction("setDesktopSite") { (pageID: String, enabled: Bool) in
      try MainActor.assumeIsolated { try PhonePages.shared.setDesktopSite(pageID, enabled) }
    }.runOnQueue(.main)

    AsyncFunction("download") { (pageID: String, url: String) in
      try MainActor.assumeIsolated {
        let page = try PhonePages.shared.require(pageID)
        guard let target = URL(string: url) else { throw PagePayloads.badArgs("Not a URL: \(url)") }
        guard page.isLive else { throw PagePayloads.error("ERR_PAGE_NOT_LIVE", "The page \(pageID) has no web view to download with") }
        PhonePages.shared.engine.download(target, from: page.id)
      }
    }.runOnQueue(.main)

    AsyncFunction("print") { (pageID: String) -> Bool in
      MainActor.assumeIsolated { PhonePages.shared.print(pageID) }
    }.runOnQueue(.main)

    AsyncFunction("sharePage") { (pageID: String, address: String, title: String, promise: Promise) in
      PageViewModule.main(promise) { await PhonePages.shared.share(pageID, address: address, title: title) }
    }.runOnQueue(.main)

    AsyncFunction("translation") { () -> [String: Any?] in
      MainActor.assumeIsolated { PhonePages.shared.translation() }
    }.runOnQueue(.main)

    AsyncFunction("translationUrl") { (pageURL: String) -> String? in
      MainActor.assumeIsolated { PhonePages.shared.translationURL(for: pageURL) }
    }.runOnQueue(.main)

    AsyncFunction("confirmTranslation") {
      MainActor.assumeIsolated { PhonePages.shared.confirmTranslation() }
    }.runOnQueue(.main)

    AsyncFunction("readableContent") { (pageID: String, promise: Promise) in
      Self.main(promise) { () -> [String: Any?]? in
        let page = try PhonePages.shared.require(pageID)
        guard let content = try? await page.readableContent() else { return nil }
        return PagePayloads.readable(content)
      }
    }.runOnQueue(.main)

    AsyncFunction("summarizePage") { (pageID: String) -> Bool in
      MainActor.assumeIsolated { PageView.host(of: pageID)?.summarize(.menu) ?? false }
    }.runOnQueue(.main)

    AsyncFunction("dismissPageSummaries") { () in
      MainActor.assumeIsolated { PageView.dismissAllSummaries() }
    }.runOnQueue(.main)

    AsyncFunction("pageSummariesEnabled") { () -> Bool in
      MainActor.assumeIsolated { PageSummarySwitch.shared.isOn }
    }.runOnQueue(.main)

    AsyncFunction("setPageSummariesEnabled") { (enabled: Bool) -> Bool in
      MainActor.assumeIsolated { () -> Bool in
        PageSummarySwitch.shared.turn(enabled)
        if !enabled { PageView.stopAllSummaries() }
        return PageSummarySwitch.shared.isOn
      }
    }.runOnQueue(.main)

    AsyncFunction("snapshot") { (pageID: String, options: SnapshotOptionsRecord, promise: Promise) in
      Self.main(promise) { try await PhonePages.shared.snapshot(pageID, maxWidth: options.maxWidth, quality: options.quality, quiet: options.quiet) }
    }.runOnQueue(.main)

    AsyncFunction("loadHtml") { (pageID: String, html: String, baseURL: String) in
      try MainActor.assumeIsolated { try PhonePages.shared.loadHTML(pageID, html: html, baseURL: baseURL) }
    }.runOnQueue(.main)

    AsyncFunction("scrollPosition") { (pageID: String) -> [String: Any]? in
      MainActor.assumeIsolated { PhonePages.shared.scrollPosition(pageID) }
    }.runOnQueue(.main)

    AsyncFunction("evaluate") { (pageID: String, script: String, promise: Promise) in
      Self.main(promise) { try await PhonePages.shared.evaluate(pageID, script: script) }
    }.runOnQueue(.main)

    AsyncFunction("discardBackgroundPages") { (keeping: String?) in
      MainActor.assumeIsolated { PhonePages.shared.discardBackgroundPages(keeping: keeping) }
    }.runOnQueue(.main)

    AsyncFunction("livePageIds") { () -> [String] in
      MainActor.assumeIsolated { PhonePages.shared.livePageIDs }
    }.runOnQueue(.main)

    AsyncFunction("captureOffscreen") { (url: String, pageID: String, promise: Promise) in
      Self.main(promise) { await OffscreenCapture.capture(url: url, pageID: pageID, blocker: PhonePages.shared.engine.blocker) }
    }.runOnQueue(.main)

    AsyncFunction("deleteSnapshots") { (pageID: String, promise: Promise) in
      let floor = PageSnapshots.deletionOrder()
      PageVisuals.shared.forget(pageID)
      Task {
        await PageSnapshots.delete(pageID, before: floor)
        promise.resolve(nil)
      }
    }

    AsyncFunction("deleteSnapshotsFor") { (pageIDs: [String], promise: Promise) in
      let floor = PageSnapshots.deletionOrder()
      for pageID in pageIDs { PageVisuals.shared.forget(pageID) }
      Task {
        await PageSnapshots.delete(pageIDs, before: floor)
        promise.resolve(nil)
      }
    }

    Function("snapshotsCommitted") { (entries: [String: String]) in
      PageSnapshots.committed(entries)
    }

    Function("snapshotIsCurrent") { (pageID: String) -> Bool? in
      PageVisuals.shared.isCurrent(pageID)
    }

    AsyncFunction("saveState") { (pageID: String) -> String? in
      MainActor.assumeIsolated { PhonePages.shared.saveState(pageID) }
    }.runOnQueue(.main)

    Constant("remembersSitePermissions") { PhonePages.remembersSitePermissions }

    AsyncFunction("sitePermissions") { () -> [[String: Any]] in
      MainActor.assumeIsolated {
        PhonePages.shared.engine.preferences.sitePermissions.grants.map { grant in
          [
            "origin": grant.origin,
            "host": grant.host,
            "permissions": grant.permissions.sorted().map(\.rawValue),
            "grantedAt": grant.grantedAt.timeIntervalSince1970 * 1000,
          ]
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("revokeSitePermission") { (origin: String, permission: String?) -> Bool in
      MainActor.assumeIsolated {
        let engine = PhonePages.shared.engine
        guard let grant = engine.preferences.sitePermissions.grants.first(where: { $0.origin == origin }) else { return false }
        let revoked: Set<SitePermission>
        if let permission {
          guard let one = SitePermission(rawValue: permission), grant.permissions.contains(one) else { return false }
          revoked = [one]
        } else {
          revoked = grant.permissions
        }
        engine.revokeCapture(revoked, origin: origin)
        return true
      }
    }.runOnQueue(.main)

    AsyncFunction("answerRequest") { (pageID: String, requestID: String, answer: RequestAnswerRecord) -> Bool in
      try MainActor.assumeIsolated {
        let parsed = try PagePayloads.answer(type: answer.type, text: answer.text, user: answer.user, password: answer.password)
        return PhonePages.shared.answer(pageID, requestID: requestID, answer: parsed)
      }
    }.runOnQueue(.main)

    AsyncFunction("openPopup") { (pageID: String, popupID: String) -> Bool in
      try MainActor.assumeIsolated { try PhonePages.shared.openPopup(pageID, popupID: popupID) }
    }.runOnQueue(.main)

    AsyncFunction("dismissPopup") { (popupID: String) -> Bool in
      MainActor.assumeIsolated { PhonePages.shared.dismissPopup(popupID) }
    }.runOnQueue(.main)

    AsyncFunction("exitFullscreen") { (pageID: String) in
      MainActor.assumeIsolated { PhonePages.shared.page(pageID)?.webView?.closeAllMediaPresentations(completionHandler: nil) }
    }.runOnQueue(.main)

    AsyncFunction("endPrivateSession") {
      MainActor.assumeIsolated { PhonePages.shared.endPrivateSession() }
    }.runOnQueue(.main)

    AsyncFunction("nightShade") { (host: String?, isPrivate: Bool?) -> [String: Any?] in
      MainActor.assumeIsolated {
        let preferences = PhonePages.shared.engine.preferences
        let site = host.flatMap { preferences.settings(for: $0, isPrivate: isPrivate == true).nightShade }
        return [
          "defaultMode": PagePayloads.nightShade(preferences.nightShade),
          "siteMode": site.map(PagePayloads.nightShade),
          "mode": PagePayloads.nightShade(preferences.nightShade(for: host, isPrivate: isPrivate == true)),
        ]
      }
    }.runOnQueue(.main)

    AsyncFunction("setNightShade") { (mode: String?, host: String?, isPrivate: Bool?) in
      try MainActor.assumeIsolated {
        let parsed = try mode.map(PagePayloads.nightShadeMode)
        let preferences = PhonePages.shared.engine.preferences
        if let host {
          preferences.update(host, isPrivate: isPrivate == true) { $0.nightShade = parsed }
        } else {
          preferences.nightShade = parsed ?? .disabled
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("opensLinksInApps") { (host: String) -> Bool in
      MainActor.assumeIsolated { PhonePages.shared.engine.preferences.appLinks(for: host) == .app }
    }.runOnQueue(.main)

    AsyncFunction("setOpensLinksInApps") { (host: String, opens: Bool?) in
      MainActor.assumeIsolated { PhonePages.shared.engine.preferences.update(host) { $0.appLinks = opens.map { $0 ? .app : .ardia } } }
    }.runOnQueue(.main)

    AsyncFunction("siteOpensLinksInApps") { (host: String) -> Bool? in
      MainActor.assumeIsolated { PhonePages.shared.engine.preferences.settings(for: host).appLinks.map { $0 == .app } }
    }.runOnQueue(.main)

    AsyncFunction("appLinksDefault") { () -> Bool in
      MainActor.assumeIsolated { PhonePages.shared.engine.preferences.appLinks == .app }
    }.runOnQueue(.main)

    AsyncFunction("setAppLinksDefault") { (opens: Bool) in
      MainActor.assumeIsolated { PhonePages.shared.engine.preferences.appLinks = opens ? .app : .ardia }
    }.runOnQueue(.main)

    AsyncFunction("clearWebsiteData") { (kinds: [String], promise: Promise) in
      Self.main(promise) {
        let engine = PhonePages.shared.engine
        await BrowsingDataCleaner.clear(try Self.dataKinds(kinds), tabs: engine.tabs, nightShadeVerdicts: engine.preferences.nightShadeVerdicts)
      }
    }.runOnQueue(.main)

    AsyncFunction("clearWebsiteDataSince") { (kinds: [String], since: Double, promise: Promise) in
      Self.main(promise) {
        let date = Date(timeIntervalSince1970: since / 1000)
        let engine = PhonePages.shared.engine
        await BrowsingDataCleaner.clear(try Self.dataKinds(kinds), since: date, tabs: engine.tabs, nightShadeVerdicts: engine.preferences.nightShadeVerdicts)
      }
    }.runOnQueue(.main)

    AsyncFunction("setInspectable") { (inspectable: Bool) in
      MainActor.assumeIsolated {
        let pages = PhonePages.shared
        pages.engine.isInspectable = inspectable
        for id in pages.pageIDList { pages.page(id)?.webView?.isInspectable = inspectable }
      }
    }.runOnQueue(.main)

    View(PageView.self) {
      Events("onPageEvent")

      Prop("pageId") { (view: PageView, pageID: String) in
        view.pageID = pageID
      }

      Prop("initialUrl") { (view: PageView, url: String?) in
        view.initialURL = url
      }

      Prop("title") { (view: PageView, title: String?) in
        view.title = title
      }

      Prop("isPrivate") { (view: PageView, isPrivate: Bool?) in
        view.isPrivate = isPrivate == true
      }

      Prop("savedState") { (view: PageView, savedState: String?) in
        view.savedState = savedState
      }

      Prop("toneInsets") { (view: PageView, insets: [Double]?) in
        if let insets, insets.count == 2 {
          view.toneInsets = (CGFloat(insets[0]), CGFloat(insets[1]))
        } else {
          view.toneInsets = (0, 0)
        }
      }

      Prop("obscuredInsets") { (view: PageView, insets: [Double]?) in
        if let insets, insets.count == 2 {
          view.obscuredInsets = UIEdgeInsets(top: max(CGFloat(insets[0]), 0), left: 0, bottom: max(CGFloat(insets[1]), 0), right: 0)
        } else {
          view.obscuredInsets = .zero
        }
      }

      Prop("topClearance") { (view: PageView, clearance: Double?) in
        view.topClearance = max(CGFloat(clearance ?? 0), 0)
      }

      Prop("coverNativeId") { (view: PageView, id: String?) in
        view.coverNativeID = id
      }

      Prop("obscuresSafeTop") { (view: PageView, follows: Bool?) in
        view.obscuresSafeTop = follows == true
      }

      Prop("pinsSafeArea") { (view: PageView, pins: Bool?) in
        view.pinsSafeArea = pins == true
      }

      Prop("swipeNavigation") { (view: PageView, mode: String?) in
        view.swipeNavigation = mode.flatMap(PageGestures.Swipe.init(rawValue:)) ?? .anywhere
      }

      Prop("closesOnSwipeBack") { (view: PageView, closes: Bool?) in
        view.closesOnSwipeBack = closes == true
      }

      Prop("reopensOnSwipeForward") { (view: PageView, reopens: Bool?) in
        view.reopensOnSwipeForward = reopens == true
      }

      Prop("pullToRefresh") { (view: PageView, pulls: Bool?) in
        view.pullToRefresh = pulls ?? true
      }

      OnViewDidUpdateProps { (view: PageView) in
        MainActor.assumeIsolated { view.bind() }
      }

      AsyncFunction("loadUrl") { (view: PageView, url: String) in
        MainActor.assumeIsolated { view.load(url) }
      }.runOnQueue(.main)

      AsyncFunction("goBack") { (view: PageView) -> Bool in
        MainActor.assumeIsolated { view.goBack() }
      }.runOnQueue(.main)

      AsyncFunction("goForward") { (view: PageView) -> Bool in
        MainActor.assumeIsolated { view.goForward() }
      }.runOnQueue(.main)

      AsyncFunction("reload") { (view: PageView) in
        MainActor.assumeIsolated { view.page?.reload() }
      }.runOnQueue(.main)

      AsyncFunction("stopLoading") { (view: PageView) in
        MainActor.assumeIsolated { view.page?.stopLoading() }
      }.runOnQueue(.main)
    }
  }

  static func dataKinds(_ kinds: [String]) throws -> Set<BrowsingDataKind> {
    try Set(kinds.map { kind -> BrowsingDataKind in
      switch kind {
      case "cache": return .cache
      case "cookiesAndSiteData": return .cookiesAndSiteData
      default: throw PagePayloads.badArgs("Unknown website data kind \(kind)")
      }
    })
  }

  static func main<Value>(_ promise: Promise, _ work: @escaping @MainActor () async throws -> Value) {
    Task { @MainActor in
      do {
        let value = try await work()
        promise.resolve(Value.self == Void.self ? nil : value)
      } catch let exception as Exception {
        promise.reject(exception)
      } catch {
        promise.reject("ERR_PAGE", error.localizedDescription)
      }
    }
  }
}
