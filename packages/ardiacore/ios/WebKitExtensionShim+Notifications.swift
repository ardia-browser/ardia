extension WebKitExtensionShimNamespace {
  static let notifications = WebKitExtensionShimNamespace(name: "notifications", script: #"""
      if (APIS.includes("notifications") && !CONTENT && !ns.notifications) {
        const quiet = () => ({ addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false });
        const made = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
        define("notifications", {
          create: withCallback((...args) => Promise.resolve(typeof args[0] === "string" && args[0] ? args[0] : made())),
          update: withCallback(() => Promise.resolve(false)),
          clear: withCallback(() => Promise.resolve(false)),
          getAll: withCallback(() => Promise.resolve({})),
          getPermissionLevel: withCallback(() => Promise.resolve("granted")),
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
