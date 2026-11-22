import ExpoModulesCore

public class TabsModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    OnCreate {
      ArdiaTabStrip.watchStrips()
      ArdiaWebView.setJavaScriptThread { [weak self] block in self?.appContext?.executeOnJavaScriptThread(runBlock: block) }
    }

    OnDestroy {
      ArdiaWebView.endRevealsAheadOfSwitch()
    }

    Function("prepareTransfer") { (key: String) in
      for engine in PageEngines.all { engine.prepareTransfer(key) }
    }
    Function("releaseTransfer") { (key: String) in
      for engine in PageEngines.all { engine.releaseTransfer(key) }
    }
    Function("claimLaunchTab") { (key: String, url: String, profile: String) in
      ArdiaWebView.claimLaunchTab(key, url: url, profile: profile)
    }
    AsyncFunction("materializeTab") { (key: String, url: String, profile: String, window: String) -> Bool in
      ArdiaWebView.materializeTab(key, url: url, profile: profile, window: window)
    }.runOnQueue(.main)
    Function("revealTab") { (key: String, press: Int) in ArdiaWebView.revealTab(key, press: UInt(max(press, 0))) }
    Function("dropTabReveals") { (key: String, press: Int, incoming: String) in ArdiaWebView.dropTabReveals(key, press: UInt(max(press, 0)), to: incoming) }
    Function("claimTabPress") { (key: String, stamp: Double) -> Int in Int(ArdiaWebView.claimTabPress(key, stamp: stamp)) }
    Function("dropTabPress") { (press: Int) in ArdiaWebView.dropTabPress(UInt(max(press, 0))) }
    Function("setTabsInSplits") { (keys: [String]) in ArdiaWebView.setTabsInSplits(keys) }
    Function("setNativeTabSwitch") { (enabled: Bool) in ArdiaWebView.setNativeTabSwitch(enabled) }
    Function("revealOffered") { (adoptId: String, key: String, press: Int) in ArdiaWebView.revealOffered(adoptId, over: key, press: UInt(max(press, 0))) }
    AsyncFunction("discardOffered") { (adoptId: String) -> Bool in ArdiaWebView.discardOffered(adoptId) }.runOnQueue(.main)

    Self.calls.function
  }

  static func browserId(_ args: CallArgs) throws -> Int32 { ArdiaWebView.browserId(ofTab: try args.text("tabId")) }

  static let calls = CallTable(domain: "tabs", handlers: [
    "routeLinkTabs": { args, reply in reply.ok(ArdiaWebView.routeLinkTabs(try args.strings("urls"))) },
    "stripCommand": { args, reply in
      ArdiaTabStrip.command(try args.int("id"), command: try args.dict("command"))
      reply.ok()
    },
    "strips": { _, reply in reply.ok(ArdiaTabStrip.allStrips) },
    "reportCommits": { args, reply in
      ArdiaWebView.reportsCommits = try args.bool("on")
      reply.ok()
    },
    "lastTabPolicy": EngineCall.passing("ac_tabs_last_tab_policy"),
    "devBrowserId": { args, reply in reply.ok(try browserId(args)) },
    "devEvents": { args, reply in
      let webKit = WebKitHub.shared.transfers.liveTab(try args.text("tabId"))?.browserId
      reply.ok(ArdiaWebView.devEvents(browserId: try webKit ?? browserId(args)))
    },
    "devWindowNumber": { args, reply in reply.ok(ArdiaWebView.devWindowNumber(browserId: try browserId(args))) },
    "devFocusPage": { args, reply in reply.ok(ArdiaWebView.devFocusPage(browserId: try browserId(args))) },
    "devPictureInPicture": { _, reply in reply.ok(ArdiaWebView.devPictureInPicture()) },
    "devPostPeekMouseUp": { args, reply in reply.ok(ArdiaWebView.devPostPeekMouseUp(try args.text("keys"), over: try args.text("tabId"))) },
    "devScrollZoom": { args, reply in
      let steps = try args.dicts("steps")
      reply.ok(ArdiaWebView.devScrollZoom(steps, browserId: ArdiaWebView.browserId(ofTab: try args.optionalText("tabId"))))
    },
  ].merging(LaunchConfig.shared.testInstance ? testInstanceCalls : [:]) { call, _ in call })

  private static let testInstanceCalls: [String: CallHandler] = [
    "devPictureInPictureAction": { args, reply in reply.ok(ArdiaWebView.devPictureInPictureAction(try args.text("action"))) },
    "devPagePhase": { args, reply in reply.ok(ArdiaWebView.devPagePhase(of: try args.text("tabId"))) },
    "devClosePage": { args, reply in reply.ok(ArdiaWebView.devClosePage(of: try args.text("tabId"))) },
  ]
}
