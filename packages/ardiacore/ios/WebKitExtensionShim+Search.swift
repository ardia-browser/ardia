extension WebKitExtensionShimNamespace {
  static let search = WebKitExtensionShimNamespace(name: "search", script: #"""
      define("search", api("search", ["query"], [], { Disposition: { CURRENT_TAB: "CURRENT_TAB", NEW_TAB: "NEW_TAB", NEW_WINDOW: "NEW_WINDOW" } }));
    """#)
}
