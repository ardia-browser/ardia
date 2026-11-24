import AppKit
import ExpoModulesCore

public class EngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    OnCreate {
      ArdiaEngineBridge.forwardEngineEvents()
      SystemState.shared.onChange = { state in ArdiaEvents.emit("engine.systemState", data: state) }
      SystemState.shared.start()
    }

    Self.calls.function

    Function("inputIdleSeconds") { () -> Double in
      guard NSRunningApplication.current.isActive else { return 3600 }
      return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
    }
  }

  static func cliTabCall(_ name: String) -> CallHandler {
    { args, reply in
      var forwarded = args.values
      forwarded.removeValue(forKey: "tabId")
      forwarded["tab"] = ArdiaHost.chromeTabId(ofTab: try args.text("tabId"))
      EngineCall.passing(name, profile: args.profile, args: forwarded, reply: reply)
    }
  }

  static let calls = engineCallTable(
    info: { _, reply in reply.ok(ArdiaHost.engineInfo) },
    components: { _, reply in ArdiaServices.components { reply.service($0, $1) } },
    tasks: { _, reply in ArdiaServices.tasks { reply.service($0, $1) } },
    childProcessCpu: { _, reply in ChildProcessCpu.sample { reply.ok($0) } },
    beginTracing: { _, reply in ArdiaHost.beginTracing { reply.ok($0) } },
    endTracing: { args, reply in ArdiaHost.endTracing(keep: try args.bool("keep")) { reply.ok($0) } },
    isTracing: { _, reply in reply.ok(ArdiaHost.isTracing) },
    systemState: { _, reply in reply.ok(SystemState.shared.snapshot) },
    validateKeepActiveSite: { args, reply in
      EngineCall.passing("ac_memory_saver", profile: args.profile, args: ["validate": try args.text("site")], reply: reply)
    },
    setCliControl: { args, reply in
      EngineCall.passing("ac_cli_control", profile: args.profile, args: ["on": try args.bool("on")], reply: reply)
    },
    setCliActiveTab: { args, reply in
      let active = try args.optionalText("tabId").map { ArdiaHost.chromeTabId(ofTab: $0) } ?? -1
      EngineCall.passing("ac_cli_control", profile: args.profile, args: ["active": active], reply: reply)
    },
    cliTabTargets: { args, reply in
      ArdiaHost.cliTabTargets(try args.strings("tabIds")) { reply.ok($0) }
    },
    setCliHeldTabs: { args, reply in
      reply.ok(ArdiaHost.cliHoldTabs(try args.dicts("tabs")))
    },
    cliOwnsTab: { args, reply in
      let tab = ArdiaHost.chromeTabId(ofTab: try args.text("tabId"))
      EngineCall.passing("ac_cli_owns_tab", profile: args.profile, args: ["tab": tab], reply: reply)
    },
    cliConsoleDelta: { args, reply in
      let tab = ArdiaHost.chromeTabId(ofTab: try args.text("tabId"))
      var delta: [String: Any] = ["tab": tab]
      if let after = try args.optionalDouble("after") { delta["after"] = after }
      if let generation = try args.optionalDouble("generation") { delta["generation"] = generation }
      if let limit = try args.optionalDouble("limit") { delta["limit"] = Int(exactly: limit) ?? 0 }
      EngineCall.passing("ac_cli_console_delta", profile: args.profile, args: delta, reply: reply)
    },
    cliDevToolsOpen: cliTabCall("ac_cli_devtools_open"),
    cliSnapshot: cliTabCall("ac_cli_snapshot"),
    cliWaitSettled: cliTabCall("ac_cli_wait_settled"),
    cliHitTest: cliTabCall("ac_cli_hit_test"),
    cliClick: cliTabCall("ac_cli_click"),
    cliScreenshot: cliTabCall("ac_cli_screenshot"),
    cliMoveOffscreen: { args, reply in
      ArdiaHost.cliMoveOffscreen(try args.text("tabId")) { reply.ok($0) }
    },
    cliCloseOffscreenTabs: { _, reply in
      ArdiaHost.cliCloseOffscreenTabs()
      reply.ok()
    }
  )
}
