package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test

class LabTouchesTest {
    @Test
    fun aScriptKeepsItsPointWhenALaterStepOmitsItAndPlaysInTimeOrder() {
        val steps = LabTouches.parse("45:u; 0:d:132:2275; 60:d:540:400;80:m:560:420;120:u")
        assertEquals(listOf(0L, 45L, 60L, 80L, 120L), steps.map { it.at })
        assertEquals(listOf('d', 'u', 'd', 'm', 'u'), steps.map { it.kind })
        assertEquals(132f, steps[1].x)
        assertEquals(2275f, steps[1].y)
        assertEquals(560f, steps[4].x)
        assertEquals(420f, steps[4].y)
    }
}
