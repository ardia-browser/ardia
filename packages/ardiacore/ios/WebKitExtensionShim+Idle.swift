extension WebKitExtensionShimNamespace {
  static let idle = WebKitExtensionShimNamespace(name: "idle", script: #"""
      define("idle", api("idle", ["queryState", "setDetectionInterval"], ["onStateChanged"], { IdleState: { ACTIVE: "active", IDLE: "idle", LOCKED: "locked" } }));
    """#)
}
