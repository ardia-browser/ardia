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

  static let calls = CallTable(domain: "engine", handlers: [
    "info": { _, reply in reply.ok(ArdiaHost.engineInfo) },
    "components": { _, reply in ArdiaServices.components { reply.service($0, $1) } },
    "tasks": { _, reply in ArdiaServices.tasks { reply.service($0, $1) } },
    "beginTracing": { _, reply in ArdiaHost.beginTracing { reply.ok($0) } },
    "endTracing": { args, reply in ArdiaHost.endTracing(keep: try args.bool("keep")) { reply.ok($0) } },
    "isTracing": { _, reply in reply.ok(ArdiaHost.isTracing) },
    "systemState": { _, reply in reply.ok(SystemState.shared.snapshot) },
    "batterySaver": EngineCall.passing("ac_battery_saver"),
    "memorySaver": EngineCall.passing("ac_memory_saver"),
    "validateKeepActiveSite": { args, reply in
      EngineCall.passing("ac_memory_saver", profile: args.profile, args: ["validate": try args.text("site")], reply: reply)
    },
    "trimMemory": EngineCall.passing("ac_memory_trim"),
    "openTaskManager": EngineCall.passing("ac_task_manager_open"),
    "cliControlStatus": EngineCall.passing("ac_cli_control"),
    "setCliControl": { args, reply in
      EngineCall.passing("ac_cli_control", profile: args.profile, args: ["on": try args.bool("on")], reply: reply)
    },
    "cliTabTargets": { args, reply in
      ArdiaHost.cliTabTargets(try args.strings("tabIds")) { reply.ok($0) }
    },
    "cliOwnsTab": { args, reply in
      let tab = ArdiaHost.chromeTabId(ofTab: try args.text("tabId"))
      EngineCall.passing("ac_cli_owns_tab", profile: args.profile, args: ["tab": tab], reply: reply)
    },
    "cliMoveOffscreen": { args, reply in
      ArdiaHost.cliMoveOffscreen(try args.text("tabId")) { reply.ok($0) }
    },
    "cliCloseOffscreenTabs": { _, reply in
      ArdiaHost.cliCloseOffscreenTabs()
      reply.ok()
    },
    "cliPluginCredential": { args, reply in
      if let revoke = try args.optionalText("revoke") {
        EngineCall.passing("ac_cli_plugin_credential", profile: args.profile, args: ["revoke": revoke], reply: reply)
        return
      }
      let tab = ArdiaHost.chromeTabId(ofTab: try args.text("tabId"))
      if let visible = try args.optionalBool("visible") {
        let id = try args.text("id")
        EngineCall.passing("ac_cli_plugin_credential", profile: args.profile, args: ["id": id, "tab": tab, "visible": visible], reply: reply)
        return
      }
      EngineCall.passing("ac_cli_plugin_credential", profile: args.profile, args: ["tab": tab], reply: reply)
    },
    "cliActDocument": { args, reply in
      let tab = ArdiaHost.chromeTabId(ofTab: try args.text("tabId"))
      EngineCall.passing("ac_cli_act_document", profile: args.profile, args: ["tab": tab, "credential": try args.text("credential")], reply: reply)
    },
    "cliActLease": { args, reply in
      let tab = ArdiaHost.chromeTabId(ofTab: try args.text("tabId"))
      EngineCall.passing("ac_cli_act_lease", profile: args.profile, args: ["tab": tab, "credential": try args.text("credential"), "document": try args.int("document")], reply: reply)
    },
    "cliTestPointer": { args, reply in
      ArdiaEngineBridge.call("ac_cli_test_pointer", profile: args.profile, args: args.json) { reply.engine($0) }
    },
    "cliActRelease": { args, reply in
      EngineCall.passing("ac_cli_act_release", profile: args.profile, args: ["lease": try args.int("lease")], reply: reply)
    },
    "setCliActiveTab": { args, reply in
      let active = try args.optionalText("tabId").map { ArdiaHost.chromeTabId(ofTab: $0) } ?? -1
      EngineCall.passing("ac_cli_control", profile: args.profile, args: ["active": active], reply: reply)
    },
  ])
}
