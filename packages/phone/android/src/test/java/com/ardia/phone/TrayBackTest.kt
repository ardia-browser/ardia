package com.ardia.phone

import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.OnBackPressedDispatcher
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TrayBackTest {
    private val heard = ArrayList<String>()
    private var reactHeard = 0
    private val dispatcher = OnBackPressedDispatcher()
    private val react = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            reactHeard += 1
        }
    }
    private val tray = TrayBack { name, body -> heard += "$name ${body["progress"] ?: ""}".trim() }

    init {
        dispatcher.addCallback(react)
        dispatcher.addCallback(tray)
    }

    private fun swipe(progress: Float) = BackEventCompat(100f, 900f, progress, BackEventCompat.EDGE_LEFT)

    @Test
    fun whileTheTrayIsUpTheGestureIsTheTraysAndReactNeverHearsIt() {
        tray.isEnabled = true
        dispatcher.dispatchOnBackStarted(swipe(0f))
        dispatcher.dispatchOnBackProgressed(swipe(0.4f))
        dispatcher.dispatchOnBackCancelled()
        dispatcher.dispatchOnBackStarted(swipe(0f))
        dispatcher.dispatchOnBackProgressed(swipe(0.9f))
        dispatcher.onBackPressed()
        assertEquals(listOf("onBackProgress 0.0", "onBackProgress 0.4000000059604645", "onBackCancel", "onBackProgress 0.0", "onBackProgress 0.8999999761581421", "onBackCommit"), heard)
        assertEquals(0, reactHeard)
    }

    @Test
    fun withTheTrayDownBackGoesToReactAsBefore() {
        tray.isEnabled = false
        dispatcher.onBackPressed()
        assertEquals(emptyList<String>(), heard)
        assertEquals(1, reactHeard)
    }
}
