package com.ardia.phone

import android.graphics.Rect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GlassPathsTest {
    private fun choose(
        onlyBackdropUnder: Boolean = false,
        blurOverBackdrop: Boolean = false,
        holdsPage: Boolean = false,
        pageMode: FrostSources.PageMode = FrostSources.PageMode.Solid,
        budgetDegraded: Boolean = false,
        blurSupported: Boolean = true,
        insideSource: Boolean = false,
        hasSource: Boolean = true,
    ) = FrostPage.choose(
        blurSupported = blurSupported,
        reduceTransparency = false,
        budgetDegraded = budgetDegraded,
        onlyBackdropUnder = onlyBackdropUnder,
        blurOverBackdrop = blurOverBackdrop,
        hasSource = hasSource,
        sourceHasContent = true,
        hardware = true,
        insideSource = insideSource,
        holdsPage = holdsPage,
        pageMode = pageMode,
    )

    private fun glassPageMode(sdk: Int) = if (LiquidGlassRules.pageLive(sdk, classic = false)) FrostSources.PageMode.Live else FrostSources.PageMode.Solid

    private fun glassOverBackdrop(sdk: Int) = LiquidGlassRules.samplesBackdrop(sdk, classic = false, flat = false, lensFailed = false)

    @After
    fun forgetCount() {
        GlassCounts.onUnsourced = null
    }

    @Test
    fun glassOverThePageIsLiveOnAndroid13WhileAFrostKeepsTheSolidPageMode() {
        assertEquals(FrostPage.Path.Live, choose(holdsPage = true, pageMode = glassPageMode(34)).path)
        assertEquals("Android 12's glass has no lens to pay for the recording", FrostPage.Path.Solid, choose(holdsPage = true, pageMode = glassPageMode(32)).path)
        assertEquals("the search tray's thin frost still follows the solid page mode", FrostPage.Path.Solid, choose(holdsPage = true, pageMode = FrostSources.pageMode).path)
        assertEquals(false, FrostPage.wantsSource(null, onlyBackdropUnder = false, blurOverBackdrop = false, holdsPage = true, pageMode = glassPageMode(32)))
        assertEquals(true, FrostPage.wantsSource(null, onlyBackdropUnder = false, blurOverBackdrop = false, holdsPage = true, pageMode = glassPageMode(34)))
    }

    @Test
    fun aPhoneOverTheLookBudgetDrawsTheFlatFillUnderEveryGlass() {
        val degraded = choose(holdsPage = true, pageMode = glassPageMode(34), budgetDegraded = true)
        assertEquals(FrostPage.Path.Fallback, degraded.path)
        assertTrue(degraded.reason.startsWith("look budget"))
        assertEquals(FrostPage.Path.Fallback, choose(onlyBackdropUnder = true, blurOverBackdrop = glassOverBackdrop(34), budgetDegraded = true).path)
    }

    @Test
    fun glassOverTheDeckBackdropBlursAndLensesItWhileAFrostKeepsTheTintedFill() {
        assertEquals(FrostPage.Path.Live, choose(onlyBackdropUnder = true, blurOverBackdrop = glassOverBackdrop(34)).path)
        assertEquals(true, FrostPage.wantsSource(null, onlyBackdropUnder = true, blurOverBackdrop = glassOverBackdrop(34), holdsPage = false, pageMode = FrostSources.PageMode.Solid))
        assertEquals(FrostPage.Path.Tinted, choose(onlyBackdropUnder = true, blurOverBackdrop = glassOverBackdrop(32)).path)
        assertEquals("a frost variant over the backdrop", FrostPage.Path.Tinted, choose(onlyBackdropUnder = true, blurOverBackdrop = false).path)
        assertEquals("below Android 12 the tinted fill still stands in", FrostPage.Path.Tinted, choose(onlyBackdropUnder = true, blurOverBackdrop = true, blurSupported = false).path)
    }

    @Test
    fun onlyAMissingOrEnclosingSourceCountsAsAGlassLeftWithNothingToSample() {
        assertTrue(FrostPage.unsourced(choose(insideSource = true)))
        assertTrue(FrostPage.unsourced(choose(hasSource = false)))
        assertFalse(FrostPage.unsourced(choose(budgetDegraded = true)))
        assertFalse(FrostPage.unsourced(choose(holdsPage = true)))
        assertFalse(FrostPage.unsourced(choose(onlyBackdropUnder = true)))
        assertFalse(FrostPage.unsourced(null))
    }

    private class Clock {
        val waiting = mutableListOf<Runnable>()
        fun schedule(job: Runnable, @Suppress("UNUSED_PARAMETER") delay: Long) {
            waiting += job
        }
        fun cancel(job: Runnable) {
            waiting.remove(job)
        }
        fun run() {
            val due = waiting.toList()
            waiting.clear()
            due.forEach(Runnable::run)
        }
    }

    @Test
    fun aGlassLeftUnsourcedIsCountedOnceAndOnlyIfItStaysThatWay() {
        var counted = 0
        GlassCounts.onUnsourced = { counted += 1 }
        val clock = Clock()
        var unsourced = true
        val watch = UnsourcedWatch(clock::schedule, clock::cancel) { unsourced }
        val inside = choose(insideSource = true)
        watch.settled(inside)
        watch.settled(choose(hasSource = false))
        assertEquals("one wait however often it settles there", 1, clock.waiting.size)
        clock.run()
        assertEquals(1, counted)
        watch.settled(choose(holdsPage = true))
        watch.settled(inside)
        clock.run()
        assertEquals("a glass is counted once for its whole life", 1, counted)
        assertTrue(watch.counted)

        val brief = UnsourcedWatch(clock::schedule, clock::cancel) { unsourced }
        brief.settled(choose(hasSource = false))
        brief.settled(choose(holdsPage = true, pageMode = FrostSources.PageMode.Live))
        assertEquals("its source arrived before the wait ended", 0, clock.waiting.size)
        brief.settled(inside)
        unsourced = false
        clock.run()
        assertEquals("by the time the wait ended it had a source", 1, counted)
        assertFalse(brief.counted)

        val detached = UnsourcedWatch(clock::schedule, clock::cancel) { true }
        detached.settled(inside)
        detached.stop()
        assertEquals(0, clock.waiting.size)
    }

    @Test
    fun theSharedStripSnapsToTheScaleGridAndStaysInsideItsSource() {
        val placed = FrostStrip.place(Rect(-30, 2101, 1110, 2460), 1080, 2400, 5f)
        assertEquals(Rect(0, 2100, 1080, 2400), placed)
        assertEquals("its left and top land on whole layer pixels, so no glass's backdrop shifts with the strip", 0, placed.top % 5)
        val inner = FrostStrip.place(Rect(13, 17, 200, 300), 1080, 2400, 4f)
        assertEquals(Rect(12, 16, 200, 300), inner)
        val outside = FrostStrip.place(Rect(1200, 2500, 1300, 2600), 1080, 2400, 4f)
        assertEquals("a strip wholly outside its source is empty", 0, outside.width() * outside.height())
    }
}
