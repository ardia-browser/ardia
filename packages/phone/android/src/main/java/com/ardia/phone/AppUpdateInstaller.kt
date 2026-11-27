package com.ardia.phone

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

internal object AppUpdateInstaller {
    const val KIND_UPDATE = "update"
    const val KIND_FILE = "file"
    private val SHA256 = Regex("^[0-9a-f]{64}$")

    @Volatile var statusSink: ((Map<String, Any?>) -> Unit)? = null
    @Volatile private var unreported: Map<String, Any?>? = null

    private const val PREFS = "ardia_app_update_sessions"
    private val TAG = Regex("^[0-9]{1,19}$")

    private fun sessions(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun result(result: String, session: Int? = null): Map<String, Any?> = mapOf("result" to result, "session" to session?.toString())

    fun installFile(context: Context, file: File, sha256: String, downloadId: String): Map<String, Any?> {
        if (!SHA256.matches(sha256) || !file.isFile || !TAG.matches(downloadId)) return result("gone")
        return runCatching { file.inputStream().use { install(context, it, file.length(), sha256, KIND_UPDATE, downloadId) } }.getOrDefault(result("failed"))
    }

    fun installStream(context: Context, input: InputStream, length: Long): Map<String, Any?> =
        runCatching { input.use { install(context, it, length, null, KIND_FILE, "0") } }.getOrDefault(result("failed"))

    fun tracked(context: Context, sessionId: Int): Pair<String, String>? {
        val entry = sessions(context).getString(sessionId.toString(), null) ?: return null
        val (kind, tag) = entry.split('|', limit = 2).takeIf { it.size == 2 } ?: return null
        return kind to tag
    }

    private fun track(context: Context, sessionId: Int, kind: String, tag: String) {
        sessions(context).edit().putString(sessionId.toString(), "$kind|$tag").commit()
    }

    private fun untrack(context: Context, sessionId: Int) {
        sessions(context).edit().remove(sessionId.toString()).commit()
    }

    fun abandonTracked(context: Context, kind: String) {
        val installer = context.packageManager.packageInstaller
        for (key in sessions(context).all.keys.toList()) {
            val sessionId = key.toIntOrNull() ?: continue
            if (tracked(context, sessionId)?.first != kind) continue
            runCatching { installer.abandonSession(sessionId) }
            untrack(context, sessionId)
        }
    }

    fun install(context: Context, input: InputStream, length: Long, sha256: String?, kind: String, tag: String): Map<String, Any?> {
        if (!AppUpdateHandoff.canInstallPackages(context)) return result("needs_permission")
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (kind == KIND_UPDATE) params.setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        abandonTracked(context, kind)
        val sessionId = installer.createSession(params)
        track(context, sessionId, kind, tag)
        val session = installer.openSession(sessionId)
        var committed = false
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            session.openWrite("base.apk", 0, if (length > 0) length else -1).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
                session.fsync(output)
            }
            if (sha256 != null && digest.digest().joinToString("") { "%02x".format(it) } != sha256) return result("mismatch")
            val status = Intent(context, AppUpdateInstallReceiver::class.java).setPackage(context.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, status, flags).intentSender)
            committed = true
            return result("committed", sessionId)
        } finally {
            if (!committed) {
                runCatching { session.abandon() }
                untrack(context, sessionId)
            }
            runCatching { session.close() }
        }
    }

    fun report(context: Context, intent: Intent) {
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val (kind, tag) = tracked(context, sessionId) ?: return
        val outcome = when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> if (confirm(context, intent)) "confirming" else "aborted"
            PackageInstaller.STATUS_SUCCESS -> "success"
            PackageInstaller.STATUS_FAILURE_ABORTED -> "aborted"
            else -> "failure"
        }
        if (outcome != "confirming") untrack(context, sessionId)
        val event = mapOf("kind" to kind, "status" to outcome, "session" to sessionId.toString(), "download" to tag)
        val sink = statusSink
        if (sink != null) sink(event) else unreported = event
    }

    fun takeUnreported(): Map<String, Any?>? = unreported.also { unreported = null }

    @Suppress("DEPRECATION")
    private fun confirm(context: Context, intent: Intent): Boolean {
        val confirmation = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return false
        return runCatching { context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
    }
}

class AppUpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = AppUpdateInstaller.report(context, intent)
}
