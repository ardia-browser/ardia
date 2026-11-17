package com.ardia.phone

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PendingCountsConsentTest {
    private val app = RuntimeEnvironment.getApplication()

    @After
    fun real() {
        PendingCounts.storeForTests = null
    }

    @Test
    fun theLabCanReadThePendingCountsAndTheConsentWithoutTakingThem() {
        UsageConsent.set(app, true)
        val (sharing, generation) = UsageConsent.state(app)
        assertEquals(true, sharing)
        PendingCounts.add(app, PendingCounts.TABS_SENT, UsageConsent.window(app))
        assertEquals(mapOf("tabs_sent" to 1), PendingCounts.peek(app))
        assertEquals("a peek leaves the count for the next take", mapOf("tabs_sent" to 1), PendingCounts.take(app))
        UsageConsent.set(app, false)
        assertEquals(false to generation + 1, UsageConsent.state(app))
    }

    @Test
    fun aSendWhileSharingIsOffIsNeverCounted() {
        UsageConsent.set(app, false)
        PendingCounts.add(app, PendingCounts.TABS_SENT, UsageConsent.window(app))
        assertEquals(emptyMap<String, Int>(), PendingCounts.take(app))
    }

    @Test
    fun aSendCountsOnlyInTheConsentingGenerationItStartedIn() {
        UsageConsent.set(app, true)
        val started = UsageConsent.window(app)
        PendingCounts.add(app, PendingCounts.TABS_SENT, started)
        assertEquals(mapOf("tabs_sent" to 1), PendingCounts.take(app))
        val inFlight = UsageConsent.window(app)
        UsageConsent.set(app, false)
        UsageConsent.set(app, true)
        PendingCounts.add(app, PendingCounts.TABS_SENT, inFlight)
        assertEquals("sharing went off and on again while it was in flight", emptyMap<String, Int>(), PendingCounts.take(app))
    }

    @Test
    fun turningSharingOffClearsWhatWasPending() {
        UsageConsent.set(app, true)
        PendingCounts.add(app, PendingCounts.TABS_SENT, UsageConsent.window(app))
        UsageConsent.set(app, false)
        UsageConsent.set(app, true)
        assertEquals(emptyMap<String, Int>(), PendingCounts.take(app))
    }

    @Test
    fun aClearThatFailsHandsNothingOverSoACountCanBeLostButNeverDoubled() {
        val kept = HashMap<String, Int>()
        PendingCounts.storeForTests = object : PendingCounts.Store {
            override fun all(): Map<String, Int> = kept.toMap()
            override fun add(field: String, by: Int): Boolean {
                kept[field] = (kept[field] ?: 0) + by
                return true
            }
            override fun clear(): Boolean = false
        }
        UsageConsent.set(app, true)
        PendingCounts.add(app, PendingCounts.TABS_SENT, UsageConsent.window(app))
        assertEquals(emptyMap<String, Int>(), PendingCounts.take(app))
        assertEquals(mapOf("tabs_sent" to 1), kept)
    }
}
