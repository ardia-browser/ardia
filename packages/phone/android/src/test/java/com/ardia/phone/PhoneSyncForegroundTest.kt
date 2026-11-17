package com.ardia.phone

import android.content.Context
import android.content.ContextWrapper
import com.ardia.sync.FakeDevice
import com.ardia.sync.ManualTimers
import com.ardia.sync.ReceivedTab
import com.ardia.sync.RecordingScheduler
import com.ardia.sync.SyncController
import com.ardia.sync.inline
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PhoneSyncForegroundTest {
    private val root = Files.createTempDirectory("phone-foreground").toFile().apply { deleteOnExit() }

    private val app: Context = object : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this

        override fun getFilesDir(): File = File(root, "files").apply { mkdirs() }

        override fun getNoBackupFilesDir(): File = File(root, "no_backup").apply { mkdirs() }
    }

    private val device = FakeDevice()
    private val timers = ManualTimers()

    @Before
    fun inject() {
        PhoneSync.makeRows = ::JdbcRows
        PhoneSync.makeController = { _, source -> SyncController(device, timers, RecordingScheduler(), inline).also { it.source = source } }
    }

    @After
    fun forget() = PhoneSync.forgetForTests()

    private fun cyclesOverOneMinute(): Int {
        val before = device.syncs
        timers.advance(60_000)
        return device.syncs - before
    }

    @Test
    fun aControllerMadeWhileTheAppIsInFrontCyclesEveryFifteenSecondsAsAfterAnImport() {
        PhoneSync.enteredForeground()
        PhoneSync.controller(app)
        assertTrue("after the import the controller is made with the app already in front", device.calls.contains("active"))
        assertEquals(4, cyclesOverOneMinute())
    }

    @Test
    fun aControllerMadeBeforeTheAppComesToTheFrontStartsItsLoopWhenItDoes() {
        PhoneSync.controller(app)
        assertEquals("not in front yet: one launch cycle, no loop", 0, cyclesOverOneMinute())
        PhoneSync.enteredForeground()
        assertEquals(4, cyclesOverOneMinute())
        PhoneSync.enteredBackground()
        assertEquals(0, cyclesOverOneMinute())
    }

    @Test
    fun aTabSentFromTheMacArrivesWithinACycleWithoutATap() {
        PhoneSync.enteredForeground()
        val controller = PhoneSync.controller(app)
        timers.advance(1_000)
        device.pendingReceived = listOf(ReceivedTab(key = "send-1", url = "https://example.com/after-upgrade", title = "After", fromDevice = "Mac", sentAt = 1L, profileSyncId = "p", fromDeviceId = "mac-1"))
        timers.advance(15_000)
        assertEquals(listOf("https://example.com/after-upgrade"), controller.incoming.value.map { it.url })
    }
}
