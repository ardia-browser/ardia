package com.ardia.phone

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.ardia.sync.SyncPhase
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

object ShareWait {
    enum class Next { Send, Wait, GiveUp }

    fun next(isEnabled: Boolean, updated: Boolean, deviceKnown: Boolean, connectedOnDisk: Boolean): Next = when {
        isEnabled && deviceKnown -> Next.Send
        isEnabled && updated -> Next.GiveUp
        isEnabled -> Next.Wait
        connectedOnDisk -> Next.Wait
        else -> Next.GiveUp
    }
}

object ShareSends {
    const val WAIT_MILLIS = 20_000L
    const val RESUME_AFTER_MILLIS = 60_000L
    private const val POLL_MILLIS = 250L
    private const val PREFERENCES = "ardia-share-sends"
    private const val KEY = "pending"
    private const val WORK = "ardia-share-resume"

    data class Pending(val key: String, val url: String, val title: String, val deviceId: String, val at: Long, val window: Long?)

    private fun preferences(context: Context) = (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun pending(context: Context): List<Pending> = synchronized(this) {
        val array = runCatching { JSONArray(preferences(context).getString(KEY, "[]")) }.getOrDefault(JSONArray())
        (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            Pending(
                key = item.optString("key").takeIf { it.isNotEmpty() } ?: return@mapNotNull null,
                url = item.optString("url").takeIf { it.isNotEmpty() } ?: return@mapNotNull null,
                title = item.optString("title"),
                deviceId = item.optString("deviceId").takeIf { it.isNotEmpty() } ?: return@mapNotNull null,
                at = item.optLong("at"),
                window = if (item.has("window")) item.optLong("window") else null,
            )
        }
    }

    private fun save(context: Context, items: List<Pending>) {
        val array = JSONArray()
        items.forEach { item ->
            array.put(JSONObject().apply {
                put("key", item.key)
                put("url", item.url)
                put("title", item.title)
                put("deviceId", item.deviceId)
                put("at", item.at)
                item.window?.let { put("window", it) }
            })
        }
        preferences(context).edit().putString(KEY, array.toString()).commit()
    }

    fun record(context: Context, item: Pending) = synchronized(this) {
        if (pending(context).any { it.key == item.key }) return@synchronized
        save(context, pending(context) + item)
        runCatching {
            WorkManager.getInstance(context.applicationContext ?: context).enqueueUniqueWork(
                WORK,
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<ShareResumeWorker>().setInitialDelay(RESUME_AFTER_MILLIS, TimeUnit.MILLISECONDS).build(),
            )
        }
        Unit
    }

    fun remove(context: Context, key: String) = synchronized(this) {
        save(context, pending(context).filter { it.key != key })
    }

    suspend fun send(context: Context, item: Pending): Boolean {
        val app = context.applicationContext ?: context
        val sync = runCatching { PhoneSync.controller(app, demo = false) }.getOrNull() ?: return false
        val connected = PhoneSync.connectedOnDisk(app)
        val target = withTimeoutOrNull(WAIT_MILLIS) {
            while (true) {
                val state = sync.state.value
                val device = sync.snapshot.value.devices.firstOrNull { it.id == item.deviceId }
                when (ShareWait.next(state.isEnabled, state.phase == SyncPhase.Updated, device != null, connected)) {
                    ShareWait.Next.Send -> return@withTimeoutOrNull device
                    ShareWait.Next.GiveUp -> return@withTimeoutOrNull null
                    ShareWait.Next.Wait -> delay(POLL_MILLIS)
                }
            }
            @Suppress("UNREACHABLE_CODE")
            null
        } ?: return false
        val sent = runCatching { sync.send(item.url, item.title, target, key = item.key) }.getOrDefault(false)
        if (sent) {
            remove(app, item.key)
            PendingCounts.add(app, PendingCounts.TABS_SENT, item.window)
        }
        return sent
    }
}

class ShareResumeWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val now = System.currentTimeMillis()
        ShareSends.pending(applicationContext).filter { now - it.at >= ShareSends.WAIT_MILLIS }.forEach { item ->
            if (!ShareSends.send(applicationContext, item) && now - item.at > MAXIMUM_AGE_MILLIS) ShareSends.remove(applicationContext, item.key)
        }
        return if (ShareSends.pending(applicationContext).isEmpty()) Result.success() else Result.retry()
    }

    private companion object {
        const val MAXIMUM_AGE_MILLIS = 24L * 60 * 60 * 1000
    }
}
