extension WebKitExtensionShimNamespace {
  static let sessions = WebKitExtensionShimNamespace(name: "sessions", script: #"""
      define("sessions", api("sessions", ["getRecentlyClosed", "getDevices", "restore"], ["onChanged"], { MAX_SESSION_RESULTS: 25 }));
    """#)
}
