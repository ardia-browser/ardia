package com.ardia.phone

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageCapabilitiesTest {
    private val root = Files.createTempDirectory("capabilities").toFile().apply { deleteOnExit() }

    private val app: Context = object : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this

        override fun getDataDir(): File = root

        override fun getFilesDir(): File = File(root, "files").apply { mkdirs() }

        override fun getNoBackupFilesDir(): File = File(root, "no_backup").apply { mkdirs() }
    }

    @After
    fun forget() = UpgradeGate.forgetForTests()

    @Test
    fun whileTheImportIsPendingTheCapabilitiesSayNotReadyInsteadOfThrowingAndMakeNoEngine() {
        File(root, "databases").mkdirs()
        File(root, "databases/browser.db").writeText("compose")
        UpgradeGate.forgetForTests()
        val payload = PageCapabilities.payload(app)
        assertEquals(false, payload["ready"])
        assertEquals(false, payload["supportsPrivatePages"])
        assertEquals(false, PhonePages.hasEngine())
    }
}
