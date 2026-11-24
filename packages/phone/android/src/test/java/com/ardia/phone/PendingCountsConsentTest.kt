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
    fun aGlassShaderFailureCountsOnlyInTheConsentingGenerationItHappenedIn() {
        val waiting = mutableListOf<() -> Unit>()
        val failed = PendingCounts.glassShaderFailures(app) { waiting += it }
        UsageConsent.set(app, true)
        failed()
        waiting.removeAt(0)()
        assertEquals(mapOf("glass_shaders_failed" to 1), PendingCounts.take(app))
        failed()
        UsageConsent.set(app, false)
        UsageConsent.set(app, true)
        waiting.removeAt(0)()
        assertEquals("sharing went off and on again before the count was written", emptyMap<String, Int>(), PendingCounts.take(app))
        UsageConsent.set(app, false)
        failed()
        assertEquals("a failure while sharing is off starts no write", 0, waiting.size)
        UsageConsent.set(app, true)
        assertEquals(emptyMap<String, Int>(), PendingCounts.take(app))
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
    fun sharingCannotTurnOffBetweenACountsConsentCheckAndItsWrite() {
        val kept = HashMap<String, Int>()
        var consentDuringTheWrite: Long? = null
        var turnOff: Thread? = null
        PendingCounts.storeForTests = object : PendingCounts.Store {
            override fun all(): Map<String, Int> = kept.toMap()
            override fun add(field: String, by: Int): Boolean {
                turnOff = Thread { UsageConsent.set(app, false) }.also { it.start() }
                turnOff!!.join(300)
                consentDuringTheWrite = UsageConsent.window(app)
                kept[field] = (kept[field] ?: 0) + by
                return true
            }
            override fun clear(): Boolean {
                kept.clear()
                return true
            }
        }
        UsageConsent.set(app, true)
        val window = UsageConsent.window(app)
        PendingCounts.add(app, PendingCounts.TABS_SENT, window)
        turnOff!!.join(5_000)
        assertEquals("the turn-off waited for the write it raced", window, consentDuringTheWrite)
        assertEquals(false, turnOff!!.isAlive)
        assertEquals(false to window!! + 1, UsageConsent.state(app))
        assertEquals("the turn-off cleared the count written before it", emptyMap<String, Int>(), PendingCounts.take(app))
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
