package com.ardia.phone

import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.MediaStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
internal class DownloadedFilesTest {
    internal class FakeMedia : ContentProvider() {
        val rows = mutableListOf<DownloadedFiles.Row>()
        val deleted = mutableListOf<Long>()

        override fun onCreate() = true

        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
            val cursor = MatrixCursor(projection ?: emptyArray())
            val one = runCatching { ContentUris.parseId(uri) }.getOrNull()
            for (row in rows.filter { one == null || it.id == one }) {
                cursor.addRow(
                    (projection ?: emptyArray()).map { column ->
                        when (column) {
                            MediaStore.MediaColumns._ID -> row.id
                            MediaStore.MediaColumns.DISPLAY_NAME -> row.name
                            MediaStore.MediaColumns.SIZE -> row.size
                            MediaStore.MediaColumns.DATE_MODIFIED -> row.modifiedSeconds
                            MediaStore.MediaColumns.MIME_TYPE -> row.mime
                            MediaStore.MediaColumns.RELATIVE_PATH -> row.relativePath
                            MediaStore.MediaColumns.IS_PENDING -> if (row.pending) 1 else 0
                            MediaStore.MediaColumns.OWNER_PACKAGE_NAME -> row.owner
                            else -> null
                        }
                    }.toTypedArray(),
                )
            }
            return cursor
        }

        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
            val id = ContentUris.parseId(uri)
            val removed = rows.removeAll { it.id == id }
            if (removed) deleted += id
            return if (removed) 1 else 0
        }

        override fun getType(uri: Uri): String? = null

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null

        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    }

    private val context = RuntimeEnvironment.getApplication()
    private lateinit var media: FakeMedia
    private val own get() = context.packageName

    @Before
    fun setUp() {
        media = Robolectric.setupContentProvider(FakeMedia::class.java, MediaStore.AUTHORITY)
        media.rows += listOf(
            DownloadedFiles.Row(1, "report.pdf", 2_048, 1_700_000_000, "application/pdf", DownloadedFiles.folder, false, own),
            DownloadedFiles.Row(2, "photo.jpg", 9_000, 1_700_000_500, "image/jpeg", DownloadedFiles.folder, false, own),
            DownloadedFiles.Row(3, "half.zip", 10, 1_700_000_900, "application/zip", DownloadedFiles.folder, true, own),
            DownloadedFiles.Row(4, "theirs.mp3", 10, 1_700_000_800, "audio/mpeg", DownloadedFiles.folder, false, "com.other.app"),
            DownloadedFiles.Row(5, "deeper.txt", 10, 1_700_000_700, "text/plain", "Download/Other/", false, own),
        )
    }

    private fun uri(id: Long) = ContentUris.withAppendedId(DownloadedFiles.collection(), id).toString()

    @Test
    fun theListIsThisAppsFinishedFilesInDownloadsNewestFirst() {
        val files = DownloadedFiles.list(context)
        assertEquals(listOf("photo.jpg", "report.pdf"), files.map { it["name"] })
        assertEquals(mapOf("name" to "photo.jpg", "uri" to uri(2), "size" to 9_000.0, "modified" to 1_700_000_500_000.0, "kind" to "image"), files.first())
    }

    @Test
    fun deletingTakesOnlyAListedFile() {
        assertTrue(DownloadedFiles.delete(context, uri(1)))
        assertEquals(listOf(1L), media.deleted)
        assertFalse("a file still being written", DownloadedFiles.delete(context, uri(3)))
        assertFalse("another app's file", DownloadedFiles.delete(context, uri(4)))
        assertFalse("a file outside the Downloads folder itself", DownloadedFiles.delete(context, uri(5)))
        assertFalse("a file that isn't there", DownloadedFiles.delete(context, uri(99)))
        assertEquals(listOf(1L), media.deleted)
    }

    @Test
    fun addressesOutsideTheDownloadsCollectionAreRefused() {
        for (outside in listOf(
            "file:///storage/emulated/0/Download/report.pdf",
            "file:///data/data/com.ardia.browser.android/shared_prefs/site.xml",
            "content://com.other.provider/downloads/1",
            ContentUris.withAppendedId(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), 1).toString(),
            DownloadedFiles.collection().toString(),
            "${DownloadedFiles.collection()}/../images/1",
            "not a uri",
        )) {
            assertNull(outside, DownloadedFiles.file(context, outside))
            assertFalse(outside, DownloadedFiles.delete(context, outside))
            assertFalse(outside, DownloadedFiles.preview(context, outside))
        }
        assertTrue(media.deleted.isEmpty())
    }

    @Test
    fun deleteAllRemovesEveryListedFileAndNothingElse() {
        assertEquals(2, DownloadedFiles.deleteAll(context))
        assertEquals(setOf(1L, 2L), media.deleted.toSet())
        assertEquals(listOf(3L, 4L, 5L), media.rows.map { it.id })
    }

    @Test
    fun kindsFollowTheTypeAndTheNameWhenTheTypeIsMissing() {
        assertEquals("image", DownloadedFiles.kind("image/png", "a.bin"))
        assertEquals("video", DownloadedFiles.kind(null, "clip.MP4"))
        assertEquals("audio", DownloadedFiles.kind("audio/mpeg", "a"))
        assertEquals("pdf", DownloadedFiles.kind("application/octet-stream", "paper.pdf"))
        assertEquals("archive", DownloadedFiles.kind("application/x-7z-compressed", "a"))
        assertEquals("archive", DownloadedFiles.kind(null, "backup.tar.gz"))
        assertEquals("document", DownloadedFiles.kind("text/plain", "notes.txt"))
    }
}
