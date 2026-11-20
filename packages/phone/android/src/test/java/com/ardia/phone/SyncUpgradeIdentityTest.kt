package com.ardia.phone

import com.ardia.sync.SyncFiles
import com.ardia.sync.SyncFolderLocation
import com.ardia.sync.SyncMeta
import com.ardia.sync.SyncPhase
import com.ardia.sync.SyncService
import com.ardia.sync.core.FileKeyStore
import com.ardia.sync.core.RecoveryPhrase
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncUpgradeIdentityTest {
    private val sync = Files.createTempDirectory("sync-upgrade").toFile()
    private val keys = File(sync, "Keys")
    private val folder = Files.createTempDirectory("sync-folder").toFile()

    private val unreachable = object : com.ardia.sync.LocalFolderAccess() {
        override fun resolve(location: SyncFolderLocation): com.ardia.sync.SyncFolderGrant? = null
    }

    private fun service() = SyncService(sync, FileKeyStore(keys), RuntimeEnvironment.getApplication().assets, unreachable)

    private fun startLeaveAndClose() = service().apply {
        start()
        resignedActive()
        close()
    }

    private fun keyFiles(): List<String> = keys.list()?.sorted().orEmpty()

    @Test
    fun aPhoneThatNeverConnectedGetsTheDefaultNameAndNoIdentity() {
        startLeaveAndClose()
        val meta = SyncFiles(sync).loadMeta()
        assertEquals(SyncMeta.DEFAULT_DEVICE_NAME, meta.deviceName)
        assertNull(meta.deviceId)
        assertFalse(meta.enabled)
        assertEquals(emptyList<String>(), keyFiles())
    }

    @Test
    fun aConnectedPhonesIdentityNameFolderAndKeySurviveTheNewAppStarting() {
        val location = SyncFolderLocation.Path(folder.path, "Ardia")
        SyncFiles(sync).saveMeta(SyncMeta(deviceId = "D1", deviceName = "Shivam's Poco", folder = location, enabled = true, setupAt = 1_000L))
        FileKeyStore(keys).save(ByteArray(RecoveryPhrase.ENTROPY_BYTES) { it.toByte() }, "D1")
        val before = keyFiles()

        val first = startLeaveAndClose()
        assertEquals("the folder isn't reachable here, so no engine is built", SyncPhase.NeedsFolderAccess, first.phase)
        startLeaveAndClose()

        val meta = SyncFiles(sync).loadMeta()
        assertEquals("D1", meta.deviceId)
        assertEquals("Shivam's Poco", meta.deviceName)
        assertEquals(location, meta.folder)
        assertEquals(1_000L, meta.setupAt)
        assertEquals(before, keyFiles())
        assertFalse("no fresh identity was prepared", File(sync, "sync-fresh.json").exists())
    }

    @Test
    fun aConnectedPhoneWhoseKeyIsMissingLocksInsteadOfMakingANewIdentity() {
        SyncFiles(sync).saveMeta(SyncMeta(deviceId = "D1", folder = SyncFolderLocation.Path(folder.path, "Ardia"), enabled = true))
        val started = service().apply { start() }
        assertEquals(SyncPhase.Locked, started.phase)
        started.resignedActive()
        started.close()
        assertEquals("D1", SyncFiles(sync).loadMeta().deviceId)
        assertEquals(emptyList<String>(), keyFiles())
    }
}
