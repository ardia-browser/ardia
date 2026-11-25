package com.ardia.browsing

import kotlin.math.abs
import org.json.JSONArray

class PagePinch private constructor(val page: String, val document: Long, val webScale: Float) {
    enum class Ending { Ended, Cancelled }

    data class Moment(val page: String, val document: Long, val webScale: Float, val isVisible: Boolean, val isLoading: Boolean, val isDragging: Boolean)

    var smallestScale = 1.0
        private set
    var largestScale = 1.0
        private set
    var lastScale = 1.0
        private set
    var startedAtMinimum: Boolean? = null
        private set

    fun measuredStart(atRest: Boolean, scaleWhenMeasured: Float) {
        if (startedAtMinimum != null) return
        startedAtMinimum = atRest && keptZoom(webScale, scaleWhenMeasured)
    }

    fun moved(scale: Double) {
        if (!scale.isFinite() || scale <= 0.0) return
        lastScale = scale
        smallestScale = minOf(smallestScale, scale)
        largestScale = maxOf(largestScale, scale)
    }

    val wentOutward: Boolean get() = largestScale > OUTWARD_TOLERANCE

    fun isDeliberate(ending: Ending): Boolean =
        ending == Ending.Ended && !wentOutward && lastScale <= TRIGGER_SCALE && lastScale <= smallestScale + REVERSAL_TOLERANCE

    fun fires(ending: Ending, moment: Moment, endsAtMinimum: Boolean): Boolean {
        if (!isDeliberate(ending) || startedAtMinimum != true || !endsAtMinimum) return false
        if (moment.page != page || moment.document != document || !moment.isVisible || moment.isLoading || moment.isDragging) return false
        return keptZoom(webScale, moment.webScale)
    }

    companion object {
        const val TRIGGER_SCALE = 0.7
        const val OUTWARD_TOLERANCE = 1.04
        const val REVERSAL_TOLERANCE = 0.12
        const val ZOOM_TOLERANCE = 0.02
        const val VIEWPORT_TOLERANCE = 0.01
        const val SETTLE_MILLIS = 120L
        const val MINIMUM_SPAN_DP = 24f

        const val VIEWPORT_SCRIPT =
            "(function(){var r=document.documentElement;var w=(r&&r.clientWidth)||window.innerWidth;var v=window.visualViewport;return [v?v.width:window.innerWidth,w];})()"

        fun begin(moment: Moment): PagePinch? {
            if (!moment.isVisible || moment.isLoading || moment.isDragging) return null
            if (!moment.webScale.isFinite() || moment.webScale <= 0f) return null
            return PagePinch(moment.page, moment.document, moment.webScale)
        }

        fun keptZoom(start: Float, end: Float): Boolean =
            start > 0f && end.isFinite() && end > 0f && abs(end / start - 1f) <= ZOOM_TOLERANCE

        fun restsAtMinimum(visualWidth: Double, layoutWidth: Double): Boolean =
            visualWidth.isFinite() && layoutWidth.isFinite() && visualWidth > 0.0 && layoutWidth > 0.0 && visualWidth * (1 + VIEWPORT_TOLERANCE) >= layoutWidth

        fun restsAtMinimum(evaluated: String?): Boolean {
            val raw = evaluated?.trim()?.takeIf { it.isNotEmpty() && it != "null" } ?: return false
            val text = if (raw.startsWith("\"")) runCatching { JSONArray("[$raw]").getString(0) }.getOrNull() ?: return false else raw
            val widths = runCatching { JSONArray(text) }.getOrNull() ?: return false
            if (widths.length() != 2) return false
            return restsAtMinimum(widths.optDouble(0, Double.NaN), widths.optDouble(1, Double.NaN))
        }
    }
}

class PageDocument {
    var generation = 0L
        private set
    private var url: String? = null
    private var loading = false
    private var seen = false

    fun saw(url: String?, isLoading: Boolean): Long {
        if (seen && (url != this.url || (isLoading && !loading))) generation++
        seen = true
        this.url = url
        loading = isLoading
        return generation
    }

    fun replaced(): Long {
        generation++
        return generation
    }
}
