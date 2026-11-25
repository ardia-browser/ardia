package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ImageMemoryTest {
    @Test
    fun aCloseSaysWhyItDroppedNothing() {
        assertTrue(ImageMemory.closeSummary(0, 0).startsWith("no snapshot files left"))
        assertEquals("2 snapshot file(s), none decoded in memory", ImageMemory.closeSummary(2, 0))
        assertEquals("2 snapshot file(s), dropped 3 decoded", ImageMemory.closeSummary(2, 3))
    }
}
