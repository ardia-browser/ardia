package com.ardia.phone

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.os.Debug
import android.util.Log
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineFactory
import java.io.File

object ImageMemory {
    private var watching = false

    fun clearsOn(level: Int): Boolean =
        level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL || level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND

    fun forget(file: File): Int {
        if (!Fresco.hasBeenInitialized()) return 0
        val dropped = forgetAll(listOf(file))
        runCatching { Fresco.getImagePipeline().evictFromCache(Uri.fromFile(file)) }
        runCatching { Fresco.getImagePipeline().evictFromMemoryCache(Uri.parse("file://${file.absolutePath}")) }
        return dropped
    }

    fun decodedKey(uri: String): com.facebook.cache.common.CacheKey =
        com.facebook.imagepipeline.cache.DefaultCacheKeyFactory.getInstance().getBitmapCacheKey(
            com.facebook.imagepipeline.request.ImageRequestBuilder.newBuilderWithSource(Uri.parse(uri)).setAutoRotateEnabled(true).build(),
            null,
        )

    fun pinDecoded(uri: String, bitmap: Bitmap): PageSnapshots.Held? = runCatching {
        if (!Fresco.hasBeenInitialized()) return null
        val image: com.facebook.imagepipeline.image.CloseableImage = com.facebook.imagepipeline.image.CloseableStaticBitmap.of(
            bitmap,
            com.facebook.imagepipeline.bitmaps.SimpleBitmapReleaser.getInstance(),
            com.facebook.imagepipeline.image.ImmutableQualityInfo.FULL_QUALITY,
            0,
        )
        val reference = com.facebook.common.references.CloseableReference.of(image)
        val pinned = try {
            Fresco.getImagePipeline().bitmapMemoryCache.cache(decodedKey(uri), reference)
        } finally {
            reference.close()
        }
        pinned?.let { PageSnapshots.Held { it.close() } }
    }.getOrNull()

    data class Cache(val bytes: Int, val count: Int, val inUseBytes: Int, val keptBytes: Int, val keptCount: Int)

    fun describe(cache: Cache): String =
        "${cache.bytes / MB} MB in ${cache.count} images (shown ${cache.inUseBytes / MB} MB in ${cache.count - cache.keptCount}, kept ${cache.keptBytes / MB} MB in ${cache.keptCount})"

    fun cache(): Cache? = runCatching {
        if (!Fresco.hasBeenInitialized()) return null
        val memory = ImagePipelineFactory.getInstance().bitmapCountingMemoryCache
        Cache(memory.sizeInBytes, memory.count, memory.inUseSizeInBytes, memory.evictionQueueSizeInBytes, memory.evictionQueueCount)
    }.getOrNull()

    fun forgetAll(files: List<File>): Int {
        if (files.isEmpty() || !Fresco.hasBeenInitialized()) return 0
        val uris = files.flatMap { listOf(Uri.fromFile(it), Uri.parse("file://${it.absolutePath}")) }.distinct()
        return runCatching {
            ImagePipelineFactory.getInstance().bitmapCountingMemoryCache.removeAll { key -> uris.any(key::containsUri) }
        }.getOrDefault(0)
    }

    fun closeSummary(files: Int, dropped: Int): String = when {
        files == 0 -> "no snapshot files left (never taken, or the snapshot delete got there first and logged its own drops)"
        dropped == 0 -> "$files snapshot file(s), none decoded in memory"
        else -> "$files snapshot file(s), dropped $dropped decoded"
    }

    fun clear() {
        if (Fresco.hasBeenInitialized()) runCatching { Fresco.getImagePipeline().clearMemoryCaches() }
    }

    fun watch(context: Context) {
        if (watching) return
        watching = true
        context.applicationContext.registerComponentCallbacks(object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                val cleared = clearsOn(level)
                if (cleared) clear()
                val look = LookMemory.release(level)
                if (PhoneLab.isOn) {
                    Log.i("PAGELAB", "PAGELAB memory trim received: level $level (${levelName(level)}); ${if (cleared) "image cache cleared" else "image cache kept"}; $look")
                }
            }

            override fun onConfigurationChanged(newConfig: Configuration) = Unit

            @Deprecated("Deprecated in Android")
            override fun onLowMemory() = clear()
        })
    }

    fun levelName(level: Int): String = when (level) {
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE -> "RUNNING_MODERATE"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "RUNNING_LOW"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "RUNNING_CRITICAL"
        ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> "UI_HIDDEN"
        ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> "BACKGROUND"
        ComponentCallbacks2.TRIM_MEMORY_MODERATE -> "MODERATE"
        ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> "COMPLETE"
        else -> "unknown"
    }

    fun line(context: Context, livePages: Int): String {
        val runtime = Runtime.getRuntime()
        val javaUsed = (runtime.totalMemory() - runtime.freeMemory()) / MB
        val native = Debug.getNativeHeapAllocatedSize() / MB
        val info = Debug.MemoryInfo().also(Debug::getMemoryInfo)
        val graphics = (info.getMemoryStat("summary.graphics")?.toLongOrNull() ?: 0L) / 1024
        val total = info.totalPss / 1024
        val images = cache()?.let(::describe) ?: "unknown"
        val lowMemory = ActivityManager.MemoryInfo().also { (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it) }.lowMemory
        return "PAGELAB memory: total PSS $total MB, Java heap $javaUsed MB, native heap $native MB, graphics $graphics MB, image cache $images, live pages $livePages, low memory $lowMemory; ${LookMemory.line(context)}"
    }

    fun log(context: Context, livePages: Int) {
        Log.i("PAGELAB", line(context, livePages))
    }

    private const val MB = 1024 * 1024
}
