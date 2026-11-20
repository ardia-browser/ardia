package com.ardia.phone

import android.app.Activity
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CoverHandOverTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    private val card = View(activity)
    private val timers = ArrayList<Pair<Long, () -> Unit>>()
    private var cancelled = 0
    private val hidden = ArrayList<Pair<String, Boolean>>()

    private val surface = object : CoverSurface {
        override fun find(nativeId: String): View? = if (nativeId == "openingCard") card else null

        override fun schedule(millis: Long, run: () -> Unit): () -> Unit {
            timers += millis to run
            return { cancelled += 1 }
        }
    }

    private val handOver = CoverHandOver(surface) { reason, found -> hidden += reason to found }

    @Test
    fun theCardIsHiddenInTheFrameThePageReportsDrawn() {
        handOver.cover("openingCard")
        handOver.pageVisible()
        assertEquals("the cap starts when the page shows", listOf(CoverHandOver.CAP_MILLIS), timers.map { it.first })
        handOver.pageDrawn()
        assertEquals(View.INVISIBLE, card.visibility)
        assertEquals(listOf(CoverHandOver.REASON_DRAWN to true), hidden)
        assertEquals("the cap is cancelled", 1, cancelled)
        handOver.pageDrawn()
        assertEquals("once", 1, hidden.size)
    }

    @Test
    fun aSlowPageCantHoldTheCardPastTheCap() {
        handOver.cover("openingCard")
        handOver.pageVisible()
        assertEquals(View.VISIBLE, card.visibility)
        timers.single().second()
        assertEquals(View.INVISIBLE, card.visibility)
        assertEquals(listOf(CoverHandOver.REASON_CAP to true), hidden)
        handOver.pageDrawn()
        assertEquals("the late drawn frame hides nothing more", 1, hidden.size)
    }

    @Test
    fun anOpenCancelledFirstHidesNothing() {
        handOver.cover("openingCard")
        handOver.pageVisible()
        handOver.cover(null)
        assertEquals("the cap is cancelled", 1, cancelled)
        handOver.pageDrawn()
        assertEquals(View.VISIBLE, card.visibility)
        assertTrue(hidden.isEmpty())
    }

    @Test
    fun aPageClosedFirstHidesNothing() {
        handOver.cover("openingCard")
        handOver.pageVisible()
        handOver.cancel()
        assertFalse(handOver.waiting)
        assertEquals(View.VISIBLE, card.visibility)
        assertTrue(hidden.isEmpty())
    }

    @Test
    fun withoutACoverNothingWaitsOrHides() {
        handOver.pageVisible()
        handOver.pageDrawn()
        assertTrue(timers.isEmpty())
        assertTrue(hidden.isEmpty())
    }

    @Test
    fun aCoverThatIsntThereIsReportedNotFound() {
        handOver.cover("gone")
        handOver.pageVisible()
        handOver.pageDrawn()
        assertEquals(listOf(CoverHandOver.REASON_DRAWN to false), hidden)
    }

    @Test
    fun aNewCoverWaitsForItsOwnPageAgain() {
        handOver.cover("openingCard")
        handOver.pageVisible()
        handOver.pageDrawn()
        handOver.cover("next")
        assertFalse(handOver.handedOver)
        handOver.pageVisible()
        assertTrue(handOver.waiting)
    }
}
