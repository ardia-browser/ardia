extension WebKitExtensionShimNamespace {
  static let notifications = WebKitExtensionShimNamespace(name: "notifications", script: #"""
      if (APIS.includes("notifications") && !CONTENT && !ns.notifications) {
        const quiet = () => ({ addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false });
        const unavailable = () => Promise.reject(new Error("Extension notifications aren't available in WebKit pages."));
        define("notifications", {
          create: withCallback(unavailable),
          update: withCallback(unavailable),
          clear: withCallback(() => Promise.resolve(false)),
          getAll: withCallback(() => Promise.resolve({})),
          getPermissionLevel: withCallback(() => Promise.resolve("denied")),
          onClosed: quiet(),
          onClicked: quiet(),
          onButtonClicked: quiet(),
          onPermissionLevelChanged: quiet(),
          onShowSettings: quiet(),
          TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
          PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
        });
      }
    """#)
}
