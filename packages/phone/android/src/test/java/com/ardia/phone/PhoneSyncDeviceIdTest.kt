package com.ardia.phone

import android.content.Context
import android.content.ContextWrapper
import com.ardia.sync.SyncFiles
import com.ardia.sync.SyncMeta
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneSyncDeviceIdTest {
    private val root = Files.createTempDirectory("phone-device-id").toFile().apply { deleteOnExit() }

    private val app: Context = object : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this

        override fun getNoBackupFilesDir(): File = File(root, "no_backup").apply { mkdirs() }
    }

    @After
    fun forget() = PhoneSync.forgetForTests()

    private fun sync() = SyncFiles(File(app.noBackupFilesDir, "Sync"))

    @Test
    fun thePhonesOwnSyncIdIsReadOnlyWhileSyncIsOn() {
        assertNull("never connected", PhoneSync.ownDeviceId(app))
        sync().saveMeta(SyncMeta(deviceId = "phone-1", enabled = true))
        assertEquals("phone-1", PhoneSync.ownDeviceId(app))
        sync().saveMeta(SyncMeta(deviceId = "phone-1", enabled = false))
        assertNull("sync stopped", PhoneSync.ownDeviceId(app))
    }
}
