package com.ardia.phone

import android.content.Context
import android.graphics.Bitmap
import com.ardia.browser.PageCapture
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class PageSnapshots(
    context: Context,
    private val onRemoved: (File) -> Int = { 0 },
    private val clock: () -> Long = System::currentTimeMillis,
    private val launchWrite: (() -> Unit) -> Unit = { work -> writes.execute(work) },
) {
    private val app = context.applicationContext
    private val saved = File(app.filesDir, SAVED_FOLDER)
    private val private = File(app.cacheDir, PRIVATE_FOLDER)

    suspend fun write(pageId: String, bitmap: Bitmap, isPrivate: Boolean, quality: Int): Map<String, Any?>? = withContext(Dispatchers.IO) {
        val folder = if (isPrivate) private else saved
        if (!folder.isDirectory && !folder.mkdirs()) return@withContext null
        val stem = fileStem(pageId)
        val previous = older(folder, stem, keep = null).maxByOrNull { it.lastModified() }
        if (previous != null && looksBlank(bitmap)) {
            bitmap.recycle()
            return@withContext describe(previous) + ("kept" to true)
        }
        val target = File(folder, "$stem-${System.currentTimeMillis()}-${bitmap.width}x${bitmap.height}.jpg")
        val staging = File(folder, "$stem.partial")
        val written = runCatching {
            staging.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), it) }
        }.getOrDefault(false)
        val width = bitmap.width
        val height = bitmap.height
        bitmap.recycle()
        if (!written || !staging.renameTo(target)) {
            staging.delete()
            return@withContext null
        }
        older(folder, stem, keep = target).forEach { remove(it) }
        mapOf("path" to target.absolutePath, "uri" to "file://${target.absolutePath}", "width" to width, "height" to height, "bytes" to target.length().toDouble())
    }

    fun interface Held {
        fun release()
    }

    private class Pending(val generation: Long, val lifetime: Any, val target: File, val uri: String, val held: Held?, val done: kotlinx.coroutines.CompletableDeferred<Boolean>)

    private val pending = HashMap<String, MutableList<Pending>>()
    private val landedGeneration = HashMap<String, Long>()
    private val lastGeneration = HashMap<String, Long>()
    private val closed = java.util.Collections.newSetFromMap(java.util.WeakHashMap<Any, Boolean>())
    private var sweptPartials = false

    private fun generationOf(file: File, stem: String): Long? = file.name.removePrefix("$stem-").substringBefore('-').toLongOrNull()

    private fun nextGeneration(pageId: String, folder: File, stem: String): Long = synchronized(this) {
        val onDisk = older(folder, stem, keep = null).mapNotNull { generationOf(it, stem) }.maxOrNull() ?: 0L
        val next = maxOf(clock(), onDisk + 1, (lastGeneration[pageId] ?: 0L) + 1)
        lastGeneration[pageId] = next
        next
    }

    private fun sweepPartials() {
        if (sweptPartials) return
        sweptPartials = true
        listOf(saved, private).forEach { folder -> folder.listFiles { file -> file.name.endsWith(".partial") }?.forEach { it.delete() } }
    }

    suspend fun publish(
        pageId: String,
        lifetime: Any,
        bitmap: Bitmap,
        decoded: Bitmap?,
        isPrivate: Boolean,
        quality: Int,
        hold: (String, Bitmap) -> Held?,
        landed: (String, Long) -> Unit,
    ): Map<String, Any?>? {
        val folder = if (isPrivate) private else saved
        val stem = fileStem(pageId)
        val prepared = withContext(Dispatchers.IO) {
            sweepPartials()
            if (!folder.isDirectory && !folder.mkdirs()) return@withContext null
            val previous = older(folder, stem, keep = null).maxByOrNull { generationOf(it, stem) ?: 0L }
            if (previous != null && looksBlank(bitmap)) return@withContext previous to true
            null to false
        }
        if (prepared == null) {
            bitmap.recycle()
            decoded?.recycle()
            return null
        }
        val (previous, blank) = prepared
        if (blank && previous != null) {
            bitmap.recycle()
            decoded?.recycle()
            return describe(previous) + ("kept" to true) + ("durable" to true)
        }
        val generation = nextGeneration(pageId, folder, stem)
        val width = bitmap.width
        val height = bitmap.height
        val target = File(folder, "$stem-$generation-${width}x$height.jpg")
        val uri = "file://${target.absolutePath}"
        val held = decoded?.let { hold(uri, it) }
        if (held == null) decoded?.recycle()
        val entry = Pending(generation, lifetime, target, uri, held, kotlinx.coroutines.CompletableDeferred())
        synchronized(this) { pending.getOrPut(pageId) { ArrayList() } += entry }
        launchWrite { finish(pageId, stem, folder, entry, writeFile(target, bitmap, quality), landed) }
        val result = mapOf("path" to target.absolutePath, "uri" to uri, "width" to width, "height" to height, "bytes" to 0.0, "generation" to generation.toDouble())
        if (held != null) return result + ("durable" to false)
        if (!entry.done.await()) return previous?.let { describe(it) + ("kept" to true) + ("durable" to true) }
        return result + ("bytes" to target.length().toDouble()) + ("durable" to true)
    }

    private fun writeFile(target: File, bitmap: Bitmap, quality: Int): Boolean {
        val staging = File(target.parentFile, "${target.name}.partial")
        val done = runCatching {
            staging.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), it) }
        }.getOrDefault(false)
        bitmap.recycle()
        if (!done || !staging.renameTo(target)) {
            staging.delete()
            return false
        }
        return true
    }

    private fun finish(pageId: String, stem: String, folder: File, entry: Pending, written: Boolean, landed: (String, Long) -> Unit) {
        val announce: Boolean
        synchronized(this) {
            pending[pageId]?.remove(entry)
            entry.held?.release()
            val current = written && entry.lifetime !in closed && entry.generation > (landedGeneration[pageId] ?: Long.MIN_VALUE)
            if (current) landedGeneration[pageId] = entry.generation
            announce = current
        }
        if (!announce) {
            if (written) remove(entry.target) else runCatching { onRemoved(entry.target) }
            entry.done.complete(false)
            return
        }
        older(folder, stem, keep = entry.target).filter { (generationOf(it, stem) ?: Long.MAX_VALUE) < entry.generation }.forEach { remove(it) }
        entry.done.complete(true)
        landed(entry.uri, entry.generation)
    }

    fun close(pageId: String, lifetime: Any) {
        val dropped = synchronized(this) {
            closed += lifetime
            val mine = pending[pageId]?.filter { it.lifetime === lifetime }.orEmpty()
            mine.forEach { it.held?.release() }
            mine
        }
        dropped.forEach { runCatching { onRemoved(it.target) } }
    }

    private fun looksBlank(bitmap: Bitmap): Boolean = PageCapture.isBlank(bitmap, blackIsBlank = true) || PageCapture.isNearlyUniform(bitmap)

    private fun describe(file: File): Map<String, Any?> {
        val size = sizeIn.find(file.name)
        return mapOf(
            "path" to file.absolutePath,
            "uri" to "file://${file.absolutePath}",
            "width" to (size?.groupValues?.get(1)?.toIntOrNull() ?: 0),
            "height" to (size?.groupValues?.get(2)?.toIntOrNull() ?: 0),
            "bytes" to file.length().toDouble(),
        )
    }

    data class Removed(val files: Int, val decodedDropped: Int)

    fun delete(pageId: String): Removed {
        val stem = fileStem(pageId)
        val found = listOf(saved, private).flatMap { folder -> older(folder, stem, keep = null).sortedBy { it.lastModified() } }
        return Removed(found.size, found.sumOf(::remove))
    }

    fun files(pageId: String): List<File> {
        val stem = fileStem(pageId)
        return listOf(saved, private).flatMap { folder -> older(folder, stem, keep = null) }
    }

    fun endPrivateBrowsing() {
        private.listFiles()?.forEach { remove(it) }
    }

    private fun remove(file: File): Int {
        file.delete()
        return runCatching { onRemoved(file) }.getOrDefault(0)
    }

    private fun older(folder: File, stem: String, keep: File?): List<File> =
        folder.listFiles { file -> file.name.startsWith("$stem-") && file.name.endsWith(".jpg") && file != keep }?.toList().orEmpty()

    companion object {
        private val writes: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "ardia-snapshot-writes") }
        private const val SAVED_FOLDER = "PageSnapshots"
        private const val PRIVATE_FOLDER = "PrivatePageSnapshots"
        private val safeId = Regex("[A-Za-z0-9_]{1,64}")
        private val sizeIn = Regex("-(\\d+)x(\\d+)\\.jpg$")

        fun fileStem(pageId: String): String {
            if (safeId.matches(pageId)) return pageId
            val digest = MessageDigest.getInstance("SHA-256").digest(pageId.toByteArray(Charsets.UTF_8))
            return digest.take(16).joinToString("") { "%02x".format(it) }
        }
    }
}
