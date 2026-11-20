extension WebKitExtensionShimNamespace {
  static let sidePanel = WebKitExtensionShimNamespace(name: "sidePanel", script: #"""
      define("sidePanel", api("sidePanel", ["setOptions", "getOptions", "setPanelBehavior", "getPanelBehavior", "open", "close", "getLayout"], ["onOpened", "onClosed"]));
    """#)
}
