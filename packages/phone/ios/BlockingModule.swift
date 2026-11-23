import ArdiaBrowser
import ExpoModulesCore
import Foundation

public final class BlockingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneBlocking")

    Events("onBlockingEvent")

    OnCreate {
      onMain {
        PhonePages.shared.blockingSink = { [weak self] event in self?.sendEvent("onBlockingEvent", event) }
      }
    }

    OnDestroy {
      onMain { PhonePages.shared.blockingSink = nil }
    }

    AsyncFunction("state") { () -> [String: Any?] in
      MainActor.assumeIsolated { PhonePages.shared.blockingState() }
    }.runOnQueue(.main)

    AsyncFunction("setEnabled") { (enabled: Bool) in
      MainActor.assumeIsolated { PhonePages.shared.engine.blocker.settings.isOn = enabled }
    }.runOnQueue(.main)

    AsyncFunction("setCategory") { (category: String, enabled: Bool) in
      try MainActor.assumeIsolated {
        let settings = PhonePages.shared.engine.blocker.settings
        switch BlockingCategory(rawValue: category) {
        case .ads: settings.blocksAds = enabled
        case .trackers: settings.blocksTrackers = enabled
        case .cookieBanners: settings.hidesCookieBanners = enabled
        case nil: throw PagePayloads.badArgs("Unknown blocking category \(category)")
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("isEnabledForSite") { (url: String, isPrivate: Bool?) -> Bool in
      MainActor.assumeIsolated {
        let settings = PhonePages.shared.engine.blocker.settings
        return settings.isOn && !settings.isExempt(BrowserURL.host(of: url), isPrivate: isPrivate == true)
      }
    }.runOnQueue(.main)

    AsyncFunction("setEnabledForSite") { (url: String, enabled: Bool, isPrivate: Bool?) -> String? in
      MainActor.assumeIsolated {
        guard let host = BrowserURL.host(of: url) else { return nil }
        PhonePages.shared.engine.blocker.settings.setExempt(host, !enabled, isPrivate: isPrivate == true)
        return host
      }
    }.runOnQueue(.main)

    AsyncFunction("setListEnabled") { (id: String, enabled: Bool) in
      MainActor.assumeIsolated { PhonePages.shared.engine.blocker.filterLists.setEnabled(id, enabled) }
    }.runOnQueue(.main)

    AsyncFunction("removeList") { (id: String) in
      MainActor.assumeIsolated { PhonePages.shared.engine.blocker.filterLists.removeList(id) }
    }.runOnQueue(.main)

    AsyncFunction("updateLists") { (promise: Promise) in
      PageViewModule.main(promise) { await PhonePages.shared.engine.blocker.refreshIfDue(force: true) }
    }.runOnQueue(.main)

    AsyncFunction("resetToDefaults") { (promise: Promise) in
      PageViewModule.main(promise) { await PhonePages.shared.engine.blocker.filterLists.resetToDefaults() }
    }.runOnQueue(.main)

    AsyncFunction("addCustomList") { (url: String, promise: Promise) in
      PageViewModule.main(promise) { () -> String in
        guard let target = URL(string: url) else { throw PagePayloads.badArgs("Not a URL: \(url)") }
        do {
          return try await PhonePages.shared.engine.blocker.filterLists.addCustomList(url: target).id
        } catch {
          throw PagePayloads.error("ERR_FILTER_LIST", (error as? FilterListError)?.message ?? error.localizedDescription)
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("setMyFilters") { (text: String, promise: Promise) in
      PageViewModule.main(promise) { () -> [String: Any] in
        let result = await PhonePages.shared.engine.blocker.filterLists.applyMyFilters(text)
        return ["ruleCount": result.ruleCount, "skippedCount": result.skippedCount, "isTooLarge": false]
      }
    }.runOnQueue(.main)

    AsyncFunction("blockedCount") { (pageID: String) -> Int? in
      MainActor.assumeIsolated { PhonePages.shared.page(pageID)?.blockedResources.count }
    }.runOnQueue(.main)
  }
}
