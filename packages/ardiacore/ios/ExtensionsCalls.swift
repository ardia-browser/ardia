import ExpoModulesCore

func extensionsCallTable(list listHandler: @escaping CallHandler, inspectUnpacked inspectUnpackedHandler: @escaping CallHandler, install installHandler: @escaping CallHandler, installCrx installCrxHandler: @escaping CallHandler, setEnabled setEnabledHandler: @escaping CallHandler, uninstall uninstallHandler: @escaping CallHandler, reload reloadHandler: @escaping CallHandler, configure configureHandler: @escaping CallHandler, chooseFolder chooseFolderHandler: @escaping CallHandler, resolveInstallPrompt resolveInstallPromptHandler: @escaping CallHandler, actionStates actionStatesHandler: @escaping CallHandler, sidePanelUrl sidePanelUrlHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "extensions", handlers: [
    "list": listHandler,
    "inspectUnpacked": inspectUnpackedHandler,
    "install": installHandler,
    "installCrx": installCrxHandler,
    "setEnabled": setEnabledHandler,
    "uninstall": uninstallHandler,
    "reload": reloadHandler,
    "configure": configureHandler,
    "chooseFolder": chooseFolderHandler,
    "resolveInstallPrompt": resolveInstallPromptHandler,
    "actionStates": actionStatesHandler,
    "sidePanelUrl": sidePanelUrlHandler,
    "watchActions": EngineCall.passing("ac_extensions_watch_actions"),
    "syncState": EngineCall.passing("ac_extensions_sync_state"),
    "syncApply": EngineCall.passing("ac_extensions_sync_apply"),
    "loadHealth": EngineCall.passing("ac_extensions_load_health"),
  ])
}
