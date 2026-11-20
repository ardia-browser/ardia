package com.ardia.phone

import android.view.InputDevice
import android.view.MotionEvent
import com.ardia.browsing.PagePinch
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PagePinchWatcherTest {
    private data class Finger(val id: Int, val x: Float, val y: Float)

    private var time = 0L
    private var scale = 2.625f
    private var atRest = true
    private var document = 3L
    private val pending = mutableListOf<() -> Unit>()
    private var fired = 0

    private val watcher = PagePinchWatcher(
        density = 2.625f,
        moment = { PagePinch.Moment("p1", document, scale, isVisible = true, isLoading = false, isDragging = false) },
        measureRest = { done -> done(atRest, scale) },
        later = { _, run -> pending += run },
    ) { fired++ }

    private fun event(action: Int, fingers: List<Finger>, index: Int = 0): MotionEvent {
        val properties = fingers.map { finger -> MotionEvent.PointerProperties().apply { id = finger.id; toolType = MotionEvent.TOOL_TYPE_FINGER } }.toTypedArray()
        val coordinates = fingers.map { finger -> MotionEvent.PointerCoords().apply { x = finger.x; y = finger.y; pressure = 1f; size = 1f } }.toTypedArray()
        val masked = if (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_POINTER_UP) action or (index shl MotionEvent.ACTION_POINTER_INDEX_SHIFT) else action
        time += 16
        return MotionEvent.obtain(0L, time, masked, fingers.size, properties, coordinates, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
    }

    private fun send(action: Int, fingers: List<Finger>, index: Int = 0) {
        val made = event(action, fingers, index)
        watcher.observe(made)
        made.recycle()
    }

    private fun pinchIn(firstId: Int = 0, secondId: Int = 1, endsWith: Float = 300f) {
        val start = listOf(Finger(firstId, 140f, 1000f), Finger(secondId, 940f, 1000f))
        send(MotionEvent.ACTION_DOWN, start.take(1))
        send(MotionEvent.ACTION_POINTER_DOWN, start, index = 1)
        val half = (940f - 140f) / 2f
        for (step in 1..4) {
            val gap = half - (half - endsWith / 2f) * step / 4f
            send(MotionEvent.ACTION_MOVE, listOf(Finger(firstId, 540f - gap, 1000f), Finger(secondId, 540f + gap, 1000f)))
        }
        val end = listOf(Finger(firstId, 540f - endsWith / 2f, 1000f), Finger(secondId, 540f + endsWith / 2f, 1000f))
        send(MotionEvent.ACTION_POINTER_UP, end, index = 1)
    }

    private fun settle() {
        val due = pending.toList()
        pending.clear()
        due.forEach { it() }
    }

    @Test
    fun aDeliberatePinchInOpensOnceAfterItSettles() {
        pinchIn()
        assertEquals(0, fired)
        send(MotionEvent.ACTION_UP, listOf(Finger(0, 390f, 1000f)))
        settle()
        assertEquals(1, fired)
    }

    @Test
    fun followsTheTwoFingersByPointerIdNotByIndex() {
        pinchIn(firstId = 4, secondId = 7)
        settle()
        assertEquals(1, fired)
    }

    @Test
    fun aNewTouchBeforeTheOpenSettlesCancelsIt() {
        pinchIn()
        send(MotionEvent.ACTION_UP, listOf(Finger(0, 390f, 1000f)))
        send(MotionEvent.ACTION_DOWN, listOf(Finger(0, 500f, 500f)))
        settle()
        assertEquals(0, fired)
    }

    @Test
    fun aCancelAfterTheFingersLiftedCancelsTheOpen() {
        pinchIn()
        send(MotionEvent.ACTION_CANCEL, listOf(Finger(0, 390f, 1000f)))
        settle()
        assertEquals(0, fired)
    }

    @Test
    fun aReplacementFingerBeforeTheOpenSettlesCancelsIt() {
        pinchIn()
        send(MotionEvent.ACTION_POINTER_DOWN, listOf(Finger(0, 390f, 1000f), Finger(2, 680f, 1000f)), index = 1)
        settle()
        assertEquals(0, fired)
    }

    @Test
    fun aThirdFingerAbandonsThePinch() {
        val start = listOf(Finger(0, 140f, 1000f), Finger(1, 940f, 1000f))
        send(MotionEvent.ACTION_DOWN, start.take(1))
        send(MotionEvent.ACTION_POINTER_DOWN, start, index = 1)
        send(MotionEvent.ACTION_MOVE, listOf(Finger(0, 400f, 1000f), Finger(1, 680f, 1000f)))
        send(MotionEvent.ACTION_POINTER_DOWN, listOf(Finger(0, 400f, 1000f), Finger(1, 680f, 1000f), Finger(2, 540f, 1400f)), index = 2)
        send(MotionEvent.ACTION_POINTER_UP, listOf(Finger(0, 400f, 1000f), Finger(1, 680f, 1000f), Finger(2, 540f, 1400f)), index = 2)
        send(MotionEvent.ACTION_POINTER_UP, listOf(Finger(0, 400f, 1000f), Finger(1, 680f, 1000f)), index = 1)
        settle()
        assertEquals(0, fired)
    }

    @Test
    fun aShallowPinchOrOneTheWebViewZoomedNeverOpens() {
        pinchIn(endsWith = 700f)
        settle()
        assertEquals(0, fired)
        val start = listOf(Finger(0, 140f, 1000f), Finger(1, 940f, 1000f))
        send(MotionEvent.ACTION_DOWN, start.take(1))
        send(MotionEvent.ACTION_POINTER_DOWN, start, index = 1)
        scale = 1.4f
        send(MotionEvent.ACTION_MOVE, listOf(Finger(0, 390f, 1000f), Finger(1, 690f, 1000f)))
        send(MotionEvent.ACTION_POINTER_UP, listOf(Finger(0, 390f, 1000f), Finger(1, 690f, 1000f)), index = 1)
        settle()
        assertEquals(0, fired)
    }

    @Test
    fun aPinchFromAZoomedInPageOrAcrossANavigationNeverOpens() {
        atRest = false
        pinchIn()
        settle()
        assertEquals(0, fired)
        atRest = true
        pinchIn()
        document = 4L
        settle()
        assertEquals(0, fired)
    }

    @Test
    fun aResetDropsAPendingOpen() {
        pinchIn()
        watcher.reset()
        settle()
        assertEquals(0, fired)
    }
}
