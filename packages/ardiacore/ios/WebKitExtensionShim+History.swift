extension WebKitExtensionShimNamespace {
  static let history = WebKitExtensionShimNamespace(name: "history", script: #"""
      define("history", api("history", ["search", "getVisits", "addUrl", "deleteUrl", "deleteRange", "deleteAll"], ["onVisited", "onVisitRemoved"]));
    """#)
}
