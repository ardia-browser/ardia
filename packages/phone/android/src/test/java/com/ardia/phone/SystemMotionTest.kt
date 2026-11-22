package com.ardia.phone

import android.provider.Settings
import org.robolectric.RuntimeEnvironment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemMotionTest {
    private val context = RuntimeEnvironment.getApplication()

    @Test
    fun removeAnimationsIsReadAsReduceMotionTheWayComposeReadsIt() {
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertEquals(true, SystemMotion.read(context)["reduceMotion"])
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0.5f)
        assertEquals("a slower or faster scale still animates", false, SystemMotion.read(context)["reduceMotion"])
        assertEquals("Android has no reduce-transparency setting; Compose's app passes false too", false, SystemMotion.read(context)["reduceTransparency"])
    }

    @Test
    fun aSettingChangedWhileRunningIsSentOnceAndAResumeWithNoChangeSendsNothing() {
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        val sent = ArrayList<Map<String, Boolean>>()
        val watch = SystemLookWatch(read = { SystemMotion.read(context) }) { sent += it }
        assertFalse(watch.seed()["reduceMotion"]!!)
        val observer = SystemLookObserver(context) { watch.check() }
        observer.start()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        Settings.Global.putFloat(context.contentResolver, Settings.Global.TRANSITION_ANIMATION_SCALE, 0f)
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertEquals("the observer sees Remove animations turned on, and the second scale changes nothing more", listOf(mapOf("reduceMotion" to true, "reduceTransparency" to false)), sent)
        watch.check()
        assertEquals("a resume that finds nothing new sends nothing", 1, sent.size)
        observer.stop()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertEquals("a stopped observer hears nothing", 1, sent.size)
        watch.check()
        assertTrue("the resume after it picks the change up", sent.last()["reduceMotion"] == false && sent.size == 2)
    }
}
