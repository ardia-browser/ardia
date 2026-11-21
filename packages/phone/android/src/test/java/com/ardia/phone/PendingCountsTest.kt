package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PendingCountsTest {
    private val app = RuntimeEnvironment.getApplication()

    @Test
    fun sendsMadeWhileTheAppWasNotRunningWaitUntilItTakesThemOnce() {
        UsageConsent.set(app, true)
        assertEquals(emptyMap<String, Int>(), PendingCounts.take(app))
        PendingCounts.add(app, PendingCounts.TABS_SENT, UsageConsent.window(app))
        PendingCounts.add(app, PendingCounts.TABS_SENT, UsageConsent.window(app))
        assertEquals(mapOf("tabs_sent" to 2), PendingCounts.take(app))
        assertEquals("taken once, then empty", emptyMap<String, Int>(), PendingCounts.take(app))
    }
}
