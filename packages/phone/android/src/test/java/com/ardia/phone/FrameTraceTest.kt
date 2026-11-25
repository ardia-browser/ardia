package com.ardia.phone

import android.app.Activity
import android.content.ComponentCallbacks2
import android.view.View
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FrameTraceTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    @Test
    fun aTraceNamesTheDeepestRedrawnViewNotItsParents() {
        val root = FrameLayout(activity)
        val group = FrameLayout(activity)
        val quiet = View(activity)
        val busy = View(activity).apply { contentDescription = "Blobs" }
        group.addView(busy, FrameLayout.LayoutParams(50, 50))
        root.addView(group, FrameLayout.LayoutParams(60, 60))
        root.addView(quiet, FrameLayout.LayoutParams(40, 40))
        activity.setContentView(root)
        root.measure(View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, 100, 100)
        root.draw(android.graphics.Canvas(android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888)))
        busy.invalidate()
        val leaves = ArrayList<View>()
        FrameTrace.dirtyLeaves(root, leaves)
        assertEquals(listOf(busy), leaves.filter { it === busy || it === group || it === quiet })
        assertTrue(FrameTrace.label(busy).startsWith("View \"Blobs\""))
    }

    @Test
    fun theLineSaysHowManyFramesAndWhoWasRedrawn() {
        val line = FrameTrace.line(FrameTrace.Result(frames = 150, seconds = 5.0, passes = 150, layouts = 150, nothingRedrawn = 0, redrawn = listOf("DeckBackdropView" to 150), look = listOf("DeckBackdropView" to 150)))
        assertEquals("PAGELAB idle frames: 150 frame(s) drawn in 5.0 s, 150 draw pass(es), 150 layout pass(es), 0 pass(es) with no view redrawn; look views redrawn: DeckBackdropView x150; redrawn: nothing", line)
        assertTrue(FrameTrace.line(FrameTrace.Result(0, 5.0, 0, 0, 0, emptyList())).endsWith("look views redrawn: none; redrawn: nothing"))
        val cards = (1..20).map { "ReactViewGroup @$it" to 30 }
        val scroll = FrameTrace.line(FrameTrace.Result(30, 5.0, 30, 0, 0, cards, look = listOf("FrostView" to 2)))
        assertTrue(scroll, scroll.contains("look views redrawn: FrostView x2; redrawn: ReactViewGroup @1 x30"))
        assertTrue("the look views come first and in full; the rest stop at 16 and say how many more", scroll.endsWith("ReactViewGroup @16 x30 and 4 more"))
    }

    @Test
    fun theHiddenAppReleasesTheLookAndARunningTrimOnlyItsHiddenParts() {
        assertTrue(LookMemory.release(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN).startsWith("look released for the hidden app"))
        assertTrue(LookMemory.release(ComponentCallbacks2.TRIM_MEMORY_BACKGROUND).startsWith("look released for the hidden app"))
        assertTrue(LookMemory.release(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL).startsWith("look trimmed"))
        assertEquals("look kept", LookMemory.release(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE))
        assertEquals("UI_HIDDEN", ImageMemory.levelName(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
    }
}
