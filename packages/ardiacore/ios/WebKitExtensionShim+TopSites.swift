extension WebKitExtensionShimNamespace {
  static let topSites = WebKitExtensionShimNamespace(name: "topSites", script: #"""
      define("topSites", api("topSites", ["get"], []));
    """#)
}
