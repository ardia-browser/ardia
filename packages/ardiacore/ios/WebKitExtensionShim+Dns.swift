extension WebKitExtensionShimNamespace {
  static let dns = WebKitExtensionShimNamespace(name: "dns", script: #"""
      define("dns", api("dns", ["resolve"], []));
    """#)
}
