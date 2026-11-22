package com.ardia.phone

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import com.ardia.browser.NightShadeMode
import java.io.File
import java.security.MessageDigest
import java.sql.Connection
import java.sql.DriverManager
import java.util.Base64
import org.json.JSONObject
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
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneLegacyTest {
    private val app: Context = RuntimeEnvironment.getApplication()
    private val data: File get() = UpgradeGate.dataDir(app)
    private val selectedId = "8F1C2E7A-0B4D-4C1E-9A3F-6D5B2C1E0F11"
    private val otherId = "C3D4E5F6-1111-2222-3333-444455556666"
    private val archivedId = "AA00BB11-CC22-DD33-EE44-FF5566778899"
    private val traversalId = "0000AAAA-BBBB-CCCC-DDDD-EEEEFFFF0000"
    private val state = ByteArray(300) { (it * 37 + 11).toByte() }.also { it[0] = 0; it[1] = 0xFF.toByte(); it[2] = 0 }
    private val archivedState = byteArrayOf(0, 1, 2, 0, 0xFE.toByte(), 0x80.toByte(), 0)
    private val receipt = UpgradeGate.Receipt(version = 1, tabs = 3, archive = 1, visits = 3, preferences = 9)
    private val killed = ArrayList<String>()

    private class Killed(step: String) : RuntimeException("killed after $step")

    init {
        Class.forName("org.sqlite.JDBC")
    }

    @Before
    fun clean() {
        listOf("databases", "shared_prefs", "cache/TabSnapshots", "files/PageSnapshots", "no_backup/PhoneSync").forEach { File(data, it).deleteRecursively() }
        File(app.noBackupFilesDir, "PhoneSync").deleteRecursively()
        File(app.filesDir, "PageSnapshots").deleteRecursively()
        File(app.cacheDir, "TabSnapshots").deleteRecursively()
        targets().forEach { it.edit().clear().commit() }
        UpgradeGate.forgetForTests()
    }

    @After
    fun forget() {
        PhoneSystemLinks.forgetForTests()
        UpgradeGate.forgetForTests()
    }

    private fun targets() = listOf(app.getSharedPreferences(PhoneBlocking.PREFERENCES, Context.MODE_PRIVATE), app.getSharedPreferences("ardia-site-preferences", Context.MODE_PRIVATE))

    private fun composeStore(version: Int = 1, schema: List<String> = COMPOSE_SCHEMA, seed: (Connection) -> Unit = ::seedRows) {
        val scratch = kotlin.io.path.createTempDirectory("compose-store").toFile()
        val file = File(scratch, "browser.db")
        DriverManager.getConnection("jdbc:sqlite:${file.path}").use { connection ->
            connection.createStatement().use { statement ->
                statement.execute("PRAGMA journal_mode = WAL")
                statement.execute("PRAGMA wal_autocheckpoint = 0")
                schema.forEach(statement::execute)
                statement.execute("PRAGMA user_version = $version")
            }
            seed(connection)
            val target = File(data, "databases").apply { mkdirs() }
            val wal = File(scratch, "browser.db-wal")
            assertTrue("the fixture keeps its rows in the WAL", wal.length() > 0)
            file.copyTo(File(target, "browser.db"), overwrite = true)
            wal.copyTo(File(target, "browser.db-wal"), overwrite = true)
        }
        scratch.deleteRecursively()
    }

    private fun seedRows(connection: Connection) {
        connection.insertTab(selectedId, "https://news.example/today", lastActive = 3_000, position = 2.0, snapshot = "$selectedId.jpg", favicon = "https://news.example/favicon.ico", theme = "#112233", state = state)
        connection.insertTab(otherId, "https://docs.example/", lastActive = 2_000, position = 1.0, snapshot = "not-an-image.jpg", received = "mac-key" to "Shivam's Mac")
        connection.insertTab(traversalId, "https://far.example/", lastActive = 1_000, position = 3.0, snapshot = "../../shared_prefs/ardia.browser.xml")
        connection.insertTab(archivedId, "https://old.example/", lastActive = 500, position = 0.5, archived = 900, snapshot = "$archivedId.jpg", state = archivedState)
        for (index in 1..3) {
            connection.prepareStatement("INSERT INTO visits (url, title, visitedAt, profileSyncId, transition) VALUES (?, ?, ?, ?, ?)").use {
                it.setString(1, "https://visit.example/$index")
                it.setString(2, "Visit $index")
                it.setLong(3, 10_000L + index)
                it.setString(4, if (index == 2) "profile-b" else null)
                it.setString(5, if (index == 1) "typed" else "link")
                it.execute()
            }
        }
    }

    private fun Connection.insertTab(
        id: String,
        url: String,
        lastActive: Long,
        position: Double,
        archived: Long? = null,
        snapshot: String? = null,
        favicon: String? = null,
        theme: String? = null,
        received: Pair<String, String>? = null,
        state: ByteArray? = null,
    ) {
        prepareStatement(
            "INSERT INTO tabs (id, url, title, created, lastActive, archivedAt, position, profileSyncId, faviconUrl, themeColorHex, snapshotFileName, origin, receivedKey, receivedFromDevice) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        ).use {
            it.setString(1, id)
            it.setString(2, url)
            it.setString(3, "Title of $url")
            it.setLong(4, lastActive - 100)
            it.setLong(5, lastActive)
            if (archived == null) it.setNull(6, java.sql.Types.INTEGER) else it.setLong(6, archived)
            it.setDouble(7, position)
            it.setString(8, favicon)
            it.setString(9, theme)
            it.setString(10, snapshot)
            it.setString(11, if (received != null) "sent" else "typed")
            it.setString(12, received?.first)
            it.setString(13, received?.second)
            it.execute()
        }
        if (state != null) {
            prepareStatement("INSERT INTO tab_state (id, data) VALUES (?, ?)").use {
                it.setString(1, id)
                it.setBytes(2, state)
                it.execute()
            }
        }
    }

    private fun composePreferences(name: String, body: String) = File(data, "shared_prefs/$name.xml").apply {
        parentFile!!.mkdirs()
        writeText("<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n$body</map>\n")
    }

    private fun composePreferenceFiles() {
        val sites = JSONObject()
            .put("www.News.example", JSONObject().put("pageZoom", 1.25).put("nightShade", "always"))
            .put("docs.example", JSONObject().put("appLinks", "app").put("desktopSite", true))
            .put("ads.example", JSONObject().put("blockersOff", true).put("nightShade", "disabled"))
        composePreferences(
            "ardia.browser",
            """
            |    <string name="tabs.autoArchiveInterval">week</string>
            |    <string name="browsing.nightShade">automatic</string>
            |    <string name="browsing.swipeNavigation">edges</string>
            |    <string name="browsing.appLinks">app</string>
            |    <boolean name="browsing.searchSuggestions" value="false" />
            |    <string name="browsing.searchEngine">duckduckgo</string>
            |    <boolean name="settings.finishedOnboarding" value="true" />
            |    <string name="browsing.sites">${sites.toString().replace("&", "&amp;").replace("\"", "&quot;")}</string>
            |    <string name="unrelated.key">ignored</string>
            |""".trimMargin(),
        )
        composePreferences(
            "ardia.blocking",
            """
            |    <boolean name="blocking.ads" value="false" />
            |    <string name="blocking.exemptHosts">[&quot;bank.example&quot;]</string>
            |    <string name="filters.selection">[&quot;easylist&quot;,&quot;ublock-privacy&quot;]</string>
            |    <string name="filters.myFilters">||tracker.example^</string>
            |    <boolean name="filters.phoneDefaults" value="true" />
            |""".trimMargin(),
        )
        composePreferences(
            "ardia.reader",
            """
            |    <int name="reader.sizeStep" value="3" />
            |    <boolean name="reader.serif" value="true" />
            |""".trimMargin(),
        )
    }

    private fun thumbnails() {
        val folder = File(app.cacheDir, "TabSnapshots").apply { mkdirs() }
        val picture = Bitmap.createBitmap(40, 80, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(30, 90, 160)) }
        File(folder, "$selectedId.jpg").outputStream().use { picture.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        File(folder, "$archivedId.jpg").outputStream().use { picture.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        File(folder, "not-an-image.jpg").writeText("this is text, not a picture")
    }

    private fun composeApp() {
        composeStore()
        composePreferenceFiles()
        thumbnails()
    }

    private fun sourceFingerprint(): Map<String, String> =
        (listOf(File(data, "databases"), File(data, "shared_prefs"), File(app.cacheDir, "TabSnapshots")))
            .flatMap { folder -> folder.walkTopDown().filter { it.isFile && !it.name.startsWith("ardia-") }.toList() }
            .associate { it.relativeTo(data).path to MessageDigest.getInstance("SHA-256").digest(it.readBytes()).joinToString("") { b -> "%02x".format(b) } }

    private fun targetState(): Map<String, Any?> = buildMap {
        targets().forEach { prefs -> prefs.all.forEach { (key, value) -> put("${key}", if (value is String && value.startsWith("{")) JSONObject(value).toString() else value) } }
        put("thumbnails", File(app.filesDir, "PageSnapshots").list()?.filterNot { it.startsWith(".") }?.map { it.replace(Regex("-\\d+-(\\d+x\\d+)\\.jpg$"), "-T-$1.jpg") }?.sorted())
        put("marker", UpgradeGate.marker(app))
    }

    private fun legacy(killAt: String? = null) = PhoneLegacy(app, reached = { step ->
        if (step == killAt) {
            killed += step
            throw Killed(step)
        }
    })

    @Test
    fun aComposeVersionOneStoreIsReadWholeIncludingRowsOnlyInItsWal() {
        composeApp()
        val before = sourceFingerprint()
        val source = legacy().source()
        assertEquals("pending", source["kind"])
        assertEquals(mapOf("tabs" to 3.0, "archive" to 1.0, "visits" to 3.0), source["counts"])

        val read = legacy().read()
        @Suppress("UNCHECKED_CAST")
        val tabs = read["tabs"] as List<Map<String, Any?>>
        @Suppress("UNCHECKED_CAST")
        val archive = read["archive"] as List<Map<String, Any?>>
        assertEquals(listOf(otherId, selectedId, traversalId), tabs.map { it["id"] })
        assertEquals(selectedId, read["selectedTabId"])
        val selected = tabs.first { it["id"] == selectedId }
        assertEquals(state.toList(), Base64.getDecoder().decode(selected["savedState"] as String).toList())
        assertEquals("#112233", selected["themeColor"])
        assertEquals("https://news.example/favicon.ico", selected["faviconUrl"])
        assertEquals(3_000.0, selected["lastActive"])
        assertEquals("typed", selected["origin"])
        val snapshot = File(selected["snapshotPath"] as String)
        assertEquals(File(app.filesDir, "PageSnapshots"), snapshot.parentFile)
        assertTrue(snapshot.name.startsWith(PageSnapshots.fileStem(selectedId) + "-"))
        assertTrue(snapshot.name.endsWith("-40x80.jpg"))
        assertFalse("reading copies nothing", snapshot.exists())
        val other = tabs.first { it["id"] == otherId }
        assertNull(other["snapshotPath"])
        assertNull(other["savedState"])
        assertEquals("mac-key", other["receivedKey"])
        assertEquals("Shivam's Mac", other["receivedFromDevice"])
        assertEquals("sent", other["origin"])
        assertNull(tabs.first { it["id"] == traversalId }["snapshotPath"])
        assertEquals(listOf(archivedId), archive.map { it["id"] })
        assertEquals(archivedState.toList(), Base64.getDecoder().decode(archive[0]["savedState"] as String).toList())
        assertEquals(900.0, archive[0]["archivedAt"])
        val archivedSnapshot = File(archive[0]["snapshotPath"] as String)
        assertEquals(File(app.filesDir, "PageSnapshots"), archivedSnapshot.parentFile)
        assertTrue(archivedSnapshot.name.startsWith(PageSnapshots.fileStem(archivedId) + "-"))
        assertFalse("reading copies nothing", archivedSnapshot.exists())
        assertEquals(
            mapOf(
                "tabs.autoArchiveInterval" to "week",
                "browsing.nightShade" to "automatic",
                "browsing.swipeNavigation" to "edges",
                "browsing.appLinks" to "app",
                "browsing.searchSuggestions" to "false",
                "browsing.searchEngine" to "duckduckgo",
                "settings.finishedOnboarding" to "true",
                "reader.sizeStep" to "3",
                "reader.serif" to "true",
            ),
            read["preferences"],
        )
        assertEquals(before, sourceFingerprint())
        assertFalse(File(data, "databases/browser.db-shm").exists())
    }

    @Test
    fun visitsArePagedByIdUntilTheLastPage() {
        composeApp()
        val first = legacy().readVisits(0, 2)
        @Suppress("UNCHECKED_CAST")
        val visits = first["visits"] as List<Map<String, Any?>>
        assertEquals(listOf("https://visit.example/1", "https://visit.example/2"), visits.map { it["url"] })
        assertEquals("typed", visits[0]["transition"])
        assertEquals("profile-b", visits[1]["profileSyncId"])
        assertFalse(visits[0].containsKey("profileSyncId"))
        assertEquals(2.0, first["next"])
        val second = legacy().readVisits(2, 2)
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("https://visit.example/3"), (second["visits"] as List<Map<String, Any?>>).map { it["url"] })
        assertNull(second["next"])
    }

    @Test
    fun aNewerOrDifferentSchemaIsReportedAsUnsupportedNotEmpty() {
        composeStore(version = 2)
        assertEquals(mapOf("kind" to "unusable", "reason" to "schema"), legacy().source())
        assertEquals("schema", assertThrows(LegacyUnusable::class.java) { legacy().read() }.reason)
        clean()
        composeStore(schema = COMPOSE_SCHEMA.map { it.replace(", receivedFromDevice TEXT)", ")") }, seed = {})
        assertEquals(mapOf("kind" to "unusable", "reason" to "schema"), legacy().source())
    }

    @Test
    fun aCorruptDatabaseOrPreferenceFileIsReportedAsCorruptNotEmpty() {
        File(data, "databases").mkdirs()
        File(data, "databases/browser.db").writeBytes(ByteArray(8192) { (it % 251).toByte() })
        val before = sourceFingerprint()
        assertEquals(mapOf("kind" to "unusable", "reason" to "corrupt"), legacy().source())
        assertEquals("corrupt", assertThrows(LegacyUnusable::class.java) { legacy().read() }.reason)
        assertEquals(before, sourceFingerprint())
        clean()
        composeStore()
        composePreferences("ardia.reader", "    <int name=\"reader.sizeStep\" value=\"big\" />\n")
        assertEquals(mapOf("kind" to "unusable", "reason" to "corrupt"), legacy().source())
        File(data, "shared_prefs/ardia.reader.xml").writeText("")
        assertEquals(mapOf("kind" to "unusable", "reason" to "corrupt"), legacy().source())
    }

    @Test
    fun nativeSettingsLandInTheExpoStoresAndApplyingTwiceChangesNothing() {
        composeApp()
        val before = sourceFingerprint()
        legacy().applyNativeSettings()
        val once = targetState()
        legacy().applyNativeSettings()
        assertEquals(once, targetState())
        assertEquals(before, sourceFingerprint())

        val blocking = app.getSharedPreferences(PhoneBlocking.PREFERENCES, Context.MODE_PRIVATE)
        assertEquals(false, blocking.getBoolean("blocking.ads", true))
        assertEquals("[\"ads.example\",\"bank.example\"]", blocking.getString("blocking.exemptHosts", null))
        assertTrue(com.ardia.blocking.BlockingSettings(com.ardia.blocking.SharedPreferencesBlockingStore(blocking)).isExempt("www.ads.example"))
        assertEquals("[\"easylist\",\"ublock-privacy\"]", blocking.getString("filters.selection", null))
        assertEquals("||tracker.example^", blocking.getString("filters.myFilters", null))
        val sites = PhoneSitePreferences(app.getSharedPreferences("ardia-site-preferences", Context.MODE_PRIVATE))
        assertEquals(NightShadeMode.Automatic, sites.defaultNightShade)
        assertTrue(sites.defaultOpensLinksInApps)
        assertEquals(1.25, sites.pageZoom("news.example", false)!!, 0.0)
        assertEquals(NightShadeMode.Always, sites.siteNightShade("news.example", false))
        assertEquals(NightShadeMode.Disabled, sites.siteNightShade("ads.example", false))
        assertEquals(true, sites.siteOpensLinksInApps("docs.example"))
        val raw = app.getSharedPreferences("ardia-site-preferences", Context.MODE_PRIVATE)
        assertEquals(true, sites.desktopSite("www.docs.example", false))
        assertEquals(null, sites.desktopSite("news.example", false))
        assertFalse(raw.contains("blockersOff.sites"))

        val copied = File(app.filesDir, "PageSnapshots").listFiles()!!.toList()
        assertEquals("the selected tab's and the archived tab's, not the fake image or the path outside", 2, copied.size)
        val read = legacy().read()
        for ((id, list) in listOf(selectedId to "tabs", archivedId to "archive")) {
            val file = copied.single { it.name.startsWith(PageSnapshots.fileStem(id) + "-") }
            assertEquals(File(app.cacheDir, "TabSnapshots/$id.jpg").readBytes().toList(), file.readBytes().toList())
            @Suppress("UNCHECKED_CAST")
            val reported = (read[list] as List<Map<String, Any?>>).first { it["id"] == id }["snapshotPath"]
            assertEquals(file.absolutePath, reported)
        }
    }

    @Test
    fun markingImportedWritesTheMarkerLastOpensTheGateAndStartsSyncOnce() {
        composeApp()
        UpgradeGate.install(app)
        assertTrue(UpgradeGate.pending(app))
        assertThrows(IllegalArgumentException::class.java) { legacy().markImported(receipt.copy(version = 2)) { } }
        assertNull(UpgradeGate.marker(app))
        var syncs = 0
        legacy().markImported(receipt) { syncs += 1 }
        assertEquals(1, syncs)
        assertEquals(receipt, UpgradeGate.marker(app))
        assertFalse(UpgradeGate.pending(app))
        assertEquals(mapOf("kind" to "done", "outcome" to "imported"), legacy().source())
        assertFalse(File(app.noBackupFilesDir, "PhoneSync/LegacySnapshot").exists())
        UpgradeGate.forgetForTests()
        assertFalse("a relaunch doesn't import again", UpgradeGate.pending(app))
    }

    @Test
    fun aKillAfterEachDurableStepLeavesTheGateClosedUntilARetryFinishesTheSameWay() {
        composeApp()
        var syncs = 0
        legacy().markImported(receipt) { syncs += 1 }
        val expected = targetState()
        val steps = listOf("snapshotCopied", "blocking", "sites", "thumbnail", "marker", "snapshotRemoved")
        for (step in steps) {
            clean()
            composeApp()
            syncs = 0
            assertThrows(Killed::class.java) { legacy(killAt = step).markImported(receipt) { syncs += 1 } }
            assertEquals(0, syncs)
            UpgradeGate.forgetForTests()
            val markerWritten = steps.indexOf(step) >= steps.indexOf("marker")
            assertEquals("pending after a kill at $step", !markerWritten, UpgradeGate.pending(app))
            legacy().markImported(receipt) { syncs += 1 }
            assertEquals("one sync after a retry from $step", 1, syncs)
            assertEquals("same result after a kill at $step", expected, targetState())
            assertFalse(UpgradeGate.pending(app))
        }
        assertEquals(steps, killed)
    }

    @Test
    fun startingFreshOpensTheGateOnceLeavesComposeUntouchedAndAMarkerALaterImportCanStillReplace() {
        composeApp()
        UpgradeGate.install(app)
        val heard = ArrayList<String?>()
        PhoneSystemLinks.listen { heard += it["url"] as String? }
        PhoneSystemLinks.receive(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://held.example/")))
        legacy().source()
        val before = sourceFingerprint()
        var syncs = 0
        legacy().startFresh { syncs += 1 }
        assertEquals(1, syncs)
        assertFalse(UpgradeGate.pending(app))
        assertEquals(listOf("https://held.example/"), heard)
        assertEquals(UpgradeGate.Completion.StartedFresh, UpgradeGate.completion(app))
        assertNull("starting fresh is not an import", UpgradeGate.marker(app))
        assertEquals(mapOf("kind" to "done", "outcome" to "startedFresh"), legacy().source())
        assertEquals(before, sourceFingerprint())
        val blocking = app.getSharedPreferences(PhoneBlocking.PREFERENCES, Context.MODE_PRIVATE)
        assertEquals("the old blocking settings are kept", false, blocking.getBoolean("blocking.ads", true))
        assertEquals("||tracker.example^", blocking.getString("filters.myFilters", null))
        assertEquals("[\"ads.example\",\"bank.example\"]", blocking.getString("blocking.exemptHosts", null))
        val sites = PhoneSitePreferences(app.getSharedPreferences("ardia-site-preferences", Context.MODE_PRIVATE))
        assertEquals(1.25, sites.pageZoom("news.example", false)!!, 0.0)
        assertEquals("no thumbnails without an import", null, File(app.filesDir, "PageSnapshots").list()?.takeIf { it.isNotEmpty() })
        UpgradeGate.forgetForTests()
        assertFalse("a relaunch stays open", UpgradeGate.pending(app))
        legacy().startFresh { syncs += 1 }
        assertEquals(2, syncs)
        assertEquals(UpgradeGate.Completion.StartedFresh, UpgradeGate.completion(app))

        legacy().markImported(receipt) { syncs += 1 }
        assertEquals(UpgradeGate.Completion.Imported(receipt), UpgradeGate.completion(app))
        assertEquals(false, app.getSharedPreferences(PhoneBlocking.PREFERENCES, Context.MODE_PRIVATE).getBoolean("blocking.ads", true))
        legacy().startFresh { syncs += 1 }
        assertEquals("starting fresh never undoes an import", UpgradeGate.Completion.Imported(receipt), UpgradeGate.completion(app))
    }

    @Test
    fun startingFreshWithUnreadableSettingsCarriesOnWithDefaultsForThatFileOnly() {
        composeApp()
        File(data, "shared_prefs/ardia.blocking.xml").writeText("not xml at all")
        var syncs = 0
        legacy().startFresh { syncs += 1 }
        assertEquals(1, syncs)
        assertEquals(UpgradeGate.Completion.StartedFresh, UpgradeGate.completion(app))
        assertFalse(UpgradeGate.pending(app))
        val blocking = app.getSharedPreferences(PhoneBlocking.PREFERENCES, Context.MODE_PRIVATE).all
        assertEquals("only the per-site file's blockers-off host, nothing from the unreadable file", mapOf("blocking.exemptHosts" to "[\"ads.example\"]"), blocking)
        val sites = PhoneSitePreferences(app.getSharedPreferences("ardia-site-preferences", Context.MODE_PRIVATE))
        assertEquals("the readable file still comes over", 1.25, sites.pageZoom("news.example", false)!!, 0.0)
        assertEquals("not xml at all", File(data, "shared_prefs/ardia.blocking.xml").readText())
    }

    @Test
    fun theLabCanMakeTheSourceUnusableWithoutTouchingComposeAndOnlyInALabBuild() {
        composeApp()
        val before = sourceFingerprint()
        PhoneLegacy(app, lab = true).setLabUnusable(true)
        assertEquals(mapOf("kind" to "unusable", "reason" to "io"), PhoneLegacy(app, lab = true).source())
        assertEquals("pending", PhoneLegacy(app, lab = false).source()["kind"])
        assertThrows(IllegalStateException::class.java) { PhoneLegacy(app, lab = false).setLabUnusable(true) }
        PhoneLegacy(app, lab = true).setLabUnusable(false)
        assertEquals("pending", PhoneLegacy(app, lab = true).source()["kind"])
        assertEquals(before, sourceFingerprint())
        assertTrue(UpgradeGate.pending(app))
    }

    @Test
    fun aComposeAppWithOnlyPreferencesIsPendingWithNoRows() {
        composePreferenceFiles()
        assertEquals(mapOf("kind" to "pending", "counts" to mapOf("tabs" to 0.0, "archive" to 0.0, "visits" to 0.0)), legacy().source())
        val read = legacy().read()
        assertEquals(emptyList<Any>(), read["tabs"])
        assertNull(read["selectedTabId"])
        assertEquals(mapOf("kind" to "none"), run {
            clean()
            legacy().source()
        })
    }

    companion object {
        val COMPOSE_SCHEMA = listOf(
            "CREATE TABLE tabs (id TEXT PRIMARY KEY NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, " +
                "lastActive INTEGER NOT NULL, archivedAt INTEGER, position REAL NOT NULL, profileSyncId TEXT, faviconUrl TEXT, " +
                "themeColorHex TEXT, snapshotFileName TEXT, origin TEXT NOT NULL, receivedKey TEXT, receivedFromDevice TEXT)",
            "CREATE INDEX tabs_archivedAt ON tabs(archivedAt)",
            "CREATE INDEX tabs_receivedKey ON tabs(receivedKey) WHERE receivedKey IS NOT NULL",
            "CREATE TABLE tab_state (id TEXT PRIMARY KEY NOT NULL, data BLOB NOT NULL)",
            "CREATE TABLE visits (id INTEGER PRIMARY KEY NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, visitedAt INTEGER NOT NULL, " +
                "profileSyncId TEXT, transition TEXT NOT NULL)",
            "CREATE INDEX visits_url ON visits(url)",
            "CREATE INDEX visits_visitedAt ON visits(visitedAt)",
            "CREATE INDEX visits_profile_visitedAt ON visits(profileSyncId, visitedAt)",
        )
    }
}
