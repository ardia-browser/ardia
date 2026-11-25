package com.ardia.phone

import android.content.Context
import android.database.Cursor
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteCantOpenDatabaseException
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteDatabaseLockedException
import android.database.sqlite.SQLiteException
import android.graphics.BitmapFactory
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Base64
import org.json.JSONObject

interface LegacyDatabase : AutoCloseable {
    fun query(sql: String, args: List<String> = emptyList()): List<List<Any?>>
}

class AndroidLegacyDatabase(file: File) : LegacyDatabase {
    private val database: SQLiteDatabase = try {
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.NO_LOCALIZED_COLLATORS, DatabaseErrorHandler { })
    } catch (error: SQLiteException) {
        throw LegacyUnusable(PhoneLegacy.reasonOf(error))
    }

    override fun query(sql: String, args: List<String>): List<List<Any?>> = try {
        database.rawQuery(sql, args.toTypedArray()).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(List(cursor.columnCount) { column -> value(cursor, column) })
            }
        }
    } catch (error: SQLiteException) {
        throw LegacyUnusable(PhoneLegacy.reasonOf(error))
    }

    override fun close() = database.close()

    private fun value(cursor: Cursor, column: Int): Any? = when (cursor.getType(column)) {
        Cursor.FIELD_TYPE_NULL -> null
        Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(column)
        Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(column)
        Cursor.FIELD_TYPE_BLOB -> cursor.getBlob(column)
        else -> cursor.getString(column)
    }
}

class PhoneLegacy(
    private val context: Context,
    private val openDatabase: (File) -> LegacyDatabase = ::AndroidLegacyDatabase,
    private val reached: (String) -> Unit = {},
    private val lab: Boolean = PhoneLab.isOn,
) {
    private val app: Context = context.applicationContext ?: context
    private val dataDir: File get() = UpgradeGate.dataDir(app)
    private val sourceDatabase: File get() = File(dataDir, "databases/$DATABASE_FILE")
    private val sourceWal: File get() = File(dataDir, "databases/$DATABASE_FILE-wal")
    private val snapshotFolder: File get() = File(File(app.noBackupFilesDir, "PhoneSync"), "LegacySnapshot")
    private val oldThumbnails: File get() = File(app.cacheDir, "TabSnapshots")
    private val newThumbnails: File get() = File(app.filesDir, "PageSnapshots")
    private val labUnusableFlag: File get() = File(File(app.noBackupFilesDir, "PhoneSync"), "lab-legacy-unusable")

    fun setLabUnusable(on: Boolean) {
        check(lab) { "making the old app's data unusable is a lab switch" }
        if (on) {
            labUnusableFlag.parentFile?.mkdirs()
            labUnusableFlag.writeText("io")
        } else {
            labUnusableFlag.delete()
        }
    }

    private fun preferences(name: String): Map<String, Any> = LegacyPreferencesFile.read(File(dataDir, "shared_prefs/$name.xml"))

    fun source(): Map<String, Any?> = synchronized(LOCK) {
        when (UpgradeGate.completion(app)) {
            is UpgradeGate.Completion.Imported -> return mapOf("kind" to "done", "outcome" to "imported")
            UpgradeGate.Completion.StartedFresh -> return mapOf("kind" to "done", "outcome" to "startedFresh")
            null -> Unit
        }
        if (!UpgradeGate.composeSourceExists(app)) return mapOf("kind" to "none")
        if (lab && labUnusableFlag.isFile) return mapOf("kind" to "unusable", "reason" to "io")
        try {
            PREFERENCE_FILES.forEach(::preferences)
            val counts = if (sourceDatabase.exists()) withDatabase(::counts) else Triple(0L, 0L, 0L)
            mapOf("kind" to "pending", "counts" to mapOf("tabs" to counts.first.toDouble(), "archive" to counts.second.toDouble(), "visits" to counts.third.toDouble()))
        } catch (unusable: LegacyUnusable) {
            mapOf("kind" to "unusable", "reason" to unusable.reason)
        }
    }

    fun read(): Map<String, Any?> = synchronized(LOCK) {
        val rows = if (sourceDatabase.exists()) withDatabase(::tabRows) else emptyList()
        val regular = rows.filter { it.archivedAt == null }
        val archive = rows.filter { it.archivedAt != null }
        mapOf(
            "tabs" to regular.map { payload(it, planThumbnail(it)) },
            "archive" to archive.map { payload(it, planThumbnail(it)) },
            "selectedTabId" to regular.maxByOrNull { it.lastActive }?.id,
            "preferences" to storePreferences(),
        )
    }

    fun readVisits(afterId: Long, limit: Int): Map<String, Any?> = synchronized(LOCK) {
        val size = limit.coerceIn(1, VISIT_PAGE_LIMIT)
        if (!sourceDatabase.exists()) return mapOf("visits" to emptyList<Any>(), "next" to null)
        val rows = withDatabase { db ->
            db.query("SELECT id, url, title, visitedAt, profileSyncId, transition FROM visits WHERE id > ? ORDER BY id LIMIT ?", listOf("$afterId", "$size"))
        }
        val visits = rows.map { row ->
            buildMap {
                put("id", (row[0] as Number).toDouble())
                put("url", row[1] as String)
                put("title", row[2] as String)
                put("visitedAt", (row[3] as Number).toDouble())
                (row[4] as String?)?.let { put("profileSyncId", it) }
                put("transition", row[5] as String)
            }
        }
        val last = rows.lastOrNull()?.let { (it[0] as Number).toDouble() }
        mapOf("visits" to visits, "next" to if (rows.size == size) last else null)
    }

    fun applyNativeSettings() = synchronized(LOCK) {
        reached("settingsStart")
        applyBlocking()
        reached("blocking")
        applySites()
        reached("sites")
        if (sourceDatabase.exists()) {
            withDatabase(::tabRows).forEach { tab ->
                planThumbnail(tab)?.let {
                    copyThumbnail(it)
                    reached("thumbnail")
                }
            }
        }
        reached("settingsDone")
    }

    fun markImported(receipt: UpgradeGate.Receipt, startSync: () -> Unit) = synchronized(LOCK) {
        if (!receipt.isValid()) throw IllegalArgumentException("the import receipt is not valid")
        if (UpgradeGate.marker(app) == null) {
            applyNativeSettings()
            reached("beforeMarker")
            UpgradeGate.writeMarker(app, receipt)
            reached("marker")
        }
        UpgradeGate.open(app)
        if (UpgradeGate.pending(app)) throw IOException("the import marker was written but the gate is still closed")
        snapshotFolder.deleteRecursively()
        reached("snapshotRemoved")
        startSync()
    }

    fun startFresh(startSync: () -> Unit) = synchronized(LOCK) {
        if (UpgradeGate.completion(app) == null) {
            keepSettingsIfReadable()
            UpgradeGate.writeStartedFresh(app)
            reached("marker")
        }
        UpgradeGate.open(app)
        if (UpgradeGate.pending(app)) throw IOException("the start-fresh marker was written but the gate is still closed")
        snapshotFolder.deleteRecursively()
        startSync()
    }

    private fun keepSettingsIfReadable() {
        for ((name, apply) in listOf("blocking" to ::applyBlocking, "site" to ::applySites)) {
            try {
                apply()
            } catch (unreadable: Exception) {
                if (PhoneLab.isOn) android.util.Log.i("PAGELAB", "PAGELAB upgrade start fresh: the old $name settings could not be read, defaults kept (${unreadable.javaClass.simpleName})")
            }
        }
    }

    private data class TabRow(
        val id: String,
        val url: String,
        val title: String,
        val created: Long,
        val lastActive: Long,
        val archivedAt: Long?,
        val position: Double,
        val profileSyncId: String?,
        val faviconUrl: String?,
        val themeColorHex: String?,
        val snapshotFileName: String?,
        val origin: String,
        val receivedKey: String?,
        val receivedFromDevice: String?,
        val state: ByteArray?,
    )

    private data class Thumbnail(val source: File, val target: File)

    private fun counts(db: LegacyDatabase): Triple<Long, Long, Long> = Triple(
        (db.query("SELECT COUNT(*) FROM tabs WHERE archivedAt IS NULL").first().first() as Number).toLong(),
        (db.query("SELECT COUNT(*) FROM tabs WHERE archivedAt IS NOT NULL").first().first() as Number).toLong(),
        (db.query("SELECT COUNT(*) FROM visits").first().first() as Number).toLong(),
    )

    private fun tabRows(db: LegacyDatabase): List<TabRow> {
        val states = db.query("SELECT tab_state.id, tab_state.data FROM tab_state JOIN tabs ON tabs.id = tab_state.id").associate { (it[0] as String) to bytes(it[1]) }
        return db.query("SELECT $TAB_COLUMNS FROM tabs ORDER BY position, id").map { row ->
            TabRow(
                id = row[0] as String,
                url = row[1] as String,
                title = row[2] as String,
                created = (row[3] as Number).toLong(),
                lastActive = (row[4] as Number).toLong(),
                archivedAt = (row[5] as Number?)?.toLong(),
                position = (row[6] as Number).toDouble(),
                profileSyncId = row[7] as String?,
                faviconUrl = row[8] as String?,
                themeColorHex = row[9] as String?,
                snapshotFileName = row[10] as String?,
                origin = row[11] as String,
                receivedKey = row[12] as String?,
                receivedFromDevice = row[13] as String?,
                state = states[row[0] as String],
            )
        }
    }

    private fun bytes(value: Any?): ByteArray? = when (value) {
        is ByteArray -> value
        is String -> value.toByteArray(Charsets.ISO_8859_1)
        else -> null
    }

    private fun payload(tab: TabRow, thumbnail: Thumbnail?): Map<String, Any?> = buildMap {
        put("id", tab.id)
        put("url", tab.url)
        put("title", tab.title)
        put("created", tab.created.toDouble())
        put("lastActive", tab.lastActive.toDouble())
        put("position", tab.position)
        put("origin", tab.origin)
        tab.archivedAt?.let { put("archivedAt", it.toDouble()) }
        tab.profileSyncId?.let { put("profileSyncId", it) }
        tab.state?.let { put("savedState", Base64.getEncoder().encodeToString(it)) }
        tab.faviconUrl?.let { put("faviconUrl", it) }
        tab.themeColorHex?.let { put("themeColor", it) }
        thumbnail?.let { put("snapshotPath", it.target.absolutePath) }
        tab.receivedKey?.let { put("receivedKey", it) }
        tab.receivedFromDevice?.let { put("receivedFromDevice", it) }
    }

    private fun planThumbnail(tab: TabRow): Thumbnail? {
        val name = tab.snapshotFileName?.takeIf { it.isNotBlank() } ?: return null
        val folder = runCatching { oldThumbnails.canonicalFile }.getOrNull() ?: return null
        val source = runCatching { File(folder, name).canonicalFile }.getOrNull() ?: return null
        if (source.parentFile != folder || !source.isFile || !isImage(source)) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val target = File(newThumbnails, "${PageSnapshots.fileStem(tab.id)}-${source.lastModified()}-${bounds.outWidth}x${bounds.outHeight}.jpg")
        return Thumbnail(source, target)
    }

    private fun isImage(file: File): Boolean {
        val head = ByteArray(12)
        val read = runCatching { file.inputStream().use { it.read(head) } }.getOrDefault(-1)
        if (read < 4) return false
        val jpeg = head[0] == 0xFF.toByte() && head[1] == 0xD8.toByte() && head[2] == 0xFF.toByte()
        val png = head[0] == 0x89.toByte() && head[1] == 'P'.code.toByte() && head[2] == 'N'.code.toByte() && head[3] == 'G'.code.toByte()
        val webp = read >= 12 && String(head, 0, 4, Charsets.US_ASCII) == "RIFF" && String(head, 8, 4, Charsets.US_ASCII) == "WEBP"
        return jpeg || png || webp
    }

    private fun copyThumbnail(thumbnail: Thumbnail) {
        val target = thumbnail.target
        if (target.isFile && target.length() == thumbnail.source.length()) return
        val folder = target.parentFile ?: throw IOException("the thumbnail folder is missing")
        if (!folder.isDirectory && !folder.mkdirs()) throw IOException("couldn't make the thumbnail folder")
        val staged = File(folder, ".${target.name}.partial")
        Files.copy(thumbnail.source.toPath(), staged.toPath(), StandardCopyOption.REPLACE_EXISTING)
        Files.move(staged.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }

    private fun storePreferences(): Map<String, String> {
        val values = preferences(BROWSER) + preferences(READER)
        return STORE_KEYS.mapNotNull { key ->
            when (val value = values[key]) {
                is String -> key to value
                is Boolean, is Int, is Long, is Float -> key to value.toString()
                else -> null
            }
        }.toMap()
    }

    private fun applyBlocking() {
        val values = preferences(BLOCKING)
        if (values.isEmpty()) return
        val editor = app.getSharedPreferences(PhoneBlocking.PREFERENCES, Context.MODE_PRIVATE).edit()
        for ((key, value) in values) {
            @Suppress("UNCHECKED_CAST")
            when (value) {
                is String -> editor.putString(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is Float -> editor.putFloat(key, value)
                is Set<*> -> editor.putStringSet(key, value as Set<String>)
            }
        }
        if (!editor.commit()) throw IOException("couldn't save the blocking settings")
    }

    private fun applySites() {
        val browser = preferences(BROWSER)
        val target = app.getSharedPreferences(SITE_PREFERENCES, Context.MODE_PRIVATE)
        val editor = target.edit()
        var changed = false
        val trusted = LinkedHashSet<String>()
        (browser[KEY_NIGHT_SHADE] as? String)?.takeIf { it in NIGHT_SHADE_MODES }?.let {
            editor.putString(SITE_NIGHT_SHADE_DEFAULT, it)
            changed = true
        }
        (browser[KEY_APP_LINKS] as? String)?.takeIf { it == "app" || it == "ardia" }?.let {
            editor.putBoolean(SITE_APP_LINKS_DEFAULT, it == "app")
            changed = true
        }
        (browser[KEY_SITES] as? String)?.let { text ->
            val sites = try {
                JSONObject(text)
            } catch (error: Exception) {
                throw LegacyUnusable("corrupt")
            }
            val maps = SITE_MAPS.associateWith { key -> runCatching { JSONObject(target.getString(key, null) ?: "{}") }.getOrElse { JSONObject() } }
            for (host in sites.keys()) {
                val site = sites.optJSONObject(host) ?: continue
                val key = PhoneSitePreferences.siteKey(host)
                if (key.isEmpty()) continue
                if (site.has("pageZoom") && !site.isNull("pageZoom")) maps.getValue(SITE_ZOOM).put(key, site.getDouble("pageZoom"))
                site.optString("nightShade").takeIf { it in NIGHT_SHADE_MODES }?.let { maps.getValue(SITE_NIGHT_SHADE).put(key, it) }
                site.optString("appLinks").takeIf { it == "app" || it == "ardia" }?.let { maps.getValue(SITE_APP_LINKS).put(key, it == "app") }
                if (site.has("desktopSite") && !site.isNull("desktopSite")) maps.getValue(SITE_DESKTOP).put(key, site.getBoolean("desktopSite"))
                if (site.has("blockersOff") && !site.isNull("blockersOff") && site.getBoolean("blockersOff")) trusted += key
            }
            for ((key, map) in maps) if (map.length() > 0) editor.putString(key, map.toString())
            changed = true
        }
        if (changed && !editor.commit()) throw IOException("couldn't save the site settings")
        trustSites(trusted)
    }

    private fun trustSites(hosts: Set<String>) {
        if (hosts.isEmpty()) return
        val blocking = app.getSharedPreferences(PhoneBlocking.PREFERENCES, Context.MODE_PRIVATE)
        val existing = blocking.getString(KEY_EXEMPT_HOSTS, null)?.let { text ->
            val list = try {
                org.json.JSONArray(text)
            } catch (error: Exception) {
                throw LegacyUnusable("corrupt")
            }
            (0 until list.length()).map { list.getString(it) }.toSet()
        }.orEmpty()
        val merged = (existing + hosts).sorted()
        if (merged.size == existing.size) return
        if (!blocking.edit().putString(KEY_EXEMPT_HOSTS, org.json.JSONArray(merged).toString()).commit()) throw IOException("couldn't save the trusted sites")
    }

    private fun <T> withDatabase(block: (LegacyDatabase) -> T): T {
        val copy = snapshot()
        val db = try {
            openDatabase(copy)
        } catch (unusable: LegacyUnusable) {
            throw unusable
        } catch (error: Exception) {
            throw LegacyUnusable(reasonOf(error))
        }
        return db.use {
            try {
                validate(it)
                block(it)
            } catch (unusable: LegacyUnusable) {
                throw unusable
            } catch (error: Exception) {
                throw LegacyUnusable(reasonOf(error))
            }
        }
    }

    private fun validate(db: LegacyDatabase) {
        val check = db.query("PRAGMA quick_check").map { it.firstOrNull() as? String }
        if (check != listOf("ok")) throw LegacyUnusable("corrupt")
        val version = (db.query("PRAGMA user_version").firstOrNull()?.firstOrNull() as? Number)?.toInt()
        if (version != SCHEMA_VERSION) throw LegacyUnusable("schema")
        for ((table, columns) in REQUIRED_COLUMNS) {
            val present = db.query("PRAGMA table_info($table)").map { it[1] as String }.toSet()
            if (!present.containsAll(columns)) throw LegacyUnusable("schema")
        }
    }

    private fun snapshot(): File {
        val folder = snapshotFolder
        val stamp = "${sourceDatabase.length()}:${sourceDatabase.lastModified()}:${sourceWal.length()}:${sourceWal.lastModified()}"
        val stampFile = File(folder, "source.stamp")
        val copy = File(folder, "browser.db")
        io {
            if (copy.isFile && stampFile.isFile && stampFile.readText() == stamp) return copy
            folder.deleteRecursively()
            if (!folder.mkdirs()) throw IOException("couldn't make the snapshot folder")
            copyInto(sourceDatabase, copy)
            if (sourceWal.isFile) copyInto(sourceWal, File(folder, "browser.db-wal"))
        }
        reached("snapshotCopied")
        io { FileOutputStream(stampFile).use { it.write(stamp.toByteArray()) } }
        return copy
    }

    private inline fun <T> io(block: () -> T): T = try {
        block()
    } catch (unusable: LegacyUnusable) {
        throw unusable
    } catch (error: Exception) {
        throw LegacyUnusable("io")
    }

    private fun copyInto(source: File, target: File) {
        val staged = File(target.parentFile, ".${target.name}.partial")
        Files.copy(source.toPath(), staged.toPath(), StandardCopyOption.REPLACE_EXISTING)
        Files.move(staged.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }

    companion object {
        private val LOCK = Any()
        const val SCHEMA_VERSION = 1
        const val VISIT_PAGE_LIMIT = 5_000
        internal const val DATABASE_FILE = "browser.db"
        internal const val BROWSER = "ardia.browser"
        internal const val BLOCKING = "ardia.blocking"
        internal const val READER = "ardia.reader"
        private val PREFERENCE_FILES = listOf(BROWSER, BLOCKING, READER)
        private const val SITE_PREFERENCES = "ardia-site-preferences"
        private const val KEY_NIGHT_SHADE = "browsing.nightShade"
        private const val KEY_APP_LINKS = "browsing.appLinks"
        private const val KEY_SITES = "browsing.sites"
        private const val SITE_NIGHT_SHADE_DEFAULT = "nightShade.default"
        private const val SITE_APP_LINKS_DEFAULT = "appLinks.default"
        private const val SITE_ZOOM = "pageZoom.sites"
        private const val SITE_NIGHT_SHADE = "nightShade.sites"
        private const val SITE_APP_LINKS = "appLinks.sites"
        private const val SITE_DESKTOP = PhoneSitePreferences.KEY_DESKTOP_SITES
        private const val KEY_EXEMPT_HOSTS = "blocking.exemptHosts"
        private val SITE_MAPS = listOf(SITE_ZOOM, SITE_NIGHT_SHADE, SITE_APP_LINKS, SITE_DESKTOP)
        private val NIGHT_SHADE_MODES = setOf("disabled", "automatic", "always")
        val STORE_KEYS = listOf(
            "tabs.autoArchiveInterval",
            "browsing.nightShade",
            "browsing.swipeNavigation",
            "browsing.appLinks",
            "browsing.searchSuggestions",
            "browsing.searchEngine",
            "settings.collapseBottomBar",
            "settings.autoOpenKeyboard",
            "settings.finishedOnboarding",
            "tabs.archiveCardShown",
            "settings.color",
            "reader.sizeStep",
            "reader.serif",
            "reader.theme",
        )
        private const val TAB_COLUMNS =
            "id, url, title, created, lastActive, archivedAt, position, profileSyncId, faviconUrl, themeColorHex, snapshotFileName, origin, receivedKey, receivedFromDevice"
        private val REQUIRED_COLUMNS = mapOf(
            "tabs" to TAB_COLUMNS.split(", ").toSet(),
            "tab_state" to setOf("id", "data"),
            "visits" to setOf("id", "url", "title", "visitedAt", "profileSyncId", "transition"),
        )

        fun reasonOf(error: Throwable): String = when {
            error is LegacyUnusable -> error.reason
            error is SQLiteDatabaseLockedException -> "locked"
            error is SQLiteDatabaseCorruptException -> "corrupt"
            error is SQLiteCantOpenDatabaseException -> "io"
            error is IOException -> "io"
            error.message?.contains("locked", ignoreCase = true) == true || error.message?.contains("busy", ignoreCase = true) == true -> "locked"
            error.message?.contains("not a database", ignoreCase = true) == true || error.message?.contains("malformed", ignoreCase = true) == true ||
                error.message?.contains("corrupt", ignoreCase = true) == true -> "corrupt"
            else -> "io"
        }
    }
}
