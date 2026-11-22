package com.ardia.phone

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.OnBackPressedCallback
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class ReactBackTest {
    class JavaScript {
        var handlers = 0
        var heard = 0
        var defaults = 0
    }

    open class BareReactActivity : ReactActivity() {
        val js = JavaScript()
        var backgrounded = 0

        override fun onCreate(savedInstanceState: Bundle?) {
            setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar)
            super.onCreate(savedInstanceState)
        }

        override fun createReactActivityDelegate(): ReactActivityDelegate = object : ReactActivityDelegate(this, "main") {
            override fun onCreate(savedInstanceState: Bundle?) = Unit
            override fun onPause() = Unit
            override fun onResume() = Unit
            override fun onDestroy() = Unit
            override fun onWindowFocusChanged(hasFocus: Boolean) = Unit
            override fun onKeyUp(keyCode: Int, event: KeyEvent) = false
            override fun onBackPressed(): Boolean {
                js.heard += 1
                if (js.handlers == 0) {
                    js.defaults += 1
                    invokeDefaultOnBackPressed()
                }
                return true
            }
        }

        @Deprecated("Deprecated in Java")
        override fun moveTaskToBack(nonRoot: Boolean): Boolean {
            backgrounded += 1
            return true
        }
    }

    open class FixedReactActivity : BareReactActivity() {
        @Suppress("DEPRECATION")
        val reactBack = ReactBack { onBackPressed() }

        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            onBackPressedDispatcher.addCallback(this, reactBack)
        }

        override fun invokeDefaultOnBackPressed() = reactBack.bypassed { super.invokeDefaultOnBackPressed() }
    }

    class LeavingReactActivity : FixedReactActivity() {
        override fun invokeDefaultOnBackPressed() {
            if (ReactBack.leaveToTheBackground(this)) return
            super.invokeDefaultOnBackPressed()
        }
    }

    @Test
    @Config(sdk = [33])
    fun backAtTheRootSendsTheTaskBackInsteadOfFinishingSoAReopenKeepsTheSameSurface() {
        val activity = Robolectric.buildActivity(LeavingReactActivity::class.java).setup().get()
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(1, activity.backgrounded)
        assertFalse("MIUI's Android 13 finished the activity on the platform's own Back and the reopened surface laid out wrong", activity.isFinishing)
        activity.js.handlers = 1
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals("Back still reaches JS after the task went to the background", 2, activity.js.heard)
    }

    @Test
    @Config(sdk = [34])
    fun belowAndroid16ReactNativeLeavesTheDispatcherEmptySoTheSystemNeverReachesJavaScript() {
        val activity = Robolectric.buildActivity(BareReactActivity::class.java).setup().get()
        assertFalse(
            "with enableOnBackInvokedCallback on, androidx registers Back with the window only for an enabled callback; React Native 0.81 adds one only on Android 16 with target 36",
            activity.onBackPressedDispatcher.hasEnabledCallbacks(),
        )
    }

    @Test
    @Config(sdk = [34])
    fun theForwardingCallbackSendsEveryBackToJavaScriptAndItsDefaultLeavesWithoutComingBack() {
        val activity = Robolectric.buildActivity(FixedReactActivity::class.java).setup().get()
        assertTrue(activity.onBackPressedDispatcher.hasEnabledCallbacks())
        activity.js.handlers = 1
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals("a JS handler (a menu, Settings, a confirm) hears Back", 1, activity.js.heard)
        assertEquals(0, activity.js.defaults)
        activity.js.handlers = 0
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(2, activity.js.heard)
        assertEquals("JS's default runs once and does not loop back into JS", 1, activity.js.defaults)
        assertTrue("after the default the callback is on again for the next Back", activity.reactBack.isEnabled)
        activity.js.handlers = 1
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals("Back still reaches JS after the app was sent back once", 3, activity.js.heard)
    }

    @Test
    @Config(sdk = [34])
    fun aLaterCallbackSuchAsTheTraysStillComesFirst() {
        val activity = Robolectric.buildActivity(FixedReactActivity::class.java).setup().get()
        var trayClosed = 0
        val tray = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                trayClosed += 1
            }
        }
        activity.onBackPressedDispatcher.addCallback(activity, tray)
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(1, trayClosed)
        assertEquals(0, activity.js.heard)
        tray.isEnabled = false
        activity.js.handlers = 1
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(1, activity.js.heard)
    }

    class Android16ShapedActivity : BareReactActivity() {
        private val reactNativesOwn = object : OnBackPressedCallback(true) {
            @Suppress("DEPRECATION")
            override fun handleOnBackPressed() {
                isEnabled = false
                onBackPressed()
                isEnabled = true
            }
        }

        @Suppress("DEPRECATION")
        val reactBack = ReactBack { onBackPressed() }

        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            onBackPressedDispatcher.addCallback(this, reactNativesOwn)
            onBackPressedDispatcher.addCallback(this, reactBack)
        }

        override fun invokeDefaultOnBackPressed() = reactBack.bypassed {
            reactNativesOwn.isEnabled = false
            super.invokeDefaultOnBackPressed()
        }
    }

    @Test
    @Config(sdk = [35])
    fun withReactNativesAndroid16CallbackBelowJavaScriptHearsBackOnceAndStillHearsItAfterTheAppWasSentBack() {
        val activity = Robolectric.buildActivity(Android16ShapedActivity::class.java).setup().get()
        activity.js.handlers = 1
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals("ours sits above React Native's, so one Back is one event", 1, activity.js.heard)
        activity.js.handlers = 0
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(1, activity.js.defaults)
        activity.js.handlers = 1
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals("React Native's own callback stays off after its default (ReactActivity.invokeDefaultOnBackPressed); ours keeps Back working", 3, activity.js.heard)
    }
}
