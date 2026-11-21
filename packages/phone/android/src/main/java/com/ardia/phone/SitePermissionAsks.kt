package com.ardia.phone

internal typealias AndroidPermissionGate = (Array<String>, (Map<String, Boolean>) -> Unit) -> Unit

internal class SitePermissionAsks(
    private val visible: (pageId: String) -> Boolean,
    private val held: (Array<String>) -> Map<String, Boolean>,
) {
    class Ask(val pageId: String, val needed: Array<String>, val wanted: () -> Boolean, val granted: (Map<String, Boolean>) -> Boolean, val request: Any? = null, val answer: (Boolean) -> Unit) {
        internal var done = false
        internal var attempts = 0
    }

    var gate: AndroidPermissionGate? = null
        set(value) {
            field = value
            pump()
        }

    private val waiting = ArrayList<Ask>()
    private var asking: Ask? = null

    val pending: Int get() = waiting.size + (if (asking != null) 1 else 0)

    fun holds(pageId: String, request: Any): Boolean =
        waiting.any { it.pageId == pageId && it.request === request && !it.done } || asking?.let { it.pageId == pageId && it.request === request && !it.done } == true

    fun hold(ask: Ask) {
        drop(ask.pageId)
        waiting += ask
        pump()
    }

    private fun retire(ask: Ask): Boolean {
        ask.done = true
        return true
    }

    fun drop(pageId: String) {
        waiting.removeAll { it.pageId == pageId && retire(it) }
        val current = asking
        if (current != null && current.pageId == pageId) {
            retire(current)
            asking = null
        }
        pump()
    }

    fun lost() {
        val current = asking ?: return
        asking = null
        if (!current.done) waiting.add(0, current)
    }

    fun pump() {
        if (asking != null) return
        waiting.removeAll { !it.wanted() && retire(it) }
        val gate = gate ?: return
        val next = waiting.firstOrNull { visible(it.pageId) } ?: return
        waiting.remove(next)
        if (next.attempts > 0 && next.granted(held(next.needed))) return finish(next, true)
        next.attempts += 1
        asking = next
        gate(next.needed) { results -> finish(next, next.granted(held(next.needed) + results.filterValues { it })) }
    }

    private fun finish(ask: Ask, granted: Boolean) {
        if (asking === ask) asking = null
        waiting.remove(ask)
        if (ask.done) return pump()
        ask.done = true
        if (ask.wanted()) ask.answer(granted)
        pump()
    }
}
