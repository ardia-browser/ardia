import ExpoModulesCore

func engineCallTable(info infoHandler: @escaping CallHandler, components componentsHandler: @escaping CallHandler, tasks tasksHandler: @escaping CallHandler, childProcessCpu childProcessCpuHandler: @escaping CallHandler, beginTracing beginTracingHandler: @escaping CallHandler, endTracing endTracingHandler: @escaping CallHandler, isTracing isTracingHandler: @escaping CallHandler, systemState systemStateHandler: @escaping CallHandler, validateKeepActiveSite validateKeepActiveSiteHandler: @escaping CallHandler, setCliControl setCliControlHandler: @escaping CallHandler, setCliActiveTab setCliActiveTabHandler: @escaping CallHandler, cliTabTargets cliTabTargetsHandler: @escaping CallHandler, setCliHeldTabs setCliHeldTabsHandler: @escaping CallHandler, cliOwnsTab cliOwnsTabHandler: @escaping CallHandler, cliMoveOffscreen cliMoveOffscreenHandler: @escaping CallHandler, cliCloseOffscreenTabs cliCloseOffscreenTabsHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "engine", handlers: [
    "info": infoHandler,
    "components": componentsHandler,
    "tasks": tasksHandler,
    "childProcessCpu": childProcessCpuHandler,
    "beginTracing": beginTracingHandler,
    "endTracing": endTracingHandler,
    "isTracing": isTracingHandler,
    "systemState": systemStateHandler,
    "batterySaver": EngineCall.passing("ac_battery_saver"),
    "memorySaver": EngineCall.passing("ac_memory_saver"),
    "validateKeepActiveSite": validateKeepActiveSiteHandler,
    "trimMemory": EngineCall.passing("ac_memory_trim"),
    "openTaskManager": EngineCall.passing("ac_task_manager_open"),
    "cliControlStatus": EngineCall.passing("ac_cli_control"),
    "setCliControl": setCliControlHandler,
    "setCliActiveTab": setCliActiveTabHandler,
    "cliTabTargets": cliTabTargetsHandler,
    "setCliHeldTabs": setCliHeldTabsHandler,
    "cliOwnsTab": cliOwnsTabHandler,
    "cliMoveOffscreen": cliMoveOffscreenHandler,
    "cliCloseOffscreenTabs": cliCloseOffscreenTabsHandler,
  ])
}
