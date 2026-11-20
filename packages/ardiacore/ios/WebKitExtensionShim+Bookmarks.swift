extension WebKitExtensionShimNamespace {
  static let bookmarks = WebKitExtensionShimNamespace(name: "bookmarks", script: #"""
      define("bookmarks", api(
        "bookmarks",
        ["get", "getChildren", "getRecent", "getTree", "getSubTree", "search", "create", "move", "update", "remove", "removeTree"],
        ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportBegan", "onImportEnded"],
        { MAX_WRITE_OPERATIONS_PER_HOUR: 1000000, MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000 },
      ));
    """#)
}
