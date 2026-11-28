package com.ardia.phone

import android.app.Notification
import android.app.NotificationManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import com.ardia.browser.DownloadFailure
import com.ardia.browser.DownloadOutcome
import com.ardia.browser.DownloadProgress
import com.ardia.browser.PageDownload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DownloadNotificationsTest {
    private val context = RuntimeEnvironment.getApplication()
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val notifications = DownloadNotifications(context)

    private fun page(name: String, url: String = "https://files.example/$name", isPrivate: Boolean = false, session: String? = null, length: Long = -1) =
        PageDownload(url, name, null, length, null, null, null, isPrivate, session)

    private fun shown(id: Long): Notification? = manager.activeNotifications.firstOrNull { it.tag == DownloadNotices.TAG && it.id == DownloadNotices.noticeId(id) }?.notification

    private fun title(notification: Notification?) = notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()

    private fun text(notification: Notification?) = notification?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    private fun summary(): Notification? = manager.activeNotifications.firstOrNull { it.tag == DownloadNotices.SUMMARY_TAG }?.notification

    @Test
    fun theDownloadsChannelIsQuietSoNothingRingsOrPeeks() {
        notifications.started(1, page("a.pdf"), "t0")
        val channel = manager.getNotificationChannel(DownloadNotices.CHANNEL)
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
        assertNull(channel.sound)
    }

    @Test
    fun aRunningDownloadShowsItsProgressAndCancelThenBecomesDownloadComplete() {
        notifications.started(1, page("a.pdf", length = 1000), "t0")
        notifications.progressed(listOf(DownloadProgress(1, "a.pdf", 450, 1000)))
        val running = shown(1)!!
        assertEquals("a.pdf", title(running))
        assertEquals("files.example", text(running))
        assertEquals(45, running.extras.getInt(Notification.EXTRA_PROGRESS))
        assertEquals(100, running.extras.getInt(Notification.EXTRA_PROGRESS_MAX))
        assertTrue(running.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(listOf("Cancel"), running.actions.map { it.title.toString() })
        notifications.finished(1, DownloadOutcome.Finished("a.pdf", Uri.parse("content://media/external/downloads/41")))
        val done = shown(1)!!
        assertEquals("Download complete", title(done))
        assertEquals("a.pdf · 1 KB", text(done))
        assertTrue(done.flags and Notification.FLAG_AUTO_CANCEL != 0)
        assertNotNull(done.contentIntent)
        assertNull(done.actions)
    }

    @Test
    fun aFailureShowsTheReasonAndRetry() {
        notifications.started(2, page("b.pdf"), "t0")
        notifications.finished(2, DownloadOutcome.Failed("b.pdf", DownloadFailure.Network))
        val failed = shown(2)!!
        assertEquals("Couldn’t download b.pdf", title(failed))
        assertEquals("Check your connection and try again.", text(failed))
        assertEquals(listOf("Retry"), failed.actions.map { it.title.toString() })
    }

    @Test
    fun twoRunningDownloadsShareAGroupWithASummaryThatGoesWhenOneEnds() {
        notifications.started(3, page("a.pdf"), "t0")
        assertNull(summary())
        notifications.started(4, page("b.zip"), "t0")
        val grouped = summary()!!
        assertEquals("2 downloads", title(grouped))
        assertEquals(DownloadNotices.RUNNING_GROUP, grouped.group)
        assertTrue(grouped.flags and Notification.FLAG_GROUP_SUMMARY != 0)
        assertEquals(DownloadNotices.RUNNING_GROUP, shown(3)!!.group)
        notifications.cancelled(4)
        assertNull(summary())
        assertNull(shown(4))
    }

    @Test
    fun anIncognitoDownloadIsRedactedOnTheLockScreenAndGoesWhenItsSessionEnds() {
        notifications.started(5, page("secret.pdf", isPrivate = true, session = "s1"), "t1")
        val running = shown(5)!!
        assertEquals(NotificationCompat.VISIBILITY_PRIVATE, running.visibility)
        assertEquals("Incognito download", title(running.publicVersion))
        assertNull(text(running.publicVersion))
        notifications.finished(5, DownloadOutcome.Finished("secret.pdf", Uri.parse("content://media/external/downloads/42")))
        assertEquals("Incognito download", title(shown(5)!!.publicVersion))
        notifications.started(6, page("other.pdf", isPrivate = true, session = "s2"), "t2")
        notifications.endPrivateSession("s1")
        assertNull(shown(5))
        assertNotNull(shown(6))
        notifications.endPrivateSession(null)
        assertNull(shown(6))
    }

    @Test
    fun aDownloadStoppedWithItsPrivateSessionLeavesNoNotification() {
        notifications.started(7, page("held.bin", isPrivate = true, session = "s3"), "t3")
        notifications.finished(7, DownloadOutcome.Failed("held.bin", DownloadFailure.PrivateSessionEnded))
        assertNull(shown(7))
    }

    @Test
    fun withNotificationsTurnedOffNothingPostsAndNothingBreaks() {
        shadowOf(manager).setNotificationsEnabled(false)
        notifications.started(8, page("a.pdf"), "t0")
        notifications.progressed(listOf(DownloadProgress(8, "a.pdf", 10, 100)))
        notifications.finished(8, DownloadOutcome.Finished("a.pdf", Uri.parse("content://media/external/downloads/43")))
        assertTrue(manager.activeNotifications.isEmpty())
    }
}
