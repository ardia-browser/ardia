extension WebKitExtensionShimNamespace {
  static let commands = WebKitExtensionShimNamespace(name: "commands", permissions: [], script: #"""
      if (APIS.includes("commands") && !CONTENT) {
        override("commands", "getAll", withCallback(() => request("commands", "getAll", [])));
      }
    """#)
}
