package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PageVisualsTest {
    private var now = 1_000L
    private val visuals = PageVisuals { now }

    @Test
    fun noPictureTakenThisLaunchIsUnknown() {
        assertNull(visuals.isCurrent("a"))
        visuals.changed("a", PageVisuals.Change.State)
        assertNull("a page that changed but was never captured has no picture to judge", visuals.isCurrent("a"))
    }

    @Test
    fun aPictureStaysCurrentUntilThePageChanges() {
        visuals.changed("a", PageVisuals.Change.State)
        visuals.captured("a", visuals.generation("a"))
        assertEquals(true, visuals.isCurrent("a"))
        visuals.changed("b", PageVisuals.Change.Drew)
        assertEquals("another page's change doesn't count", true, visuals.isCurrent("a"))
        visuals.changed("a", PageVisuals.Change.Drew)
        assertEquals(false, visuals.isCurrent("a"))
        visuals.captured("a", visuals.generation("a"))
        assertEquals(true, visuals.isCurrent("a"))
    }

    @Test
    fun aChangeDuringTheCaptureLeavesItStale() {
        val before = visuals.generation("a")
        visuals.changed("a", PageVisuals.Change.Drew)
        visuals.captured("a", before)
        assertEquals(false, visuals.isCurrent("a"))
    }

    @Test
    fun theFirstChangeAfterACaptureIsReportedOnceWithItsDelay() {
        val heard = mutableListOf<Triple<String, PageVisuals.Change, Long>>()
        visuals.onNoLongerCurrent = { id, change, ms -> heard += Triple(id, change, ms) }
        visuals.changed("a", PageVisuals.Change.Drew)
        assertTrue("nothing captured yet, nothing to report", heard.isEmpty())
        visuals.captured("a", visuals.generation("a"))
        now += 420
        visuals.changed("a", PageVisuals.Change.Drew)
        visuals.changed("a", PageVisuals.Change.State)
        assertEquals(listOf(Triple("a", PageVisuals.Change.Drew, 420L)), heard)
    }

    @Test
    fun forgettingThePagesPicturesMakesItUnknown() {
        visuals.captured("a", visuals.generation("a"))
        visuals.forget("a")
        assertNull(visuals.isCurrent("a"))
    }

    @Test
    fun onlyAnAttachedViewMarkedForRedrawCounts() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val web = View(activity)
        val loose = View(activity)
        activity.setContentView(FrameLayout(activity).apply { addView(web, FrameLayout.LayoutParams(100, 100)) })
        web.layout(0, 0, 100, 100)
        web.draw(Canvas(Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)))
        visuals.captured("a", visuals.generation("a"))
        visuals.noteDirty("a", web)
        assertEquals("drawn and untouched", true, visuals.isCurrent("a"))
        web.invalidate()
        visuals.noteDirty("a", loose.also { it.invalidate() })
        assertEquals("a view not in the window doesn't count", true, visuals.isCurrent("a"))
        visuals.noteDirty("a", web)
        assertFalse(visuals.isCurrent("a")!!)
    }
}
