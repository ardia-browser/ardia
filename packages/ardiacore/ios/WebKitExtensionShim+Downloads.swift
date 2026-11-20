extension WebKitExtensionShimNamespace {
  static let downloads = WebKitExtensionShimNamespace(name: "downloads", script: #"""
      define("downloads", api(
        "downloads",
        ["download", "search", "pause", "resume", "cancel", "erase", "open", "show", "showDefaultFolder", "removeFile", "acceptDanger", "getFileIcon", "setUiOptions", "setShelfEnabled"],
        ["onCreated", "onChanged", "onErased", "onDeterminingFilename"],
        {
          State: { IN_PROGRESS: "in_progress", INTERRUPTED: "interrupted", COMPLETE: "complete" },
          FilenameConflictAction: { UNIQUIFY: "uniquify", OVERWRITE: "overwrite", PROMPT: "prompt" },
        },
      ));
    """#)
}
