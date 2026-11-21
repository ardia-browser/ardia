package com.ardia.phone

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import com.facebook.imagepipeline.cache.DefaultCacheKeyFactory
import com.facebook.imagepipeline.common.ResizeOptions
import com.facebook.imagepipeline.request.ImageRequest
import com.facebook.imagepipeline.request.ImageRequestBuilder
import com.facebook.react.modules.fresco.ReactNetworkImageRequest
import java.io.File
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DecodedSnapshotTest {
    @Before
    fun reactFlags() = com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()

    private fun reactNativeImageKey(uri: String, resize: ResizeOptions?) = DefaultCacheKeyFactory.getInstance().getBitmapCacheKey(
        ReactNetworkImageRequest.fromBuilderWithHeaders(
            ImageRequestBuilder.newBuilderWithSource(Uri.parse(uri))
                .setPostprocessor(null)
                .setResizeOptions(resize)
                .setAutoRotateEnabled(true)
                .setProgressiveRenderingEnabled(false)
                .setLowestPermittedRequestLevel(ImageRequest.RequestLevel.FULL_FETCH),
            null,
        ),
        null,
    )

    @Test
    fun thePinnedPictureIsUnderTheKeyReactNativesImageAsksForWithResizeMethodScale() {
        val uri = "file:///data/user/0/com.ardia.browser.android/files/PageSnapshots/tab-1-1731650000000-600x1300.jpg"
        assertEquals(reactNativeImageKey(uri, null), ImageMemory.decodedKey(uri))
        assertNotEquals("resizeMethod auto resizes file:// pictures to the view, which is another key", reactNativeImageKey(uri, ResizeOptions(400, 860)), ImageMemory.decodedKey(uri))
    }

    private fun page(): Bitmap = Bitmap.createBitmap(64, 128, Bitmap.Config.ARGB_8888).apply {
        for (y in 0 until 128) for (x in 0 until 64) setPixel(x, y, if ((x / 8 + y / 8) % 2 == 0) Color.rgb(20 + x, 40 + y, 200) else Color.WHITE)
    }

    private val writes = ArrayList<() -> Unit>()
    private val removed = ArrayList<String>()
    private val released = ArrayList<String>()
    private val landed = ArrayList<Pair<String, Long>>()
    private val snapshots = PageSnapshots(RuntimeEnvironment.getApplication(), onRemoved = { removed += it.name; 0 }, clock = { 1_000L }, launchWrite = { writes += it })
    private val lifetime = Any()

    private fun hold(pins: Boolean): (String, Bitmap) -> PageSnapshots.Held? = { uri, _ -> if (pins) PageSnapshots.Held { released += File(Uri.parse(uri).path!!).name } else null }

    private suspend fun publish(pageId: String = "tab-7", pins: Boolean = true, owner: Any = lifetime) =
        snapshots.publish(pageId, owner, page(), page(), isPrivate = false, quality = 80, hold(pins)) { uri, generation -> landed += File(Uri.parse(uri).path!!).name to generation }!!

    @Test
    fun twoCapturesInOneMillisecondGetTheirOwnFilesAndLandInOrder() = runBlocking {
        val first = publish()
        val second = publish()
        assertNotEquals(first["path"], second["path"])
        assertTrue((second["generation"] as Double) > (first["generation"] as Double))
        assertEquals(false, first["durable"])
        writes.removeAt(0)()
        writes.removeAt(0)()
        assertEquals(listOf(File(first["path"] as String).name, File(second["path"] as String).name), landed.map { it.first })
        assertEquals("the newer one removed the older file", listOf(File(first["path"] as String).name), removed)
        assertEquals("each pin is released once its file has landed", landed.map { it.first }, released)
    }

    @Test
    fun anOlderWriteThatLandsLateRemovesItselfAndAnnouncesNothing() = runBlocking {
        val older = publish()
        val newer = publish()
        writes.removeAt(1)()
        writes.removeAt(0)()
        assertEquals(listOf(File(newer["path"] as String).name), landed.map { it.first })
        assertFalse(File(older["path"] as String).exists())
        assertTrue(File(newer["path"] as String).exists())
    }

    @Test
    fun whenTheCacheRefusesThePictureTheCallWaitsForItsFile() = runBlocking {
        val result = async { publish(pins = false) }
        while (writes.isEmpty()) yield()
        assertFalse("nothing is resolved before the write", result.isCompleted)
        writes.removeAt(0)()
        val done = result.await()
        assertEquals(true, done["durable"])
        assertTrue(File(done["path"] as String).isFile)
    }

    @Test
    fun aPageClosedBeforeItsPictureLandsDropsThePinTheFileAndTheEvent() = runBlocking {
        val result = publish()
        snapshots.close("tab-7", lifetime)
        assertEquals(listOf(File(result["path"] as String).name), released)
        writes.removeAt(0)()
        assertTrue(landed.isEmpty())
        assertFalse(File(result["path"] as String).exists())
    }

    @Test
    fun aReusedPageIdDoesNotKeepTheClosedPagesLateWrite() = runBlocking {
        val closedPage = publish(owner = lifetime)
        snapshots.close("tab-7", lifetime)
        val reopened = Any()
        val fresh = publish(owner = reopened)
        writes.removeAt(0)()
        writes.removeAt(0)()
        assertFalse(File(closedPage["path"] as String).exists())
        assertEquals(listOf(File(fresh["path"] as String).name), landed.map { it.first })
    }
}
