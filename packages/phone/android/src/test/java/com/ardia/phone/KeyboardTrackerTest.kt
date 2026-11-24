package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class KeyboardTrackerTest {
    private val heard = ArrayList<String>()
    private val tracker = KeyboardTracker(density = 2.75f, willChange = { heard += "will ${it.source}->${it.target} in ${it.durationMs} nav ${it.navigationBar}" }, didChange = { heard += "did ${it.height}" })

    @Test
    fun theTargetIsKnownWhenTheAnimationStartsNotWhenItEnds() {
        tracker.prepare(sourcePx = 0, navigationPx = 132)
        tracker.start(targetPx = 880, durationMs = 285)
        assertEquals(listOf("will 0.0->320.0 in 285 nav 48.0"), heard)
        tracker.end(nowPx = 880)
        assertEquals(listOf("will 0.0->320.0 in 285 nav 48.0", "did 320.0"), heard)
    }

    @Test
    fun theFirstKeyboardOfAProcessIsReportedLikeAnyOther() {
        tracker.prepare(sourcePx = 0, navigationPx = 0)
        tracker.start(targetPx = 770, durationMs = 300)
        tracker.end(nowPx = 770)
        tracker.prepare(sourcePx = 770, navigationPx = 0)
        tracker.start(targetPx = 0, durationMs = 250)
        tracker.end(nowPx = 0)
        assertEquals(listOf("will 0.0->280.0 in 300 nav 0.0", "did 280.0", "will 280.0->0.0 in 250 nav 0.0", "did 0.0"), heard)
    }

    @Test
    fun aChangeWithoutAnAnimationStillEndsInOneDidChangeAndRepeatsAreDropped() {
        tracker.settled(nowPx = 550, navigationPx = 0)
        tracker.settled(nowPx = 550, navigationPx = 0)
        tracker.prepare(sourcePx = 550, navigationPx = 0)
        tracker.start(targetPx = 550, durationMs = 200)
        tracker.end(nowPx = 550)
        assertEquals(listOf("did 200.0"), heard)
        assertEquals(KeyboardTracker.Did(200.0, 0.0), tracker.current())
    }
}
