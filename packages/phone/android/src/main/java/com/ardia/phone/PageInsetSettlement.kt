package com.ardia.phone

internal class PageInsetSettlement(private val quietMillis: Long = 120) {
    var target: Double? = null
        private set
    var touching = false
    private var changedAt = 0L
    private var scrolledAt = -quietMillis

    fun changed(bottom: Double, now: Long) {
        target = bottom
        changedAt = now
    }

    fun scrolled(now: Long) {
        scrolledAt = now
    }

    fun remaining(now: Long, transitionMillis: Long): Long {
        if (touching) return quietMillis
        return maxOf(changedAt + transitionMillis - now, scrolledAt + quietMillis - now, 0)
    }

    fun reset() {
        target = null
    }
}
