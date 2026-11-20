package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PageSettleTest {
    @Test
    fun aHistorySwipeSettlesWithoutBounceInTheIPhonesQuarterSecond() {
        val swipe = PageSettle.swipe
        assertEquals(1.0, swipe.progress(swipe.durationMillis / 1000.0), 0.002)
        assertTrue("never passes its end", (0..30).map { swipe.progress(it / 100.0) }.max() <= 1.0)
        assertTrue("settles in ${swipe.durationMillis} ms, as UIKit's 0.22 s critically damped spring", swipe.durationMillis in 200L..240L)
        assertTrue("moves fastest at the start, as the finger lets go", swipe.progress(0.05) > 0.4)
        assertEquals(1f, swipe.interpolator.getInterpolation(1f), 0.002f)
    }

    @Test
    fun thePullSettlesWithoutBounce() {
        val pull = PageSettle.pull
        assertEquals(0.0, pull.progress(0.0), 1e-9)
        assertEquals(1.0, pull.progress(pull.durationMillis / 1000.0), 0.002)
        assertTrue("never passes its end", (0..60).map { pull.progress(it / 100.0) }.max() <= 1.0)
        assertTrue("settles in ${pull.durationMillis} ms, between a quarter and two thirds of a second", pull.durationMillis in 250L..650L)
        assertEquals(1f, pull.interpolator.getInterpolation(1f), 0.002f)
    }
}
