package com.ardia.browser

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

enum class ScrollDirection {
    Up,
    Down,
}

class ProgressThrottle(private val minimumIntervalMillis: Long = 100) {
    var published = 0f
        private set
    private var lastPublish = Long.MIN_VALUE / 2

    fun offer(raw: Double, nowMillis: Long): Float? {
        val whole = (floor(max(0.0, min(1.0, raw)) * 100) / 100).toFloat()
        if (whole == published) return null
        val finishing = whole >= 1f || whole == 0f
        if (!finishing && nowMillis - lastPublish < minimumIntervalMillis) return null
        published = whole
        lastPublish = nowMillis
        return whole
    }

    fun reset() {
        published = 0f
        lastPublish = Long.MIN_VALUE / 2
    }
}

class ScrollDirectionTracker(private val threshold: Double = 24.0, private val resizeSettleMillis: Long = 1_000) {
    var direction = ScrollDirection.Up
        private set
    private var anchor = 0.0
    private var settlesUntil = Long.MIN_VALUE
    private var fingerY = 0.0
    private var dragDirection: ScrollDirection? = null

    fun offer(offset: Double, atEnd: Boolean, nowMillis: Long): ScrollDirection? {
        if (offset <= 0) {
            anchor = 0.0
            return update(ScrollDirection.Up)
        }
        val delta = offset - anchor
        val heading = if (delta > 0) ScrollDirection.Down else ScrollDirection.Up
        val movedByResize = nowMillis < settlesUntil && heading != dragDirection
        val bouncedOffEnd = atEnd && heading == ScrollDirection.Up
        if (movedByResize || bouncedOffEnd) {
            anchor = offset
            return null
        }
        val turned = if (direction == ScrollDirection.Up) delta > threshold else delta < -threshold
        if (turned) {
            anchor = offset
            return update(heading)
        }
        if (if (direction == ScrollDirection.Down) delta > 0 else delta < 0) anchor = offset
        return null
    }

    fun resized(nowMillis: Long) {
        settlesUntil = nowMillis + resizeSettleMillis
        dragDirection = null
    }

    fun touched(y: Double) {
        settlesUntil = Long.MIN_VALUE
        fingerY = y
    }

    fun dragged(y: Double) {
        val travel = fingerY - y
        if (abs(travel) <= threshold) return
        dragDirection = if (travel > 0) ScrollDirection.Down else ScrollDirection.Up
        fingerY = y
    }

    fun released() {
        dragDirection = null
    }

    fun reset() {
        direction = ScrollDirection.Up
        anchor = 0.0
    }

    fun snapTo(offset: Double) {
        direction = ScrollDirection.Up
        anchor = offset
    }

    private fun update(next: ScrollDirection): ScrollDirection? {
        if (next == direction) return null
        direction = next
        return next
    }
}
