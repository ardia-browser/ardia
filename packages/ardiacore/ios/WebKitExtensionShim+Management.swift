extension WebKitExtensionShimNamespace {
  static let management = WebKitExtensionShimNamespace(name: "management", permissions: [], script: #"""
      if (APIS.includes("management") && !CONTENT) {
        const full = granted("management");
        const methods = full
          ? ["get", "getAll", "getSelf", "getPermissionWarningsById", "getPermissionWarningsByManifest", "setEnabled", "uninstall", "uninstallSelf", "launchApp", "createAppShortcut", "setLaunchType", "generateAppForLink"]
          : ["getSelf", "uninstallSelf", "getPermissionWarningsByManifest"];
        define("management", api("management", methods, full ? ["onInstalled", "onUninstalled", "onEnabled", "onDisabled"] : [], {
          ExtensionDisabledReason: { UNKNOWN: "unknown", PERMISSIONS_INCREASE: "permissions_increase" },
          ExtensionInstallType: { ADMIN: "admin", DEVELOPMENT: "development", NORMAL: "normal", SIDELOAD: "sideload", OTHER: "other" },
          ExtensionType: { EXTENSION: "extension", HOSTED_APP: "hosted_app", PACKAGED_APP: "packaged_app", LEGACY_PACKAGED_APP: "legacy_packaged_app", THEME: "theme", LOGIN_SCREEN_EXTENSION: "login_screen_extension" },
          LaunchType: { OPEN_AS_REGULAR_TAB: "OPEN_AS_REGULAR_TAB", OPEN_AS_PINNED_TAB: "OPEN_AS_PINNED_TAB", OPEN_AS_WINDOW: "OPEN_AS_WINDOW", OPEN_FULL_SCREEN: "OPEN_FULL_SCREEN" },
        }));
      }
    """#)
}
