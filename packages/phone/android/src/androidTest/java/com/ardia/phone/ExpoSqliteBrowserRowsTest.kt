package com.ardia.phone

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExpoSqliteBrowserRowsTest {
    private lateinit var folder: File
    private lateinit var file: File
    private lateinit var writer: ExpoSqliteConnection

    @Before
    fun openTheAppsConnection() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        SoLoader.init(context, OpenSourceMergedSoMapping)
        folder = File(context.cacheDir, "expo-rows-${System.nanoTime()}").apply { mkdirs() }
        file = File(folder, "browser.db")
        writer = ExpoSqliteConnection(file.path)
        writer.query("PRAGMA journal_mode = WAL", emptyList())
        writer.query("CREATE TABLE tabs (url TEXT NOT NULL, lastActive INTEGER NOT NULL, archivedAt INTEGER, position REAL NOT NULL)", emptyList())
        writer.query("INSERT INTO tabs VALUES ('https://a.example/', 1700000000000, NULL, 1.5)", emptyList())
    }

    @After
    fun closeIt() {
        writer.close()
        folder.deleteRecursively()
    }

    @Test
    fun readsEachColumnTypeWithBoundText() {
        val rows = ExpoSqliteBrowserRows(file).open { query ->
            query.query("SELECT url, lastActive, archivedAt, position FROM tabs WHERE url = ?", listOf("https://a.example/"))
        }
        assertEquals(listOf(listOf<Any?>("https://a.example/", 1700000000000L, null, 1.5)), rows)
    }

    @Test
    fun aMissingFileIsNoRowsAndIsNotCreated() {
        val missing = File(folder, "missing.db")
        assertNull(ExpoSqliteBrowserRows(missing).open { it.query("SELECT 1", emptyList()) })
        assertTrue(!missing.exists())
    }

    @Test
    fun theReaderCannotWrite() {
        val failure = runCatching {
            ExpoSqliteBrowserRows(file).open { it.query("DELETE FROM tabs", emptyList()) }
        }.exceptionOrNull()
        assertTrue("a write through the reader should fail, got $failure", failure is java.io.IOException)
        assertEquals(1L, writer.query("SELECT count(*) FROM tabs", emptyList()).first().first())
    }

    @Test
    fun readingWhileTheAppWritesNeverDisturbsItsConnection() {
        val stop = AtomicBoolean(false)
        val writes = AtomicInteger()
        val writeFailure = AtomicReference<Throwable?>()
        val writing = thread {
            try {
                while (!stop.get()) {
                    writer.query("INSERT INTO tabs VALUES ('https://b.example/', 1700000000001, NULL, 2)", emptyList())
                    writer.query("SELECT count(*) FROM tabs", emptyList())
                    writes.incrementAndGet()
                }
            } catch (failure: Throwable) {
                writeFailure.set(failure)
            }
        }
        repeat(300) {
            ExpoSqliteBrowserRows(file).open { query ->
                query.query("PRAGMA busy_timeout = 5000", emptyList())
                query.query("SELECT count(*) FROM tabs WHERE archivedAt IS NULL", emptyList())
            }
        }
        stop.set(true)
        writing.join()
        assertNull(writeFailure.get())
        assertTrue("the writer should have run alongside the reads", writes.get() > 0)
        assertEquals(listOf(listOf<Any?>("ok")), writer.query("PRAGMA integrity_check", emptyList()))
    }
}
