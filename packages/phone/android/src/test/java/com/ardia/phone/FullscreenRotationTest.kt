package com.ardia.phone

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.View
import com.ardia.browser.FullscreenVideo
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FullscreenRotationTest {
    @Test
    fun aPortraitLockedAppLetsAFullscreenVideoTurnAndLocksAgainAfter() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        val host = FullscreenHost()
        host.show(activity, FullscreenVideo(View(activity)) {})
        assertEquals("the video turns within the user's rotation lock", ActivityInfo.SCREEN_ORIENTATION_FULL_USER, activity.requestedOrientation)
        host.hide("exited")
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, activity.requestedOrientation)
    }

    @Test
    fun anAppThatAlreadyTurnsIsLeftAsItIs() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        val host = FullscreenHost()
        host.show(activity, FullscreenVideo(View(activity)) {})
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
        host.hide("exited")
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
    }

    @Test
    fun aSecondVideoReplacingTheFirstStillEndsLocked() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        val host = FullscreenHost()
        host.show(activity, FullscreenVideo(View(activity)) {})
        host.show(activity, FullscreenVideo(View(activity)) {})
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_FULL_USER, activity.requestedOrientation)
        host.hide("exited")
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, activity.requestedOrientation)
    }
}
