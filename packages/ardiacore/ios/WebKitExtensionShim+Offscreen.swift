extension WebKitExtensionShimNamespace {
  static let offscreen = WebKitExtensionShimNamespace(name: "offscreen", script: #"""
      if (APIS.includes("offscreen") && !CONTENT) {
        const reasons = ["TESTING", "AUDIO_PLAYBACK", "IFRAME_SCRIPTING", "DOM_SCRAPING", "BLOBS", "DOM_PARSER", "USER_MEDIA", "DISPLAY_MEDIA", "WEB_RTC", "CLIPBOARD", "LOCAL_STORAGE", "WORKERS", "BATTERY_STATUS", "MATCH_MEDIA", "GEOLOCATION"];
        define("offscreen", api("offscreen", ["createDocument", "closeDocument", "hasDocument"], [], { Reason: Object.fromEntries(reasons.map((r) => [r, r])) }));
      }
    """#)
}
