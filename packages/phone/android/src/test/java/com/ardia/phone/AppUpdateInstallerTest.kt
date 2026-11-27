package com.ardia.phone

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppUpdateInstallerTest {
    private val context = RuntimeEnvironment.getApplication()
    private val apk = ByteArray(200_000) { (it * 13).toByte() }
    private val sha256 = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }

    private fun install(expected: String?, download: String = "41") = AppUpdateInstaller.install(context, ByteArrayInputStream(apk), apk.size.toLong(), expected, AppUpdateInstaller.KIND_UPDATE, download)

    private fun status(session: Int, code: Int) = android.content.Intent().putExtra(android.content.pm.PackageInstaller.EXTRA_SESSION_ID, session).putExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, code)

    @Test
    fun withoutTheInstallPermissionNoSessionIsOpened() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(false)
        assertEquals("needs_permission", install(sha256)["result"])
        assertTrue(context.packageManager.packageInstaller.allSessions.isEmpty())
    }

    @Test
    fun bytesThatDontMatchTheChecksumAreAbandonedBeforeCommit() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        assertEquals("mismatch", install("0".repeat(64))["result"])
        assertTrue(context.packageManager.packageInstaller.allSessions.isEmpty())
    }

    @Test
    fun matchingBytesAreCommittedToTheSession() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        val committed = install(sha256)
        assertEquals("committed", committed["result"])
        assertEquals("41", AppUpdateInstaller.tracked(context, (committed["session"] as String).toInt())?.second)
    }

    @Test
    fun aNewInstallAbandonsTheOlderSessionAndOnlyTrackedSessionsAreReported() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        val older = (install(sha256, "41")["session"] as String).toInt()
        val newer = (install(sha256, "42")["session"] as String).toInt()
        assertEquals(null, AppUpdateInstaller.tracked(context, older))
        assertEquals("42", AppUpdateInstaller.tracked(context, newer)?.second)
        val reported = mutableListOf<Map<String, Any?>>()
        AppUpdateInstaller.statusSink = { reported.add(it) }
        try {
            AppUpdateInstaller.report(context, status(older, android.content.pm.PackageInstaller.STATUS_FAILURE_ABORTED))
            AppUpdateInstaller.report(context, status(987654, android.content.pm.PackageInstaller.STATUS_FAILURE))
            AppUpdateInstaller.report(context, android.content.Intent())
            assertEquals(emptyList<Map<String, Any?>>(), reported)
            AppUpdateInstaller.report(context, status(newer, android.content.pm.PackageInstaller.STATUS_FAILURE_ABORTED))
            assertEquals(listOf(mapOf("kind" to "update", "status" to "aborted", "session" to newer.toString(), "download" to "42")), reported)
            assertEquals(null, AppUpdateInstaller.tracked(context, newer))
            AppUpdateInstaller.report(context, status(newer, android.content.pm.PackageInstaller.STATUS_FAILURE))
            assertEquals(1, reported.size)
        } finally {
            AppUpdateInstaller.statusSink = null
        }
    }

    @Test
    fun theNotificationOpensAnInstallOnlyWithTheTokenItWasGivenAndOnlyOnce() {
        val extra = "com.ardia.phone.INSTALL_UPDATE"
        val token = AppUpdateHandoff.issueInstallToken(context)
        AppUpdateHandoff.noteInstallRequest(context, android.content.Intent().putExtra(extra, "Ardia-1.0.2.apk"))
        AppUpdateHandoff.noteInstallRequest(context, android.content.Intent().putExtra(extra, "not-$token"))
        assertEquals(false, AppUpdateHandoff.takeInstallRequest(context, null))
        AppUpdateHandoff.noteInstallRequest(context, android.content.Intent().putExtra(extra, token))
        assertEquals(true, AppUpdateHandoff.takeInstallRequest(context, null))
        assertEquals(false, AppUpdateHandoff.takeInstallRequest(context, null))
        AppUpdateHandoff.noteInstallRequest(context, android.content.Intent().putExtra(extra, token))
        assertEquals(false, AppUpdateHandoff.takeInstallRequest(context, null))
    }

    @Test
    fun theAppUpdatesChannelExistsBeforeNotificationsAreAllowedAndATurnedOffChannelCountsAsNoNotifications() {
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        shadowOf(manager).setNotificationsEnabled(false)
        AppUpdateHandoff.ensureChannel(context)
        assertTrue(manager.getNotificationChannel("app_updates") != null)
        assertEquals(false, AppUpdateHandoff.notificationsShown(context))
        shadowOf(manager).setNotificationsEnabled(true)
        assertEquals(true, AppUpdateHandoff.notificationsShown(context))
        manager.deleteNotificationChannel("app_updates")
        manager.createNotificationChannel(android.app.NotificationChannel("app_updates", "App updates", android.app.NotificationManager.IMPORTANCE_NONE))
        assertEquals(false, AppUpdateHandoff.notificationsShown(context))
    }
}
