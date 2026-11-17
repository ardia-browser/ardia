package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SnappySpringTest {
    @Test
    fun thePullSettlesOnComposesSnappySpring() {
        assertEquals(0.0, SnappySpring.position(0.0), 1e-9)
        assertEquals(1.0, SnappySpring.position(SnappySpring.settleMillis / 1000.0), 0.002)
        assertTrue("it overshoots a little, as a 0.86 damped spring does", (0..60).map { SnappySpring.position(it / 100.0) }.max() > 1.0)
        assertTrue("settles in ${SnappySpring.settleMillis} ms, between a quarter and two thirds of a second", SnappySpring.settleMillis in 250L..650L)
        assertEquals(1f, SnappySpring.interpolator.getInterpolation(1f), 0.002f)
    }
}
