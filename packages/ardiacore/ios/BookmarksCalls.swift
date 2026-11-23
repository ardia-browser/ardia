import ExpoModulesCore

func bookmarksCallTable(exportHtml exportHtmlHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "bookmarks", handlers: [
    "tree": EngineCall.passing("ac_bookmarks_tree"),
    "apply": EngineCall.passing("ac_bookmarks_apply"),
    "watch": EngineCall.passing("ac_bookmarks_watch"),
    "exportHtml": exportHtmlHandler,
  ])
}
