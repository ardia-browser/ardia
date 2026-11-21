package com.ardia.phone

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import com.ardia.sync.FakeDevice
import com.ardia.sync.LocalBrowsingNotReady
import com.ardia.sync.ManualTimers
import com.ardia.sync.RecordingScheduler
import com.ardia.sync.SyncController
import com.ardia.sync.SyncControllerOwner
import com.ardia.sync.SyncWorker
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UpgradeGateTest {
    private val root = Files.createTempDirectory("upgrade-gate").toFile().apply { deleteOnExit() }
    private var controllersMade = 0

    private val app: Context = object : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this

        override fun getDataDir(): File = root

        override fun getFilesDir(): File = File(root, "files").apply { mkdirs() }

        override fun getNoBackupFilesDir(): File = File(root, "no_backup").apply { mkdirs() }

        override fun getCacheDir(): File = File(root, "cache").apply { mkdirs() }
    }

    private fun composeDatabase() = File(root, "databases/browser.db").apply {
        parentFile!!.mkdirs()
        writeText("compose")
    }

    private fun composePreferences(name: String) = File(root, "shared_prefs/$name.xml").apply {
        parentFile!!.mkdirs()
        writeText("<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map />\n")
    }

    private val receipt = UpgradeGate.Receipt(version = 1, tabs = 3, archive = 1, visits = 10, preferences = 4)

    @Before
    fun fakes() {
        UpgradeGate.forgetForTests()
        PhoneSync.makeRows = ::JdbcRows
        PhoneSync.makeController = { _, _ ->
            controllersMade += 1
            SyncController(FakeDevice(enabledOnStart = true), ManualTimers(), RecordingScheduler())
        }
    }

    @After
    fun forget() {
        PhoneSync.forgetForTests()
        PhoneSystemLinks.forgetForTests()
        UpgradeGate.forgetForTests()
    }

    @Test
    fun aComposeSourceWithoutAValidMarkerIsPending() {
        assertFalse(UpgradeGate.pending(app))
        UpgradeGate.forgetForTests()
        composePreferences("ardia.reader")
        assertTrue(UpgradeGate.pending(app))
        UpgradeGate.forgetForTests()
        composeDatabase()
        assertTrue(UpgradeGate.pending(app))
        File(app.noBackupFilesDir, "PhoneSync").mkdirs()
        UpgradeGate.markerFile(app).writeText("{}")
        UpgradeGate.forgetForTests()
        assertTrue(UpgradeGate.pending(app))
        UpgradeGate.markerFile(app).writeText("""{"version":2,"receipt":{"version":1,"tabs":1,"archive":0,"visits":0,"preferences":0}}""")
        UpgradeGate.forgetForTests()
        assertTrue(UpgradeGate.pending(app))
        UpgradeGate.writeMarker(app, receipt)
        UpgradeGate.forgetForTests()
        assertFalse(UpgradeGate.pending(app))
        assertEquals(receipt, UpgradeGate.marker(app))
    }

    @Test
    fun aControllerRequestedBeforeTheImportIsRefusedAndNoneIsMade() {
        composeDatabase()
        assertThrows(UpgradeGate.Pending::class.java) { PhoneSync.controller(app) }
        assertNull(PhoneSync.current())
        assertEquals(0, controllersMade)
        UpgradeGate.writeMarker(app, receipt)
        UpgradeGate.open(app)
        PhoneSync.controller(app)
        assertEquals(1, controllersMade)
    }

    @Test
    fun aWorkerFiringBeforeTheAppIsOpenedRetriesWithoutTouchingSync() {
        composeDatabase()
        var asked = 0
        val owner = object : SyncControllerOwner {
            override val syncController: SyncController
                get() {
                    asked += 1
                    return PhoneSync.controller(app)
                }

            override val isSyncReady: Boolean get() = !UpgradeGate.pending(app)
        }
        assertTrue(SyncWorker.holds(owner))
        assertEquals(0, asked)
        UpgradeGate.writeMarker(app, receipt)
        UpgradeGate.open(app)
        assertFalse(SyncWorker.holds(owner))
    }

    @Test
    fun theBrowsingSourceRefusesReadsWhilePendingInsteadOfReportingNothing() {
        composeDatabase()
        val source = PhoneBrowsingSource(JdbcRows(PhoneTestDatabase.database { }), PhoneInbox(File(root, "inbox.json")), isReady = { !UpgradeGate.pending(app) })
        assertThrows(LocalBrowsingNotReady::class.java) { source.syncedTabs() }
        assertThrows(LocalBrowsingNotReady::class.java) { source.readingTogether { source.syncedVisits(0L) } }
        UpgradeGate.writeMarker(app, receipt)
        UpgradeGate.open(app)
        assertEquals(emptyList<Any>(), source.syncedTabs())
    }

    @Test
    fun twoLinksArrivingWhilePendingAreDeliveredOnceInOrderAfter() {
        composeDatabase()
        UpgradeGate.install(app)
        val heard = ArrayList<String?>()
        PhoneSystemLinks.activityStarted(Intent(Intent.ACTION_VIEW, Uri.parse("https://one.example/")), restored = false)
        PhoneSystemLinks.listen { heard += it["url"] as String? }
        PhoneSystemLinks.receive(Intent(Intent.ACTION_VIEW, Uri.parse("https://two.example/")))
        assertNull(PhoneSystemLinks.takeInitial())
        assertTrue(heard.isEmpty())
        UpgradeGate.writeMarker(app, receipt)
        UpgradeGate.open(app)
        assertEquals(listOf("https://one.example/", "https://two.example/"), heard)
        UpgradeGate.open(app)
        assertEquals(2, heard.size)
    }

    private fun processDies() {
        PhoneSystemLinks.forgetForTests()
        UpgradeGate.forgetForTests()
    }

    @Test
    fun aLinkHeldWhileTheImportWaitsSurvivesTheProcessAndOpensOnceAfterALaterImport() {
        composeDatabase()
        UpgradeGate.install(app)
        PhoneSystemLinks.receive(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/held")))
        assertTrue(UpgradeGate.heldLinksFile(app).isFile)
        assertFalse("only the address is kept", UpgradeGate.heldLinksFile(app).readText().contains("title"))
        processDies()

        UpgradeGate.install(app)
        val heard = ArrayList<String?>()
        PhoneSystemLinks.activityStarted(Intent(Intent.ACTION_MAIN), restored = false)
        PhoneSystemLinks.listen { heard += it["url"] as String? }
        assertTrue("still held while the import waits", heard.isEmpty())
        UpgradeGate.writeMarker(app, receipt)
        UpgradeGate.open(app)
        assertEquals(listOf("https://example.com/held"), heard)
        assertFalse(UpgradeGate.heldLinksFile(app).exists())
        processDies()

        UpgradeGate.install(app)
        val later = ArrayList<String?>()
        PhoneSystemLinks.listen { later += it["url"] as String? }
        assertTrue("delivered once, never again", later.isEmpty())
    }

    @Test
    fun aLinkHeldBeforeStartWithoutThemOpensWhenTheAppStarts() {
        composeDatabase()
        UpgradeGate.install(app)
        PhoneSystemLinks.receive(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/before-fresh")))
        processDies()
        UpgradeGate.install(app)
        val heard = ArrayList<String?>()
        PhoneSystemLinks.listen { heard += it["url"] as String? }
        UpgradeGate.writeStartedFresh(app)
        UpgradeGate.open(app)
        assertEquals(listOf("https://example.com/before-fresh"), heard)
    }

    @Test
    fun heldLinksAreBoundedAndAFreshAppWithNothingPendingNeverWritesThem() {
        composeDatabase()
        UpgradeGate.install(app)
        for (index in 1..25) PhoneSystemLinks.receive(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/$index")))
        processDies()
        UpgradeGate.install(app)
        val heard = ArrayList<String?>()
        PhoneSystemLinks.listen { heard += it["url"] as String? }
        UpgradeGate.writeMarker(app, receipt)
        UpgradeGate.open(app)
        assertEquals((6..25).map { "https://example.com/$it" }, heard)
        processDies()

        UpgradeGate.install(app)
        PhoneSystemLinks.receive(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/normal")))
        assertFalse("nothing is pending, so nothing is kept on disk", UpgradeGate.heldLinksFile(app).exists())
    }
}
