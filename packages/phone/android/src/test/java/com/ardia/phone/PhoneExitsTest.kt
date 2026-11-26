package com.ardia.phone

import android.app.ActivityManager.RunningAppProcessInfo
import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneExitsTest {
    private val now = 1_800_000_000_000L
    private val hour = 3_600_000L

    private fun seen(reason: Int, at: Long, foreground: Boolean = true, main: Boolean = true) =
        ExitSeen(reason, if (foreground) RunningAppProcessInfo.IMPORTANCE_FOREGROUND else RunningAppProcessInfo.IMPORTANCE_CACHED, at, main)

    @Test
    fun crashesAndHangsBecomeRecordsWithoutAnythingAboutThePage() {
        val record = PhoneExits.describe(seen(ApplicationExitInfo.REASON_CRASH_NATIVE, now - hour))!!
        assertEquals(mapOf("kind" to "crash", "reason" to "native_crash", "foreground" to "yes", "at" to (now - hour).toDouble()), record)
        assertEquals("anr", PhoneExits.describe(seen(ApplicationExitInfo.REASON_ANR, now))!!["reason"])
        assertEquals("no", PhoneExits.describe(seen(ApplicationExitInfo.REASON_LOW_MEMORY, now, foreground = false))!!["foreground"])
        val service = ExitSeen(ApplicationExitInfo.REASON_CRASH, RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE, now, true)
        assertEquals("a foreground service isn't Ardia on screen", "no", PhoneExits.describe(service)!!["foreground"])
    }

    @Test
    fun ordinaryExitsAreLeftOut() {
        assertNull(PhoneExits.describe(seen(ApplicationExitInfo.REASON_USER_REQUESTED, now)))
        assertNull(PhoneExits.describe(seen(ApplicationExitInfo.REASON_EXIT_SELF, now)))
        assertNull(PhoneExits.describe(seen(ApplicationExitInfo.REASON_PACKAGE_UPDATED, now)))
    }

    @Test
    fun onlyNewMainProcessExitsSinceSharingTurnedOnAreTaken() {
        val exits = listOf(
            seen(ApplicationExitInfo.REASON_CRASH, now - 3 * hour),
            seen(ApplicationExitInfo.REASON_CRASH, now - 2 * hour, main = false),
            seen(ApplicationExitInfo.REASON_CRASH, now - hour),
            seen(ApplicationExitInfo.REASON_CRASH, now - 10 * 24 * hour),
            seen(ApplicationExitInfo.REASON_ANR, now - 30 * 60_000L),
        )
        val picked = PhoneExits.pick(exits, lastSeen = now - 4 * hour, sharingSince = now - 150 * 60_000L, now = now)
        assertEquals(listOf("java_crash", "anr"), picked.map { it["reason"] })
        assertEquals(emptyList<Map<String, Any>>(), PhoneExits.pick(exits, lastSeen = now, sharingSince = 0, now = now))
    }

    @Test
    fun noMoreThanTenAreTakenAtOnce() {
        val exits = (1..25).map { seen(ApplicationExitInfo.REASON_CRASH, now - it * 60_000L) }
        assertEquals(PhoneExits.MOST, PhoneExits.pick(exits, 0, 0, now).size)
    }
}
