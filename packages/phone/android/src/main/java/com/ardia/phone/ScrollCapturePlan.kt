package com.ardia.phone

import kotlin.math.floor

internal object ScrollCapturePlan {
    const val LANDING_TOLERANCE = 2
    private const val MAX_PAGE_HEIGHT = Int.MAX_VALUE / 4

    data class Tile(val sourceTop: Int, val rows: Int, val top: Int, val bottom: Int)

    fun pageHeight(reported: Double, viewport: Int): Int {
        if (viewport <= 0) return 0
        if (!reported.isFinite() || reported <= viewport) return viewport
        return minOf(floor(reported), MAX_PAGE_HEIGHT.toDouble()).toInt()
    }

    fun withinStart(areaTop: Int, areaBottom: Int, viewport: Int): Boolean = areaTop >= 0 && areaBottom <= viewport && areaTop < areaBottom

    fun scrollFor(start: Int, areaTop: Int, areaBottom: Int, viewport: Int, pageHeight: Int): Int {
        if (withinStart(areaTop, areaBottom, viewport)) return start
        val bottom = maxOf(0, pageHeight - viewport)
        return (start.toLong() + areaTop).coerceIn(0L, bottom.toLong()).toInt()
    }

    fun tile(start: Int, areaTop: Int, areaBottom: Int, landed: Int, viewport: Int, pageHeight: Int): Tile? {
        if (viewport <= 0 || areaBottom <= areaTop) return null
        val wantedTop = start.toLong() + areaTop
        val wantedBottom = start.toLong() + areaBottom
        val top = maxOf(wantedTop, landed.toLong(), 0L)
        val bottom = minOf(wantedBottom, landed.toLong() + viewport, pageHeight.toLong())
        if (bottom <= top) return null
        return Tile((top - landed).toInt(), (bottom - top).toInt(), (top - start).toInt(), (bottom - start).toInt())
    }

    fun landedWhereAsked(scriptLanded: Int, scale: Double, drawnScroll: Int): Boolean {
        if (!scale.isFinite() || scale <= 0) return false
        return kotlin.math.abs(scriptLanded * scale - drawnScroll) <= LANDING_TOLERANCE + scale
    }

    fun presented(syncResult: Int?): Boolean = syncResult != null && (syncResult and NOT_PRESENTED) == 0

    private const val NOT_PRESENTED = android.graphics.HardwareRenderer.SYNC_LOST_SURFACE_REWARD_IF_FOUND or android.graphics.HardwareRenderer.SYNC_CONTEXT_IS_STOPPED or android.graphics.HardwareRenderer.SYNC_FRAME_DROPPED

    fun cssPixels(y: Int, scale: Double): String {
        val css = if (scale.isFinite() && scale > 0) y / scale else y.toDouble()
        return if (css.isFinite()) String.format(java.util.Locale.US, "%.3f", maxOf(0.0, css)) else "0"
    }
}
