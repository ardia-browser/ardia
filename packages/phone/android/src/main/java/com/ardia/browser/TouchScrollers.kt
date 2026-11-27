package com.ardia.browser

import java.util.WeakHashMap

object TouchScrollers {
    const val MESSAGE_PREFIX = "touchScroller:"
    const val INNER_SCROLL_PREFIX = "innerScroll:"

    data class Report(val canScrollLeft: Boolean, val canScrollRight: Boolean, val atMillis: Long, val canScrollUp: Boolean = false)

    data class InnerScroll(val scroller: String, val offset: Double, val atEnd: Boolean)

    private val reports = WeakHashMap<Any, Report>()

    fun parse(message: String?, atMillis: Long): Report? {
        val flags = message?.takeIf { it.startsWith(MESSAGE_PREFIX) }?.removePrefix(MESSAGE_PREFIX) ?: return null
        if (flags.length != 3 || flags.any { it != '0' && it != '1' }) return null
        return Report(flags[0] == '1', flags[1] == '1', atMillis, flags[2] == '1')
    }

    fun parseInnerScroll(message: String?): InnerScroll? {
        val fields = message?.takeIf { it.startsWith(INNER_SCROLL_PREFIX) }?.removePrefix(INNER_SCROLL_PREFIX)?.split(':') ?: return null
        if (fields.size != 3) return null
        val (scroller, offset, atEnd) = fields
        if (scroller.isEmpty() || scroller.length > 32 || scroller.any { !it.isLetterOrDigit() && it != '.' }) return null
        val pixels = offset.toIntOrNull()?.takeIf { it >= 0 } ?: return null
        if (atEnd != "0" && atEnd != "1") return null
        return InnerScroll(scroller, pixels.toDouble(), atEnd == "1")
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

    fun everReported(view: Any?): Boolean {
        view ?: return false
        return synchronized(reports) { reports.containsKey(view) }
    }

    val script: String = """
(() => {
  if (window.__ardiaTouchScroller || typeof ardiaPage === "undefined") return;
  window.__ardiaTouchScroller = true;
  const scrolls = (overflow) => /(auto|scroll|overlay)/.test(overflow);
  let watchShadowRoot = null;
  const parentAcrossShadow = (node) => {
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentElement) return node.parentElement;
    const rootNode = node.getRootNode();
    if (!rootNode || rootNode === document || !rootNode.host) return null;
    if (watchShadowRoot) watchShadowRoot(rootNode);
    return rootNode.host;
  };
  window.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    let left = false;
    let right = false;
    let up = false;
    const root = document.scrollingElement;
    const touched = event.composedPath()[0] || event.target;
    const start = touched && touched.nodeType === 1 ? touched : touched && touched.parentElement;
    for (let node = start; node && node.nodeType === 1 && node !== root; node = parentAcrossShadow(node)) {
      const room = node === document.documentElement || node === document.body ? 0 : node.scrollWidth - node.clientWidth;
      const sideways = room > 1 && !(left && right);
      const upward = !up && node.scrollTop > 1;
      if (!sideways && !upward) continue;
      const style = getComputedStyle(node);
      if (upward && scrolls(style.overflowY)) up = true;
      if (sideways && scrolls(style.overflowX)) {
        const fromStart = Math.abs(node.scrollLeft);
        const rtl = style.direction === "rtl";
        const towardStart = fromStart > 1;
        const towardEnd = fromStart < room - 1;
        left = left || (rtl ? towardEnd : towardStart);
        right = right || (rtl ? towardStart : towardEnd);
      }
      if (left && right && up) break;
    }
    try { ardiaPage.postMessage("$MESSAGE_PREFIX" + (left ? "1" : "0") + (right ? "1" : "0") + (up ? "1" : "0")); } catch (error) {}
  }, { capture: true, passive: true });
  if (window !== window.top) return;
  const documentKey = Math.random().toString(36).slice(2, 10);
  const scrollers = new WeakMap();
  let nextScroller = 1;
  let queued = null;
  let framing = false;
  const reportInnerScroll = () => {
    framing = false;
    const node = queued;
    queued = null;
    if (!node || !node.isConnected) return;
    const seen = scrollers.get(node);
    const top = Math.max(0, node.scrollTop);
    if (seen.top === top) return;
    seen.top = top;
    const atEnd = node.scrollHeight - node.clientHeight - top <= 2;
    const pixels = Math.round(top * (window.devicePixelRatio || 1));
    try { ardiaPage.postMessage("$INNER_SCROLL_PREFIX" + seen.key + ":" + pixels + ":" + (atEnd ? "1" : "0")); } catch (error) {}
  };
  const innerScrolled = (event) => {
    const node = event.target;
    if (!node || node.nodeType !== 1 || node === document.scrollingElement) return;
    if (node.clientHeight < window.innerHeight * 0.5 || node.clientWidth < window.innerWidth * 0.8) return;
    if (!scrollers.has(node)) scrollers.set(node, { key: documentKey + "." + nextScroller++, top: -1 });
    queued = node;
    if (framing) return;
    framing = true;
    requestAnimationFrame(reportInnerScroll);
  };
  document.addEventListener("scroll", innerScrolled, { capture: true, passive: true });
  const watchedShadowRoots = new WeakSet();
  watchShadowRoot = (shadowRoot) => {
    if (watchedShadowRoots.has(shadowRoot)) return;
    watchedShadowRoots.add(shadowRoot);
    shadowRoot.addEventListener("scroll", innerScrolled, { capture: true, passive: true });
  };
})();"""
}
