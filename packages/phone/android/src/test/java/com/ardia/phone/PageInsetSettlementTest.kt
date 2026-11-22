package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageInsetSettlementTest {
    @Test
    fun theViewportWaitsForTheToolbarToFinish() {
        val wait = PageInsetSettlement()
        wait.changed(52.0, 100)
        assertEquals(180L, wait.remaining(100, 180))
        assertEquals(0L, wait.remaining(280, 180))
    }

    @Test
    fun flingsKeepTheViewportStableAfterTheFingerLeaves() {
        val wait = PageInsetSettlement()
        wait.touching = true
        wait.changed(52.0, 100)
        assertTrue(wait.remaining(500, 180) > 0)
        wait.touching = false
        wait.scrolled(510)
        assertEquals(110L, wait.remaining(520, 180))
        wait.scrolled(600)
        assertEquals(120L, wait.remaining(600, 180))
        assertEquals(0L, wait.remaining(720, 180))
    }

    @Test
    fun aReversalReplacesThePendingEndpointAndCancellationKeepsTheLiveTouch() {
        val wait = PageInsetSettlement()
        wait.changed(52.0, 100)
        wait.changed(75.0, 160)
        assertEquals(75.0, wait.target!!, 0.0)
        assertEquals(180L, wait.remaining(160, 180))
        wait.touching = true
        wait.reset()
        assertNull(wait.target)
        assertTrue(wait.remaining(1000, 180) > 0)
    }
}
