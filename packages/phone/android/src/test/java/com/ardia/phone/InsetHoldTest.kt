package com.ardia.phone

import android.app.Activity
import android.content.res.Configuration
import android.view.View
import android.widget.FrameLayout
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
class InsetHoldTest {
    private var now = 10_000L
    private val hold = InsetHold { now }
    private val threeButton = Insets.of(0, 0, 0, 130)
    private val gestures = Insets.of(0, 0, 0, 44)
    private val gone = Insets.NONE
    private val keyboard = 897
    private val keyboardWithoutTheBar = 767

    private fun config(night: Boolean = false, landscape: Boolean = false, width: Int = 392, height: Int = 796) = Configuration().apply {
        uiMode = Configuration.UI_MODE_TYPE_NORMAL or if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        orientation = if (landscape) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
        screenWidthDp = width
        screenHeightDp = height
        smallestScreenWidthDp = minOf(width, height)
        densityDpi = 440
        fontScale = 1f
    }

    private fun settled() {
        hold.configurationChanged(config())
        assertEquals(threeButton, hold.navigationBars(threeButton))
    }

    @Test
    fun aLightDarkSwitchHoldsTheNavigationBarThatBrieflyDropsToZero() {
        settled()
        hold.configurationChanged(config(night = true))
        now += 150
        assertEquals("the F4 drops 130 px to 0 for about 330 ms while it rebuilds its navigation bar", threeButton, hold.navigationBars(gone))
        now += 300
        assertEquals(threeButton, hold.navigationBars(threeButton))
        assertTrue(hold.holding)
    }

    @Test
    fun miuiTakingDownAndRestoringItsNavigationBarWindowKeepsTheHold() {
        settled()
        hold.configurationChanged(config(night = true))
        now += 90
        hold.configurationChanged(config(night = true, height = 844))
        assertTrue("on the F4 the screen grows by the bar's 48 dp (0x20000400) and the hold ended on it", hold.holding)
        assertEquals(threeButton, hold.navigationBars(gone))
        now += 90
        hold.configurationChanged(config(night = true, height = 796))
        assertTrue(hold.holding)
        assertEquals(threeButton, hold.navigationBars(gone))
    }

    @Test
    fun aRealResizeDuringTheHoldEndsIt() {
        settled()
        hold.configurationChanged(config(night = true))
        hold.configurationChanged(config(night = true, height = 420))
        assertFalse("split screen takes far more than the bar's height", hold.holding)
        assertEquals(gone, hold.navigationBars(gone))
    }

    @Test
    fun aWidthChangeDuringTheHoldEndsIt() {
        settled()
        hold.configurationChanged(config(night = true))
        hold.configurationChanged(config(night = true, width = 360, height = 844))
        assertFalse(hold.holding)
    }

    @Test
    fun rotationDuringTheHoldEndsIt() {
        settled()
        hold.configurationChanged(config(night = true))
        hold.configurationChanged(config(night = true, landscape = true, width = 844, height = 392))
        assertFalse(hold.holding)
        assertEquals(gone, hold.navigationBars(gone))
    }

    @Test
    fun rotationWithTheNightModeChangingOpensNoHold() {
        settled()
        hold.configurationChanged(config(night = true, landscape = true, width = 844, height = 392))
        assertFalse(hold.holding)
        assertEquals(gone, hold.navigationBars(gone))
    }

    @Test
    fun afterTheDeadlineWhateverTheSystemSaysWins() {
        settled()
        hold.configurationChanged(config(night = true))
        now += 200
        assertEquals(threeButton, hold.navigationBars(gone))
        assertEquals(InsetHold.HOLD_MILLIS - 200, hold.heldMillisLeft)
        now += InsetHold.HOLD_MILLIS
        assertFalse(hold.holding)
        assertEquals(gone, hold.navigationBars(gone))
    }

    @Test
    fun withoutAConfigurationChangeAZeroGetsThroughAtOnce() {
        settled()
        assertEquals("zero looking wrong is not a reason to hold it", gone, hold.navigationBars(gone))
    }

    @Test
    fun splitScreenWithoutALightDarkChangeGetsThroughAtOnce() {
        settled()
        hold.configurationChanged(config(height = 420))
        assertFalse(hold.holding)
        assertEquals(gone, hold.navigationBars(gone))
    }

    @Test
    fun switchingToGestureNavigationDuringTheHoldGetsThroughAtOnce() {
        settled()
        hold.configurationChanged(config(night = true))
        assertEquals("only a drop to zero is held; a new size is real", gestures, hold.navigationBars(gestures))
        assertEquals(gestures, hold.navigationBars(gone))
    }

    @Test
    fun theKeyboardHeightIsHeldThroughTheBarsSwingInEitherDirection() {
        settled()
        assertEquals(keyboard, hold.ime(keyboard))
        hold.configurationChanged(config(night = true))
        assertEquals("the F4 reported the bar's 47.27 dp added", keyboard, hold.ime(keyboard + 130))
        assertEquals("and then taken away, after the bar's own dip", keyboard, hold.ime(keyboardWithoutTheBar))
        assertEquals(keyboard, hold.ime(keyboard))
        now += InsetHold.HOLD_MILLIS
        assertEquals(keyboardWithoutTheBar, hold.ime(keyboardWithoutTheBar))
    }

    @Test
    fun theKeyboardClosingOrChangingSizeDuringTheHoldGetsThrough() {
        settled()
        hold.ime(keyboard)
        hold.configurationChanged(config(night = true))
        assertEquals("an emoji panel or a taller keyboard is real", keyboard + 300, hold.ime(keyboard + 300))
        assertEquals("closing is real", 0, hold.ime(0))
        assertEquals("a keyboard opened afterwards isn't held to the old height", keyboardWithoutTheBar, hold.ime(keyboardWithoutTheBar))
    }

    @Test
    fun withoutAHoldTheKeyboardIsAsTheSystemSays() {
        settled()
        hold.ime(keyboard)
        assertEquals(keyboardWithoutTheBar, hold.ime(keyboardWithoutTheBar))
    }

    @Test
    fun fullscreenKeepsThePagesInsetWhileTheVideoCoversItSoLeavingShowsThePageAsItWas() {
        settled()
        hold.fullscreenStarts()
        assertEquals("the page under the video keeps its bar; on the F4 it was laid out without it and sat 70 px low on leaving", threeButton, hold.navigationBars(gone))
        hold.configurationChanged(config(landscape = true, width = 844, height = 392))
        assertEquals("rotating the video doesn't reach the covered page", threeButton, hold.navigationBars(Insets.of(130, 0, 0, 0)))
        hold.configurationChanged(config())
        hold.fullscreenEnds()
        assertEquals("until the system reports the bar again", threeButton, hold.navigationBars(gone))
        assertEquals(threeButton, hold.navigationBars(threeButton))
        now += InsetHold.RETURN_MILLIS
        assertEquals("then whatever the system says wins", gone, hold.navigationBars(gone))
    }

    private val sideBar = Insets.of(0, 0, 130, 0)

    @Test
    fun fullscreenFollowsTheBarAsItWouldBeShownWhenThePhoneTurns() {
        settled()
        hold.fullscreenStarts()
        assertEquals(threeButton, hold.navigationBars(gone, threeButton))
        hold.configurationChanged(config(landscape = true, width = 844, height = 392))
        assertEquals("turned, the covered page is laid out for the side bar, not the portrait one", sideBar, hold.navigationBars(gone, sideBar))
        hold.fullscreenEnds()
        assertEquals("leaving in landscape shows the page with its side bar at once", sideBar, hold.navigationBars(gone, sideBar))
    }

    @Test
    fun leavingFullscreenAfterTurningBackHoldsThePortraitBarNotTheLandscapeOne() {
        settled()
        hold.configurationChanged(config(landscape = true, width = 844, height = 392))
        hold.navigationBars(sideBar, sideBar)
        hold.fullscreenStarts()
        hold.configurationChanged(config())
        hold.navigationBars(gone, threeButton)
        hold.fullscreenEnds()
        assertEquals("the F4 laid the bar out twice for 10 frames: the landscape inset first, then the portrait one", threeButton, hold.navigationBars(gone, threeButton))
        assertEquals(threeButton, hold.navigationBars(threeButton, threeButton))
    }

    @Test
    fun aLightDarkHoldKeepsTheValueItHadNotTheBarAsItWouldBeShown() {
        settled()
        hold.configurationChanged(config(night = true))
        assertEquals("MIUI's rebuild may report anything for a bar that's gone", threeButton, hold.navigationBars(gone, gone))
    }

    @Test
    fun fullscreenStartedInsideALightDarkHoldStillHoldsUntilItEnds() {
        settled()
        hold.configurationChanged(config(night = true))
        hold.fullscreenStarts()
        now += InsetHold.HOLD_MILLIS * 3
        assertEquals(threeButton, hold.navigationBars(gone))
        hold.fullscreenEnds()
        now += InsetHold.RETURN_MILLIS
        assertEquals(gone, hold.navigationBars(gone))
    }

    @Test
    fun leavingFullscreenWithoutHavingEnteredItHoldsNothing() {
        settled()
        hold.fullscreenEnds()
        assertFalse(hold.holding)
    }

    @Test
    fun theReactRootIsHandedTheHeldBarAndTheKeyboardAsTheSystemReportsIt() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val content = activity.findViewById<View>(android.R.id.content)
        val child = FrameLayout(activity)
        var seen: WindowInsetsCompat? = null
        ViewCompat.setOnApplyWindowInsetsListener(child) { _, insets ->
            seen = insets
            insets
        }
        (content as FrameLayout).addView(child)
        InsetHold.install(activity)
        InsetHold.window.navigationBars(threeButton)
        InsetHold.window.configurationChanged(Configuration(activity.resources.configuration).apply { uiMode = uiMode xor Configuration.UI_MODE_NIGHT_MASK })
        val typing = Insets.of(0, 0, 0, 900)
        val dispatched = WindowInsetsCompat.Builder().setInsets(WindowInsetsCompat.Type.navigationBars(), gone).setInsets(WindowInsetsCompat.Type.ime(), typing).build()
        ViewCompat.dispatchApplyWindowInsets(content, dispatched)
        assertEquals(threeButton, seen!!.getInsets(WindowInsetsCompat.Type.navigationBars()))
        assertEquals(typing, seen!!.getInsets(WindowInsetsCompat.Type.ime()))
        InsetHold.window.configurationChanged(Configuration(activity.resources.configuration).apply { orientation = Configuration.ORIENTATION_LANDSCAPE; screenWidthDp = 2000 })
    }
}
