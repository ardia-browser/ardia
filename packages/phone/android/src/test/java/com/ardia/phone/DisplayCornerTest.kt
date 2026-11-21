package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DisplayCornerTest {
    @Test
    fun theDisplaysCornerIsGivenInPointsAndNothingWhenTheSystemHasNone() {
        assertEquals(40.0, DisplayCorner.dp(110, 2.75f)!!, 1e-9)
        assertNull("before Android 12 or on a square screen the pager keeps its fixed corner", DisplayCorner.dp(null, 2.75f))
        assertNull(DisplayCorner.dp(0, 2.75f))
    }
}
