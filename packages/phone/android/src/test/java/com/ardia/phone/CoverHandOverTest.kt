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
    private val hidden = ArrayList<Triple<Boolean, String, Long>>()

    private val surface = object : CoverSurface {
        override fun find(nativeId: String): View? = if (nativeId == "openingCard") card else null
    }

    private val handOver = CoverHandOver(surface) { found, cover, document -> hidden += Triple(found, cover, document) }

    @Test
    fun theCardIsHiddenInTheFrameThePageReportsDrawnNamingItsCoverAndDocument() {
        handOver.cover("openingCard")
        handOver.pageDrawn(4)
        assertEquals(View.INVISIBLE, card.visibility)
        assertEquals(listOf(Triple(true, "openingCard", 4L)), hidden)
        handOver.pageDrawn(5)
        assertEquals("once", 1, hidden.size)
    }

    @Test
    fun nothingButADrawnPageHidesTheCoverHoweverLongItTakes() {
        handOver.cover("openingCard")
        assertEquals(View.VISIBLE, card.visibility)
        assertTrue(hidden.isEmpty())
        assertFalse(handOver.handedOver)
    }

    @Test
    fun anOpenCancelledFirstHidesNothing() {
        handOver.cover("openingCard")
        handOver.cover(null)
        handOver.pageDrawn(1)
        assertEquals(View.VISIBLE, card.visibility)
        assertTrue(hidden.isEmpty())
    }

    @Test
    fun withoutACoverNothingHides() {
        handOver.pageDrawn(1)
        assertTrue(hidden.isEmpty())
    }

    @Test
    fun aCoverThatIsntMountedYetIsReportedNotFoundAndStillWaitsForItsView() {
        handOver.cover("gone")
        handOver.pageDrawn(2)
        assertEquals(listOf(Triple(false, "gone", 2L)), hidden)
        assertFalse(handOver.handedOver)
        handOver.cover("openingCard")
        handOver.pageDrawn(3)
        assertEquals(Triple(true, "openingCard", 3L), hidden.last())
        assertTrue(handOver.handedOver)
    }

    @Test
    fun aNewCoverWaitsForItsOwnPageAgain() {
        handOver.cover("openingCard")
        handOver.pageDrawn(1)
        handOver.cover("next")
        assertFalse(handOver.handedOver)
    }
}
