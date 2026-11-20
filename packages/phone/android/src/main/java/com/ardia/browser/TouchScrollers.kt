package com.ardia.browser

import java.util.WeakHashMap

object TouchScrollers {
    const val MESSAGE_PREFIX = "touchScroller:"

    data class Report(val canScrollLeft: Boolean, val canScrollRight: Boolean, val atMillis: Long)

    private val reports = WeakHashMap<Any, Report>()

    fun parse(message: String?, atMillis: Long): Report? {
        val flags = message?.takeIf { it.startsWith(MESSAGE_PREFIX) }?.removePrefix(MESSAGE_PREFIX) ?: return null
        if (flags.length != 2 || flags.any { it != '0' && it != '1' }) return null
        return Report(flags[0] == '1', flags[1] == '1', atMillis)
    }

    fun report(view: Any, message: String?, atMillis: Long): Boolean {
        val parsed = parse(message, atMillis) ?: return false
        synchronized(reports) { reports[view] = parsed }
        return true
    }

    fun since(view: Any?, downMillis: Long): Report? {
        view ?: return null
        return synchronized(reports) { reports[view] }?.takeIf { it.atMillis >= downMillis }
    }

    val script: String = """
(() => {
  if (window.__ardiaTouchScroller || typeof ardiaPage === "undefined") return;
  window.__ardiaTouchScroller = true;
  const scrollsSideways = (style) => /(auto|scroll|overlay)/.test(style.overflowX);
  window.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    let left = false;
    let right = false;
    for (let node = event.target; node && node.nodeType === 1 && node !== document.documentElement && node !== document.body; node = node.parentElement) {
      const room = node.scrollWidth - node.clientWidth;
      if (room <= 1) continue;
      const style = getComputedStyle(node);
      if (!scrollsSideways(style)) continue;
      const fromStart = Math.abs(node.scrollLeft);
      const rtl = style.direction === "rtl";
      const towardStart = fromStart > 1;
      const towardEnd = fromStart < room - 1;
      left = left || (rtl ? towardEnd : towardStart);
      right = right || (rtl ? towardStart : towardEnd);
      if (left && right) break;
    }
    try { ardiaPage.postMessage("$MESSAGE_PREFIX" + (left ? "1" : "0") + (right ? "1" : "0")); } catch (error) {}
  }, { capture: true, passive: true });
})();"""
}
