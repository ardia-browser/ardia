package com.ardia.phone

import android.view.MotionEvent
import com.ardia.browsing.PagePinch
import kotlin.math.hypot

internal class PagePinchWatcher(
    private val density: Float,
    private val isOn: () -> Boolean,
    private val moment: () -> PagePinch.Moment?,
    private val measureRest: ((Boolean, Float) -> Unit) -> Unit,
    private val later: (Long, () -> Unit) -> Unit,
    private val onPinchedIn: () -> Unit,
) {
    private var pinch: PagePinch? = null
    private var first = INVALID
    private var second = INVALID
    private var startSpan = 0f
    private var abandoned = false
    private var generation = 0L

    fun observe(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                generation++
                pinch = null
                abandoned = false
                first = event.getPointerId(0)
                second = INVALID
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (abandoned || pinch != null || event.pointerCount != 2) return reset()
                if (!isOn()) return abandon()
                val index = event.actionIndex
                second = event.getPointerId(index)
                first = event.getPointerId(if (index == 0) 1 else 0)
                startSpan = span(event) ?: return abandon()
                if (startSpan < PagePinch.MINIMUM_SPAN_DP * density) return abandon()
                val started = moment()?.let { PagePinch.begin(it) } ?: return abandon()
                pinch = started
                val asked = generation
                measureRest { atRest, scale -> if (asked == generation) started.measuredStart(atRest, scale) }
            }
            MotionEvent.ACTION_MOVE -> {
                val current = pinch ?: return
                val now = span(event) ?: return abandon()
                current.moved(now / startSpan.toDouble())
            }
            MotionEvent.ACTION_POINTER_UP -> {
                val current = pinch ?: return
                val lifted = event.getPointerId(event.actionIndex)
                if (lifted != first && lifted != second) return abandon()
                span(event)?.let { current.moved(it / startSpan.toDouble()) }
                pinch = null
                abandoned = true
                ended(current)
            }
            MotionEvent.ACTION_UP -> {
                pinch = null
                abandoned = false
            }
            MotionEvent.ACTION_CANCEL -> {
                generation++
                abandon()
            }
        }
    }

    fun reset() {
        generation++
        abandon()
    }

    private fun abandon() {
        pinch = null
        abandoned = true
    }

    private fun ended(finished: PagePinch) {
        if (!finished.isDeliberate(PagePinch.Ending.Ended)) return
        val asked = generation
        later(PagePinch.SETTLE_MILLIS) {
            if (asked != generation || !isOn() || moment() == null) return@later
            measureRest { atRest, _ ->
                if (asked != generation || !isOn()) return@measureRest
                val now = moment() ?: return@measureRest
                if (finished.fires(PagePinch.Ending.Ended, now, atRest)) onPinchedIn()
            }
        }
    }

    private fun span(event: MotionEvent): Float? {
        val a = event.findPointerIndex(first)
        val b = event.findPointerIndex(second)
        if (a < 0 || b < 0) return null
        return hypot(event.getX(a) - event.getX(b), event.getY(a) - event.getY(b))
    }

    private companion object {
        const val INVALID = -1
    }
}
