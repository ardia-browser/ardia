package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.Color
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageSnapshotsTest {
    private val removed = ArrayList<String>()
    private val snapshots = PageSnapshots(RuntimeEnvironment.getApplication(), onRemoved = {
        removed += it.name
        1
    })

    private fun page(): Bitmap = Bitmap.createBitmap(64, 128, Bitmap.Config.ARGB_8888).apply {
        eraseColor(Color.WHITE)
        for (y in 0 until 128) for (x in 0 until 64) if ((x / 8 + y / 8) % 2 == 0) setPixel(x, y, Color.rgb(20 + x, 40 + y, 200))
    }

    private fun white(): Bitmap = Bitmap.createBitmap(64, 128, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }

    private fun files(): List<File> = File(RuntimeEnvironment.getApplication().filesDir, "PageSnapshots").listFiles()?.toList().orEmpty()

    @Test
    fun fiveCapturesOfOnePageReleaseEveryPinAndLeaveOneFile() = runBlocking {
        val live = java.util.concurrent.atomic.AtomicInteger()
        val landings = java.util.concurrent.CountDownLatch(5)
        val lifetime = Any()
        repeat(5) {
            snapshots.publish("tabpins", lifetime, page(), page(), isPrivate = false, quality = 80, hold = { _, _ ->
                live.incrementAndGet()
                PageSnapshots.Held { live.decrementAndGet() }
            }) { _, _ -> landings.countDown() }
            Thread.sleep(2)
        }
        assertTrue("every capture lands", landings.await(10, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals("a decoded picture is pinned only until its own file lands", 0, live.get())
        assertEquals("only the newest generation's file is kept", 1, files().count { it.name.startsWith("tabpins-") })
        assertEquals("each older generation was handed back so its decoded picture could be dropped", 4, removed.count { it.startsWith("tabpins-") })
    }

    @Test
    fun aBlankCaptureKeepsTheGoodThumbnailItWouldHaveReplaced() = runBlocking {
        val good = snapshots.write("tab-1", page(), isPrivate = false, quality = 80)
        assertNotNull(good)
        val blank = snapshots.write("tab-1", white(), isPrivate = false, quality = 80)
        assertEquals(good!!["path"], blank!!["path"])
        assertEquals(true, blank["kept"])
        assertEquals(listOf(File(good["path"] as String).name), files().map { it.name })
        Thread.sleep(2)
        val better = snapshots.write("tab-1", page(), isPrivate = false, quality = 80)
        assertTrue(better!!["path"] != good["path"])
        assertEquals(listOf(File(better["path"] as String).name), files().map { it.name })
    }

    @Test
    fun aBlankCaptureIsStillWrittenWhenThereIsNothingToKeep() = runBlocking {
        val first = snapshots.write("tab-2", white(), isPrivate = false, quality = 80)
        assertNotNull(first)
        assertTrue(File(first!!["path"] as String).isFile)
    }

    @Test
    fun aReplacedOrDeletedSnapshotIsReportedSoItsDecodedImageCanBeDropped() = runBlocking {
        val first = snapshots.write("tab-3", page(), isPrivate = false, quality = 80)!!
        assertTrue(removed.isEmpty())
        snapshots.write("tab-3", white(), isPrivate = false, quality = 80)
        assertTrue(removed.isEmpty())
        Thread.sleep(2)
        val second = snapshots.write("tab-3", page(), isPrivate = false, quality = 80)!!
        assertEquals(listOf(File(first["path"] as String).name), removed)
        assertEquals("the delete says what it found and what its decoded images gave back", PageSnapshots.Removed(files = 1, decodedDropped = 1), snapshots.delete("tab-3"))
        assertEquals(listOf(File(first["path"] as String).name, File(second["path"] as String).name), removed)
        assertEquals(PageSnapshots.Removed(files = 0, decodedDropped = 0), snapshots.delete("tab-3"))
        assertTrue("a close after the delete says the files were already gone", ImageMemory.closeSummary(0, 0).startsWith("no snapshot files left"))
    }

    @Test
    fun theImageCacheIsClearedWhenAndroidAsksForMemoryNotWhenTheAppMerelyLeavesTheScreen() {
        assertEquals(false, ImageMemory.clearsOn(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE))
        assertEquals(true, ImageMemory.clearsOn(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW))
        assertEquals(true, ImageMemory.clearsOn(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL))
        assertEquals(false, ImageMemory.clearsOn(android.content.ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
        assertEquals(true, ImageMemory.clearsOn(android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND))
        assertEquals(true, ImageMemory.clearsOn(android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE))
    }

    @Test
    fun aClosedPagesSnapshotsAreListedSoTheirDecodedImagesCanBeDroppedWhileTheFilesStay() = runBlocking {
        val mine = snapshots.write("tab-4", page(), isPrivate = false, quality = 80)!!
        val other = snapshots.write("tab-5", page(), isPrivate = false, quality = 80)!!
        assertEquals(listOf(mine["path"]), snapshots.files("tab-4").map { it.absolutePath })
        assertTrue(File(other["path"] as String).isFile)
        assertTrue(snapshots.files("tab-6").isEmpty())
        assertTrue(File(mine["path"] as String).isFile)
    }

    @Test
    fun theMemoryLineSaysHowMuchOfTheImageCacheIsShownAndHowMuchIsOnlyKept() {
        val mb = 1024 * 1024
        assertEquals(
            "46 MB in 26 images (shown 10 MB in 6, kept 36 MB in 20)",
            ImageMemory.describe(ImageMemory.Cache(bytes = 46 * mb, count = 26, inUseBytes = 10 * mb, keptBytes = 36 * mb, keptCount = 20)),
        )
    }
}
