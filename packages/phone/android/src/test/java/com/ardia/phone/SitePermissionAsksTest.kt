package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SitePermissionAsksTest {
    private val camera = arrayOf("android.permission.CAMERA")

    private class World {
        val shown = HashSet<String>()
        val holding = HashMap<String, Boolean>()
        val asked = ArrayList<Pair<Array<String>, (Map<String, Boolean>) -> Unit>>()
        val answers = ArrayList<Pair<String, Boolean>>()
        val current = HashMap<String, Boolean>()
        val asks = SitePermissionAsks(visible = { it in shown }, held = { needed -> needed.associateWith { holding[it] == true } })

        fun gateOn() {
            asks.gate = { needed, done -> asked += needed to done }
        }

        fun request(pageId: String, needed: Array<String>) {
            current[pageId] = true
            asks.hold(SitePermissionAsks.Ask(pageId, needed, wanted = { current[pageId] == true }, granted = { held -> needed.all { held[it] == true } }) { granted -> answers += pageId to granted })
        }
    }

    @Test
    fun aBackgroundPageWaitsUntilItShowsBeforeAndroidAsks() {
        val world = World().apply { gateOn() }
        world.request("background", camera)
        assertEquals("a page not on screen never raises Android's dialog", 0, world.asked.size)
        world.shown += "background"
        world.asks.pump()
        assertEquals(1, world.asked.size)
        world.asked[0].second(mapOf("android.permission.CAMERA" to true))
        assertEquals(listOf("background" to true), world.answers)
    }

    @Test
    fun asksRunOneAtATimeInOrder() {
        val world = World().apply { gateOn() }
        world.shown += listOf("a", "b")
        world.request("a", camera)
        world.request("b", camera)
        assertEquals(1, world.asked.size)
        world.asked[0].second(mapOf("android.permission.CAMERA" to false))
        assertEquals(2, world.asked.size)
        world.asked[1].second(mapOf("android.permission.CAMERA" to true))
        assertEquals(listOf("a" to false, "b" to true), world.answers)
    }

    @Test
    fun closingAPageDropsItsQueuedAskAndIgnoresALateAnswer() {
        val world = World().apply { gateOn() }
        world.shown += listOf("a", "b")
        world.request("a", camera)
        world.request("b", camera)
        world.asks.drop("b")
        world.asks.drop("a")
        world.asked[0].second(mapOf("android.permission.CAMERA" to true))
        assertTrue("neither closed page hears back", world.answers.isEmpty())
        assertEquals("b's queued ask never reached Android", 1, world.asked.size)
        assertEquals(0, world.asks.pending)
    }

    @Test
    fun aRequestTheSiteWithdrewIsNeverAsked() {
        val world = World().apply { gateOn() }
        world.request("a", camera)
        world.current["a"] = false
        world.shown += "a"
        world.asks.pump()
        assertEquals(0, world.asked.size)
        assertEquals(0, world.asks.pending)
    }

    @Test
    fun anAskLostToRecreationIsAskedAgainAndALateFirstAnswerStillCountsOnce() {
        val world = World().apply { gateOn() }
        world.shown += "a"
        world.request("a", camera)
        world.asks.lost()
        world.asks.gate = null
        assertEquals(1, world.asks.pending)
        world.gateOn()
        assertEquals("the new gate asks again", 2, world.asked.size)
        world.asked[0].second(mapOf("android.permission.CAMERA" to true))
        world.asked[1].second(mapOf("android.permission.CAMERA" to true))
        assertEquals("first answer wins", listOf("a" to true), world.answers)
    }

    @Test
    fun aLostAskWhoseFirstAnswerArrivesBeforeTheNextPumpIsNotAskedAgain() {
        val world = World().apply { gateOn() }
        world.shown += "a"
        world.request("a", camera)
        world.asks.lost()
        world.asked[0].second(mapOf("android.permission.CAMERA" to true))
        world.asks.pump()
        assertEquals(1, world.asked.size)
        assertEquals(listOf("a" to true), world.answers)
    }

    @Test
    fun aLostAskGrantedMeanwhileGoesThroughWithoutASecondDialog() {
        val world = World().apply { gateOn() }
        world.shown += "a"
        world.request("a", camera)
        world.asks.gate = null
        world.asks.lost()
        world.holding["android.permission.CAMERA"] = true
        world.gateOn()
        assertEquals(1, world.asked.size)
        assertEquals(listOf("a" to true), world.answers)
    }

    @Test
    fun theSameRequestHeldAgainIsRecognisedSoItIsNotLoggedOrQueuedTwice() {
        val world = World().apply { gateOn() }
        val request = Any()
        world.current["a"] = true
        val ask = SitePermissionAsks.Ask("a", camera, wanted = { world.current["a"] == true }, granted = { false }, request = request) {}
        world.asks.hold(ask)
        assertTrue(world.asks.holds("a", request))
        assertFalse("another request from the same page is a new one", world.asks.holds("a", Any()))
        world.shown += "a"
        world.asks.pump()
        assertTrue("still held while Android is asked", world.asks.holds("a", request))
        world.asked[0].second(emptyMap())
        assertFalse(world.asks.holds("a", request))
    }

    @Test
    fun withNoGateAskIsHeldUntilOneArrives() {
        val world = World()
        world.shown += "a"
        world.request("a", camera)
        assertEquals(1, world.asks.pending)
        world.gateOn()
        assertEquals(1, world.asked.size)
    }
}
