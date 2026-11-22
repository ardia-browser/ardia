import AppKit
import ExpoModulesCore
import WebKit

public class WebKitModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    Self.calls.function

    PageViewDefinition.of(WebKitTabView.self)
  }
  static let calls = CallTable(domain: "webKit", handlers: [
    "removeDownloadStaging": { args, reply in
      reply.ok(WebKitDownloads.removeStaging(try args.text("path")))
    },
    "endPrivateSession": { args, reply in
      WebKitHub.endPrivateSessionIfStarted(try args.text("session"))
      reply.ok()
    },
    "cookieStoreKey": { args, reply in reply.ok(WebKitHub.shared.stores.id(of: args.profile).wireKey) },
    "importCookies": { args, reply in
      let cookies = try args.dicts("cookies")
      WebKitHub.shared.importCookies(cookies, profile: args.profile, storeKey: try args.text("storeKey")) { reply.ok($0) }
    },
    "exportCookies": { args, reply in
      let urls = try args.strings("urls").compactMap(URL.init(string:))
      let keys = args.values["keys"] == nil ? nil : Set(try args.strings("keys"))
      WebKitHub.shared.exportCookies(profile: args.profile, urls: urls, keys: keys) { reply.ok($0) }
    },
    "setFraudWarnings": { args, reply in
      WebKitFraudWarnings.set(try args.bool("enabled"))
      reply.ok()
    },
    "watchSiteData": { args, reply in
      WebKitSiteData.shared.setWatching(try args.bool("enabled"))
      reply.ok()
    },
    "siteDataReady": { args, reply in
      WebKitSiteData.shared.release(try args.text("id"))
      reply.ok()
    },
    "readSiteData": { args, reply in
      let origins = try args.strings("origins").compactMap(URL.init(string:)).filter { WebKitSiteData.origin(of: $0) != nil }
      WebKitSiteData.shared.read(profile: args.profile, domains: try args.strings("domains"), origins: Array(origins.prefix(16))) { reply.ok($0) }
    },
    "writeSiteData": { args, reply in
      let storage = (try args.dict("storage")).compactMapValues { $0 as? [String: Any] }
      WebKitSiteData.shared.write(profile: args.profile, set: try args.dicts("set"), remove: try args.dicts("remove"), storage: storage) { reply.ok($0) }
    },
    "setZoom": { args, reply in
      WebKitHub.shared.setZoom(try args.double("zoom"), profile: args.profile, host: try args.text("host").lowercased())
      reply.ok()
    },
    "notificationAction": { args, reply in
      let action = try args.text("action")
      if WebKitHub.started, action == "click" || action == "close" { WebKitHub.shared.notifications.act(try args.text("id"), action: action) }
      reply.ok()
    },
    "passkeyAccess": { _, reply in reply.ok(WebKitPasskeys.access()) },
    "requestPasskeyAccess": { _, reply in WebKitPasskeys.requestAccess { reply.ok($0) } },
  ].merging(LaunchConfig.shared.testInstance ? testInstanceCalls : [:]) { call, _ in call })

  private static let testInstanceCalls: [String: CallHandler] = [
    "devStoreExists": { args, reply in WebKitHub.shared.storeExists(args.profile) { reply.ok($0) } },
    "devHoldStore": { args, reply in
      WebKitHub.shared.stores.holdForTest(args.profile)
      reply.ok()
    },
    "devTouchStore": { args, reply in WebKitHub.shared.touchStore(args.profile) { reply.ok($0) } },
    "devParkedTransfers": { _, reply in reply.ok(WebKitHub.shared.transfers.parkedKeys) },
    "devContentBlocker": { _, reply in reply.ok(WebKitContentBlocker.shared.state) },
  ]
}
