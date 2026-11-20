package com.ardia.phone

import java.io.IOException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

internal class HttpUnreachable : IOException()

internal suspend fun <T> OkHttpClient.exchange(request: Request, read: suspend (Response) -> T): T = coroutineScope {
    val call = newCall(request)
    val guard = launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) {
        try {
            awaitCancellation()
        } finally {
            call.cancel()
        }
    }
    try {
        withContext(Dispatchers.IO) {
            val response = try {
                call.execute()
            } catch (error: IOException) {
                ensureActive()
                throw HttpUnreachable()
            }
            response.use { read(it) }
        }
    } finally {
        guard.cancel()
    }
}

internal fun Response.boundedText(limit: Long): String? = runCatching {
    val source = body?.source() ?: return@runCatching ""
    source.request(limit)
    source.buffer.readUtf8(minOf(source.buffer.size, limit))
}.getOrNull()
