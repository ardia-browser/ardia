(() => {
  if (window.__ardiaNotificationBridge) return;
  window.__ardiaNotificationBridge = true;
  document.addEventListener("ardia:notification", (e) => {
    let detail = null;
    try {
      detail = JSON.parse(e.detail);
    } catch (error) {}
    if (!detail || typeof detail.type !== "string") return;
    try {
      window.webkit.messageHandlers.ardia.postMessage({ kind: "notification", data: detail, frame: "notifications" });
    } catch (error) {}
  }, true);
})();
