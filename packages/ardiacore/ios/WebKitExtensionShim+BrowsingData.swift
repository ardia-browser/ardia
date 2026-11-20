extension WebKitExtensionShimNamespace {
  static let browsingData = WebKitExtensionShimNamespace(name: "browsingData", script: #"""
      define("browsingData", api("browsingData", [
        "settings", "remove", "removeAppcache", "removeCache", "removeCacheStorage", "removeCookies", "removeDownloads", "removeFileSystems", "removeFormData",
        "removeHistory", "removeIndexedDB", "removeLocalStorage", "removePasswords", "removePluginData", "removeServiceWorkers", "removeWebSQL",
      ], []));
    """#)
}
