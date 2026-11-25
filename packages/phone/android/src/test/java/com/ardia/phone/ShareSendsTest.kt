package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShareSendsTest {
    private val app = RuntimeEnvironment.getApplication()

    @Test
    fun aColdControllerThatLooksDisabledIsWaitedForWhenSyncIsConnectedOnDisk() {
        assertEquals("cold start: placeholder state, no devices, connected on disk", ShareWait.Next.Wait, ShareWait.next(isEnabled = false, updated = false, deviceKnown = false, connectedOnDisk = true))
        assertEquals("loaded, the Mac not yet in the snapshot", ShareWait.Next.Wait, ShareWait.next(isEnabled = true, updated = false, deviceKnown = false, connectedOnDisk = true))
        assertEquals(ShareWait.Next.Send, ShareWait.next(isEnabled = true, updated = false, deviceKnown = true, connectedOnDisk = true))
        assertEquals("updated and still no such device", ShareWait.Next.GiveUp, ShareWait.next(isEnabled = true, updated = true, deviceKnown = false, connectedOnDisk = true))
        assertEquals("sync really off", ShareWait.Next.GiveUp, ShareWait.next(isEnabled = false, updated = false, deviceKnown = false, connectedOnDisk = false))
    }

    @Test
    fun aSendIsRecordedOnceUnderItsKeyUntilItsOutcome() {
        val item = ShareSends.Pending("k-1", "https://example.com/a", "A", "mac-1", 1_000L, 7L)
        ShareSends.record(app, item)
        ShareSends.record(app, item.copy(title = "again"))
        assertEquals("a second tap or a recreated sheet doesn't record the same send twice", listOf(item), ShareSends.pending(app))
        ShareSends.remove(app, "k-1")
        assertEquals(emptyList<ShareSends.Pending>(), ShareSends.pending(app))
    }
}
