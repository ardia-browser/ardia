package com.ardia.phone

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

internal object AppUpdateHandoff {
    const val APK_MIME = "application/vnd.android.package-archive"
    private const val DOWNLOADS_PROVIDER = "com.android.providers.downloads"
    private const val UPDATES_DIR = "updates"
    private const val CHANNEL = "app_updates"
    private const val NOTIFICATION_ID = 4378
    private const val EXTRA_INSTALL_REQUEST = "com.ardia.phone.INSTALL_UPDATE"
    private const val TOKEN_PREFS = "ardia_app_update_install"
    private const val TOKEN_KEY = "token"
    private val RELEASE_APK = Regex("^https://github\\.com/ardia-browser/ardia/releases/download/android-v((?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})(?:-nightly\\.(?:0|[1-9][0-9]{0,8}))?)/Ardia-([0-9A-Za-z.-]{1,40})\\.apk$")
    private val APK_FILE = Regex("^Ardia-[0-9A-Za-z.-]{1,40}\\.apk$")
    private val SHA256 = Regex("^[0-9a-f]{64}$")

    fun releaseApkName(url: String): String? {
        if (url.length > 300) return null
        val match = RELEASE_APK.matchEntire(url) ?: return null
        val version = match.groupValues[1]
        return if (match.groupValues[2] == version) "Ardia-$version.apk" else null
    }

    fun start(context: Context, activity: Activity?, url: String, title: String): Map<String, Any?> {
        val fileName = releaseApkName(url) ?: return mapOf("handoff" to "unavailable")
        enqueue(context, url, fileName, title)?.let {
            ensureChannel(context)
            return mapOf("handoff" to "notifications", "id" to it.toString())
        }
        if (openElsewhere(context, activity, url, title)) return mapOf("handoff" to "browser")
        return mapOf("handoff" to "unavailable")
    }

    fun status(context: Context, id: String): String {
        val number = id.toLongOrNull()?.takeIf { it > 0 } ?: return "gone"
        val manager = context.getSystemService(DownloadManager::class.java) ?: return "gone"
        return runCatching {
            manager.query(DownloadManager.Query().setFilterById(number))?.use { cursor ->
                if (!cursor.moveToFirst()) return@use "gone"
                when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                    DownloadManager.STATUS_PENDING -> "pending"
                    DownloadManager.STATUS_RUNNING -> "running"
                    DownloadManager.STATUS_PAUSED -> "paused"
                    DownloadManager.STATUS_SUCCESSFUL -> "successful"
                    DownloadManager.STATUS_FAILED -> "failed"
                    else -> "gone"
                }
            } ?: "gone"
        }.getOrDefault("gone")
    }

    fun progress(context: Context, id: String): Double {
        val number = id.toLongOrNull()?.takeIf { it > 0 } ?: return -1.0
        val manager = context.getSystemService(DownloadManager::class.java) ?: return -1.0
        return runCatching {
            manager.query(DownloadManager.Query().setFilterById(number))?.use { cursor ->
                if (!cursor.moveToFirst()) return@use -1.0
                val done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                if (total > 0 && done >= 0) (done.toDouble() / total).coerceIn(0.0, 1.0) else -1.0
            } ?: -1.0
        }.getOrDefault(-1.0)
    }

    fun verify(context: Context, id: String, sha256: String, fileName: String): String {
        if (!SHA256.matches(sha256) || !APK_FILE.matches(fileName)) return "failed"
        val number = id.toLongOrNull()?.takeIf { it > 0 } ?: return "gone"
        if (status(context, id) != "successful") return "gone"
        val manager = context.getSystemService(DownloadManager::class.java) ?: return "gone"
        val directory = File(context.cacheDir, UPDATES_DIR).apply { mkdirs() }
        directory.listFiles()?.filter { it.name != fileName }?.forEach { it.delete() }
        val descriptor = runCatching { manager.openDownloadedFile(number) }.getOrNull() ?: return "gone"
        val result = runCatching { descriptor.use { FileInputStream(it.fileDescriptor).use { input -> verifiedCopy(input, File(directory, fileName), sha256) } } }.getOrDefault("copy_failed")
        if (result == "mismatch") runCatching { manager.remove(number) }
        return result
    }

    fun installVerified(context: Context, fileName: String, sha256: String, downloadId: String): Map<String, Any?> {
        val copy = verifiedFile(context, fileName) ?: return mapOf("result" to "gone")
        clearReadyNotification(context)
        return AppUpdateInstaller.installFile(context, copy, sha256, downloadId)
    }

    fun discard(context: Context, id: String): Boolean {
        clearReadyNotification(context)
        AppUpdateInstaller.abandonTracked(context, AppUpdateInstaller.KIND_UPDATE)
        File(context.cacheDir, UPDATES_DIR).listFiles()?.forEach { it.delete() }
        val number = id.toLongOrNull()?.takeIf { it > 0 } ?: return false
        return runCatching { (context.getSystemService(DownloadManager::class.java)?.remove(number) ?: 0) > 0 }.getOrDefault(false)
    }

    fun verifiedCopy(input: InputStream, destination: File, sha256: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val partial = File(destination.parentFile, "${destination.name}.part")
        var kept = false
        try {
            partial.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
            }
            val found = digest.digest().joinToString("") { "%02x".format(it) }
            destination.delete()
            if (found != sha256) return "mismatch"
            kept = partial.renameTo(destination)
            return if (kept) "verified" else "copy_failed"
        } catch (failure: IOException) {
            return "copy_failed"
        } finally {
            if (!kept) partial.delete()
        }
    }

    fun ensureChannel(context: Context): NotificationManager? {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return null
        if (manager.getNotificationChannel(CHANNEL) == null) runCatching { manager.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT)) }
        return manager
    }

    fun notificationsShown(context: Context): Boolean {
        val manager = ensureChannel(context) ?: return false
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return (manager.getNotificationChannel(CHANNEL)?.importance ?: NotificationManager.IMPORTANCE_NONE) != NotificationManager.IMPORTANCE_NONE
    }

    fun notifyReady(context: Context, fileName: String, title: String, text: String): Boolean {
        if (verifiedFile(context, fileName) == null || !notificationsShown(context)) return false
        val notifications = NotificationManagerCompat.from(context)
        val open = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return false
        open.putExtra(EXTRA_INSTALL_REQUEST, issueInstallToken(context)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        return runCatching { notifications.notify(NOTIFICATION_ID, notification) }.isSuccess
    }

    @Volatile private var installRequested = false

    private fun tokens(context: Context) = context.getSharedPreferences(TOKEN_PREFS, Context.MODE_PRIVATE)

    fun issueInstallToken(context: Context): String {
        val token = UUID.randomUUID().toString()
        tokens(context).edit().putString(TOKEN_KEY, token).commit()
        return token
    }

    fun noteInstallRequest(context: Context, intent: Intent?) {
        val token = intent?.getStringExtra(EXTRA_INSTALL_REQUEST) ?: return
        intent.removeExtra(EXTRA_INSTALL_REQUEST)
        val issued = tokens(context).getString(TOKEN_KEY, null) ?: return
        if (token != issued) return
        tokens(context).edit().remove(TOKEN_KEY).commit()
        installRequested = true
    }

    fun takeInstallRequest(context: Context, activity: Activity?): Boolean {
        noteInstallRequest(context, activity?.intent)
        return installRequested.also { installRequested = false }
    }

    fun clearReadyNotification(context: Context) {
        runCatching { NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID) }
    }

    fun askForNotifications(activity: Activity?) {
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        runCatching { ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_ID) }
    }

    private fun verifiedFile(context: Context, fileName: String): File? {
        if (!APK_FILE.matches(fileName)) return null
        return File(File(context.cacheDir, UPDATES_DIR), fileName).takeIf { it.isFile }
    }

    fun canInstallPackages(context: Context): Boolean = runCatching { context.packageManager.canRequestPackageInstalls() }.getOrDefault(false)

    fun openInstallPermission(context: Context, activity: Activity?): Boolean {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        return startFrom(context, activity, intent)
    }

    fun installDownloadedFile(context: Context, uri: String): Map<String, Any?> {
        val parsed = Uri.parse(uri)
        if (parsed.scheme != "content") return mapOf("result" to "failed")
        if (!canInstallPackages(context)) return mapOf("result" to "needs_permission")
        val length = runCatching { context.contentResolver.openAssetFileDescriptor(parsed, "r")?.use { it.length } }.getOrNull() ?: -1L
        val input = runCatching { context.contentResolver.openInputStream(parsed) }.getOrNull() ?: return mapOf("result" to "failed")
        return AppUpdateInstaller.installStream(context, input, length)
    }

    private fun startFrom(context: Context, activity: Activity?, intent: Intent): Boolean {
        val starter: Context = activity ?: context
        if (starter !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { starter.startActivity(intent) }.isSuccess
    }

    private fun downloadManagerEnabled(context: Context): Boolean {
        val state = runCatching { context.packageManager.getApplicationEnabledSetting(DOWNLOADS_PROVIDER) }.getOrNull() ?: return false
        return state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT || state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
    }

    private fun enqueue(context: Context, url: String, fileName: String, title: String): Long? {
        if (!downloadManagerEnabled(context)) return null
        val manager = context.getSystemService(DownloadManager::class.java) ?: return null
        return runCatching {
            val request = DownloadManager.Request(Uri.parse(url))
                .setMimeType(APK_MIME)
                .setTitle(title)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName)
            manager.enqueue(request)
        }.getOrNull()?.takeIf { it > 0 }
    }

    @Suppress("DEPRECATION")
    private fun openElsewhere(context: Context, activity: Activity?, url: String, title: String): Boolean {
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        val handlers = runCatching { context.packageManager.queryIntentActivities(view, PackageManager.MATCH_DEFAULT_ONLY) }.getOrDefault(emptyList())
        val own = handlers.filter { it.activityInfo.packageName == context.packageName }.map { ComponentName(it.activityInfo.packageName, it.activityInfo.name) }
        val others = handlers.filter { it.activityInfo.packageName != context.packageName }
        if (others.isEmpty()) return false
        val launch = if (others.size == 1) {
            view.setComponent(ComponentName(others[0].activityInfo.packageName, others[0].activityInfo.name))
        } else {
            Intent.createChooser(view, title).putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, own.toTypedArray())
        }
        return startFrom(context, activity, launch)
    }
}
