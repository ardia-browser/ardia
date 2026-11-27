package com.ardia.phone

import android.app.Activity
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FrameMarkViewTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    private val traced = ArrayList<String>()
    private val wasOn = FrameMarkTrace.on
    private val wasWrite = FrameMarkTrace.write

    @Before
    fun record() {
        FrameMarkTrace.on = { true }
        FrameMarkTrace.write = { traced.add(it) }
    }

    @After
    fun restore() {
        FrameMarkTrace.on = wasOn
        FrameMarkTrace.write = wasWrite
    }

    private fun attached(): FrameMarkView {
        val root = FrameLayout(activity)
        val mark = FrameMarkView(activity, appContext)
        root.addView(mark, FrameLayout.LayoutParams(0, 0))
        activity.setContentView(root)
        mark.alpha = 0f
        return mark
    }

    private fun traverse(mark: FrameMarkView) {
        mark.viewTreeObserver.dispatchOnPreDraw()
    }

    @Test
    fun aShownMarkIsTracedInTheNextTraversalNotWhenItsOpacityIsSet() {
        val mark = attached()
        mark.markWhenShown("deck-drawn")
        mark.alpha = 1f
        assertEquals(emptyList<String>(), traced)
        traverse(mark)
        assertEquals(listOf("deck-drawn"), traced)
        traverse(mark)
        assertEquals("one traversal carries the mark, later ones don't repeat it", listOf("deck-drawn"), traced)
    }

    @Test
    fun aMarkStaysShownWithoutRepeatingAndHidingItReArmsTheNextShow() {
        val mark = attached()
        mark.markWhenShown("deck-hit:plus")
        mark.alpha = 1f
        traverse(mark)
        mark.alpha = 1f
        traverse(mark)
        assertEquals(listOf("deck-hit:plus"), traced)
        mark.alpha = 0f
        mark.alpha = 1f
        traverse(mark)
        assertEquals(listOf("deck-hit:plus", "deck-hit:plus"), traced)
    }

    @Test
    fun aMarkHiddenAgainBeforeAnyTraversalDrewItIsNeverTraced() {
        val mark = attached()
        mark.markWhenShown("deck-live")
        mark.alpha = 1f
        mark.alpha = 0f
        traverse(mark)
        assertEquals(emptyList<String>(), traced)
    }

    @Test
    fun withoutAShownLabelOpacityMarksNothingAndThePlainMarkTracesInTheNextTraversalAndDedupes() {
        val mark = attached()
        mark.alpha = 1f
        traverse(mark)
        assertEquals(emptyList<String>(), traced)
        mark.mark("swipe-landed")
        mark.mark("swipe-landed")
        assertEquals(emptyList<String>(), traced)
        traverse(mark)
        traverse(mark)
        assertEquals(listOf("swipe-landed"), traced)
        mark.mark("")
        mark.mark("swipe-landed")
        traverse(mark)
        assertEquals(listOf("swipe-landed", "swipe-landed"), traced)
    }

    @Test
    fun aDetachedMarkDropsItsPendingTraversal() {
        val mark = attached()
        mark.markWhenShown("deck-drawn")
        mark.alpha = 1f
        val observer = mark.viewTreeObserver
        (mark.parent as FrameLayout).removeView(mark)
        observer.dispatchOnPreDraw()
        assertEquals(emptyList<String>(), traced)
    }
}
