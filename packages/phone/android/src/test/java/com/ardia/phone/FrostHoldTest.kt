package com.ardia.phone

import android.app.Activity
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
@Config(sdk = [34])
class FrostHoldTest {
    private val fill = 0xFF223344.toInt()

    @Test
    fun aHeldSourceDrawsItsFillUntilItsNamedCoverHidesAndNothingWithoutAFill() {
        assertNull(FrostHold.held(null, null))
        assertNull(FrostHold.held(null, true))
        assertEquals(fill, FrostHold.held(fill, null))
        assertEquals(fill, FrostHold.held(fill, true))
        assertNull(FrostHold.held(fill, false))
    }

    @Test
    fun aCoverCountsAsShownOnlyWhileItIsAttachedAndVisible() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().visible().get()
        val cover = View(activity)
        assertFalse("no view", FrostHold.coverShown(null))
        assertFalse("not attached", FrostHold.coverShown(cover))
        activity.setContentView(FrameLayout(activity).apply { addView(cover, 100, 100) })
        assertTrue(FrostHold.coverShown(cover))
        cover.visibility = View.INVISIBLE
        assertFalse("the hand-over hid it", FrostHold.coverShown(cover))
    }
}
