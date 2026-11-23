package com.ardia.phone

import android.app.Activity
import android.os.Handler
import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@LooperMode(LooperMode.Mode.PAUSED)
class ForegroundAttachTest {
    @Test
    fun onTheMainThreadTheAttachRunsBeforeAPageOpenAlreadyQueued() {
        val order = mutableListOf<String>()
        val main = Handler(Looper.getMainLooper())
        main.post { order += "open private page" }
        ForegroundAttach.dispatch(onMain = true, post = main::post) { order += "attach: launch policy applied" }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf("attach: launch policy applied", "open private page"), order)
    }

    @Test
    fun offTheMainThreadTheAttachIsPostedOnce() {
        val order = mutableListOf<String>()
        val main = Handler(Looper.getMainLooper())
        ForegroundAttach.dispatch(onMain = false, post = main::post) { order += "attach" }
        assertTrue("nothing runs on the calling thread", order.isEmpty())
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf("attach"), order)
    }

    @Test
    fun aPostedAttachSkipsAnActivityThatIsNoLongerTheHost() {
        val host = Robolectric.buildActivity(Activity::class.java).setup()
        val other = Robolectric.buildActivity(Activity::class.java).setup().get()
        assertTrue(ForegroundAttach.stillHost(host.get(), host.get()))
        assertFalse("another activity took over", ForegroundAttach.stillHost(host.get(), other))
        assertFalse("no current activity", ForegroundAttach.stillHost(host.get(), null))
        val finishing = Robolectric.buildActivity(Activity::class.java).setup().get().apply { finish() }
        assertFalse(ForegroundAttach.stillHost(finishing, finishing))
        host.pause().stop().destroy()
        assertFalse(ForegroundAttach.stillHost(host.get(), host.get()))
    }
}
