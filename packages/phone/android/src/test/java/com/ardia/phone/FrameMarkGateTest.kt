package com.ardia.phone

import android.app.Activity
import android.view.View
import android.widget.FrameLayout
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
class FrameMarkGateTest {
    private val traced = ArrayList<String>()
    private val gate = FrameMarkGate { traced += it }

    @Test
    fun aPlainMarkTracesInTheNextTraversalNotWhenItsPropLands() {
        assertTrue(gate.mark("deck-face:a"))
        assertTrue(traced.isEmpty())
        gate.traversal(shown = false)
        assertEquals(listOf("deck-face:a"), traced)
        assertFalse(gate.listens)
        gate.traversal(shown = true)
        assertEquals("once per label", 1, traced.size)
    }

    @Test
    fun aRepeatedLabelIsDedupedAndAnEmptyOneReArms() {
        gate.mark("tap:a")
        gate.traversal(shown = true)
        assertFalse(gate.mark("tap:a"))
        gate.mark("")
        gate.mark("tap:a")
        gate.traversal(shown = true)
        assertEquals(listOf("tap:a", "tap:a"), traced)
    }

    @Test
    fun aDrawnMarkWaitsForTheTraversalThatFirstDrawsItShownAndFiresAgainAfterItWasHidden() {
        gate.drawnOnly(true)
        gate.mark("dest-face:a")
        gate.traversal(shown = false)
        gate.traversal(shown = false)
        assertTrue(traced.isEmpty())
        assertTrue(gate.listens)
        gate.traversal(shown = true)
        gate.traversal(shown = true)
        assertEquals(listOf("dest-face:a"), traced)
        gate.traversal(shown = false)
        gate.traversal(shown = true)
        assertEquals(listOf("dest-face:a", "dest-face:a"), traced)
        assertTrue("a drawn mark keeps listening while it has a label", gate.listens)
    }

    @Test
    fun shownThroughNeedsEveryAncestorOpaqueEnoughToDraw() {
        val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(activity)
        val face = FrameLayout(activity)
        val mark = View(activity)
        face.addView(mark, FrameLayout.LayoutParams(0, 0))
        root.addView(face)
        activity.setContentView(root)
        face.alpha = 0f
        assertFalse(FrameMarkGate.shownThrough(mark))
        face.alpha = 1f
        assertTrue(FrameMarkGate.shownThrough(mark))
        root.alpha = 0f
        assertFalse(FrameMarkGate.shownThrough(mark))
        root.alpha = 1f
        face.visibility = View.INVISIBLE
        assertFalse(FrameMarkGate.shownThrough(mark))
    }
}
