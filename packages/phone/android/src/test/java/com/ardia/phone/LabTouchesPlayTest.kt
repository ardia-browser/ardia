package com.ardia.phone

import android.app.Activity
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

class RecordingActivity : Activity() {
    val seen = ArrayList<Triple<Int, Long, Long>>()

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        seen.add(Triple(event.actionMasked, event.downTime, event.eventTime))
        return true
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@LooperMode(LooperMode.Mode.PAUSED)
class LabTouchesPlayTest {
    @Test
    fun aStalledMainThreadDeliversTheStepsLateButStampedWithTheirPlannedTimesSoVelocityIsTheScriptsNotTheStalls() {
        val activity = Robolectric.buildActivity(RecordingActivity::class.java).setup().get()
        val planned = SystemClock.uptimeMillis() + 60
        LabTouches.play(LabTouches.parse("0:d:300:2200;40:m:500:2200;80:m:700:2200;110:u:800:2200"), { activity })
        ShadowSystemClock.advanceBy(Duration.ofMillis(600))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP), activity.seen.map { it.first })
        assertEquals(listOf(planned, planned + 40, planned + 80, planned + 110), activity.seen.map { it.third })
        assertEquals(List(4) { planned }, activity.seen.map { it.second })
    }
}
