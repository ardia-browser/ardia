export function flashElement(el: Element, duration = 1800) {
  el.scrollIntoView({ block: "center" });
  requestAnimationFrame(() => {
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.className = "n-flash-overlay";
    overlay.dataset.target = el.getAttribute("data-id") ?? "";
    Object.assign(overlay.style, { left: `${rect.left - 4}px`, top: `${rect.top}px`, width: `${rect.width + 8}px`, height: `${rect.height}px`, animationDuration: `${duration}ms` });
    document.body.append(overlay);
    setTimeout(() => overlay.remove(), duration);
  });
}
