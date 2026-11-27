package com.ardia.phone

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

data class ExitSeen(val reason: Int, val importance: Int, val at: Long, val mainProcess: Boolean)

object PhoneExits {
    private const val PREFERENCES = "ardia-phone-exits"
    private const val LAST_SEEN = "lastSeen"
    const val MOST = 10
    private const val OLDEST_MS = 7L * 24 * 60 * 60 * 1000

    fun describe(seen: ExitSeen): Map<String, Any>? {
        val (kind, reason) = when (seen.reason) {
            ApplicationExitInfo.REASON_CRASH -> "crash" to "java_crash"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash" to "native_crash"
            ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "crash" to "init_failure"
            ApplicationExitInfo.REASON_ANR -> "hang" to "anr"
            ApplicationExitInfo.REASON_LOW_MEMORY -> "memory" to "low_memory"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "resource" to "excessive_resource"
            ApplicationExitInfo.REASON_SIGNALED -> "killed" to "signaled"
            else -> return null
        }
        val foreground = if (seen.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND || seen.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE) "yes" else "no"
        return mapOf("kind" to kind, "reason" to reason, "foreground" to foreground, "at" to seen.at.toDouble())
    }

    fun pick(exits: List<ExitSeen>, lastSeen: Long, sharingSince: Long, now: Long): List<Map<String, Any>> =
        exits.asSequence()
            .filter { it.mainProcess && it.at > lastSeen && it.at >= sharingSince && now - it.at <= OLDEST_MS }
            .sortedBy { it.at }
            .mapNotNull(::describe)
            .toList()
            .takeLast(MOST)

    fun take(context: Context, now: Long = System.currentTimeMillis()): List<Map<String, Any>> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        val app = context.applicationContext ?: context
        val since = UsageConsent.sharingSince(app) ?: return emptyList()
        val manager = app.getSystemService(ActivityManager::class.java) ?: return emptyList()
        val infos: List<ApplicationExitInfo> = runCatching { manager.getHistoricalProcessExitReasons(app.packageName, 0, 0) }.getOrDefault(emptyList())
        val preferences = app.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val (exits, lastSeen) = synchronized(this) {
            val lastSeen = preferences.getLong(LAST_SEEN, 0L)
            val newest = infos.maxOfOrNull { it.timestamp } ?: lastSeen
            if (newest > lastSeen) preferences.edit().putLong(LAST_SEEN, newest).commit()
            infos.map { ExitSeen(it.reason, it.importance, it.timestamp, it.processName == app.packageName) } to lastSeen
        }
        return pick(exits, lastSeen, since, now)
    }
}
