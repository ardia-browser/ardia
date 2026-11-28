package com.ardia.phone

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.ardia.browser.DownloadFailure
import com.ardia.browser.DownloadOutcome
import com.ardia.browser.DownloadProgress
import com.ardia.browser.PageDownload

class DownloadNotifications(private val context: Context) {
    private val app: Context = context.applicationContext ?: context
    private val known = LinkedHashMap<Long, NoticeDownload>()
    private val running = LinkedHashMap<Long, NoticeDownload>()
    private val shownSteps = HashMap<Long, Int>()
    private val totals = HashMap<Long, Long>()
    private val finishedPrivate = HashMap<Long, String?>()

    fun started(id: Long, download: PageDownload, pageId: String) = synchronized(this) {
        val notice = NoticeDownload(id, download.fileName, download.url, pageId, download.isPrivate, download.privateSession)
        known[id] = notice
        trimKnown()
        running[id] = notice
        download.contentLength.takeIf { it > 0 }?.let { totals[id] = it }
        post(DownloadNotices.running(notice, 0, totals[id]), id)
        postSummary()
    }

    fun progressed(list: List<DownloadProgress>) = synchronized(this) {
        for (item in list) {
            val notice = running[item.id] ?: continue
            item.total?.takeIf { it > 0 }?.let { totals[item.id] = it }
            val total = totals[item.id]
            val step = if (total == null) -1 else ((item.bytes.coerceIn(0, total) * DownloadNotices.PROGRESS_STEPS) / total).toInt()
            if (shownSteps[item.id] == step) continue
            shownSteps[item.id] = step
            post(DownloadNotices.running(notice, item.bytes, total), item.id)
        }
    }

    fun finished(id: Long, outcome: DownloadOutcome) = synchronized(this) {
        val notice = running.remove(id) ?: known[id]
        shownSteps.remove(id)
        val total = totals.remove(id)
        postSummary()
        if (notice == null) return@synchronized
        when (outcome) {
            is DownloadOutcome.Finished -> {
                val uri = outcome.uri
                if (uri == null) cancel(id) else post(DownloadNotices.done(notice, outcome.fileName, total), id, uri.toString(), outcome.fileName)
            }
            is DownloadOutcome.Failed -> {
                if (outcome.reason == DownloadFailure.PrivateSessionEnded) {
                    cancel(id)
                    return@synchronized
                }
                post(DownloadNotices.failed(notice, outcome.fileName, outcome.reason), id)
            }
        }
        if (notice.isPrivate) finishedPrivate[id] = notice.privateSession
    }

    fun cancelled(id: Long) = synchronized(this) {
        running.remove(id)
        shownSteps.remove(id)
        totals.remove(id)
        known.remove(id)
        cancel(id)
        postSummary()
    }

    fun endPrivateSession(session: String?) = synchronized(this) {
        val ending = (running.values.filter { it.isPrivate && (session == null || it.privateSession == session) }.map { it.id } +
            finishedPrivate.filter { session == null || it.value == session }.keys).toSet()
        for (id in ending) {
            running.remove(id)
            shownSteps.remove(id)
            totals.remove(id)
            known.remove(id)
            finishedPrivate.remove(id)
            cancel(id)
        }
        postSummary()
    }

    fun download(id: Long): NoticeDownload? = synchronized(this) { known[id] }

    private fun trimKnown() {
        while (known.size > KEEP_KNOWN) known.remove(known.keys.first())
    }

    private fun postSummary() {
        val summary = DownloadNotices.summary(running.values.toList())
        if (summary == null) {
            runCatching { NotificationManagerCompat.from(app).cancel(DownloadNotices.SUMMARY_TAG, DownloadNotices.SUMMARY_ID) }
            return
        }
        post(summary, null)
    }

    private fun cancel(id: Long) {
        runCatching { NotificationManagerCompat.from(app).cancel(DownloadNotices.TAG, DownloadNotices.noticeId(id)) }
    }

    private fun post(notice: DownloadNotice, downloadId: Long?, uri: String? = null, fileName: String? = null) {
        if (!shown(app)) return
        val notification = build(app, notice, downloadId, uri, fileName) ?: return
        runCatching { NotificationManagerCompat.from(app).notify(notice.tag, notice.id, notification) }
    }

    companion object {
        private const val KEEP_KNOWN = 64
        private const val PREFERENCES = "ardia-download-notifications"
        private const val ASKED = "asked"
        const val ACTION_CANCEL = "com.ardia.phone.download.CANCEL"
        const val ACTION_RETRY = "com.ardia.phone.download.RETRY"
        const val EXTRA_DOWNLOAD = "download"
        const val EXTRA_URI = "uri"
        const val EXTRA_FILE_NAME = "fileName"
        const val EXTRA_PRIVATE = "private"

        fun ensureChannel(context: Context): NotificationManager? {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return null
            if (manager.getNotificationChannel(DownloadNotices.CHANNEL) == null) {
                runCatching {
                    val channel = NotificationChannel(DownloadNotices.CHANNEL, DownloadNotices.CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW)
                    channel.setShowBadge(false)
                    channel.setSound(null, null)
                    channel.enableVibration(false)
                    manager.createNotificationChannel(channel)
                }
            }
            return manager
        }

        fun shown(context: Context): Boolean {
            val manager = ensureChannel(context) ?: return false
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
            return (manager.getNotificationChannel(DownloadNotices.CHANNEL)?.importance ?: NotificationManager.IMPORTANCE_NONE) != NotificationManager.IMPORTANCE_NONE
        }

        fun askOnce(activity: Activity?): Boolean {
            if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
            if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return false
            val preferences = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            if (preferences.getBoolean(ASKED, false)) return false
            preferences.edit().putBoolean(ASKED, true).apply()
            return runCatching { ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), ASK_REQUEST) }.isSuccess
        }

        private const val ASK_REQUEST = 4217

        fun build(context: Context, notice: DownloadNotice, downloadId: Long?, uri: String?, fileName: String?): Notification? {
            val builder = NotificationCompat.Builder(context, DownloadNotices.CHANNEL)
                .setSmallIcon(iconOf(notice.icon))
                .setContentTitle(notice.title)
                .setOngoing(notice.ongoing)
                .setAutoCancel(notice.autoCancel)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(!notice.ongoing)
                .setCategory(if (notice.ongoing) NotificationCompat.CATEGORY_PROGRESS else NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
            notice.text?.let(builder::setContentText)
            notice.progress?.let { builder.setProgress(it.max, it.current, it.indeterminate) }
            notice.group?.let(builder::setGroup)
            if (notice.isSummary) {
                builder.setGroupSummary(true)
                val inbox = NotificationCompat.InboxStyle()
                notice.lines.forEach { inbox.addLine(it) }
                builder.setStyle(inbox)
            }
            if (notice.publicTitle != null) {
                builder.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                builder.setPublicVersion(
                    NotificationCompat.Builder(context, DownloadNotices.CHANNEL)
                        .setSmallIcon(iconOf(notice.icon))
                        .setContentTitle(notice.publicTitle)
                        .setSilent(true)
                        .build(),
                )
            } else {
                builder.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            }
            val redacted = notice.publicTitle != null && !notice.isSummary
            when (notice.tap) {
                NoticeTap.OpenFile -> if (uri != null && downloadId != null) builder.setContentIntent(openIntent(context, notice.id, downloadId, uri, fileName.orEmpty(), redacted))
                NoticeTap.OpenApp -> launchIntent(context, notice.id)?.let(builder::setContentIntent)
                NoticeTap.None -> Unit
            }
            for (action in notice.actions) {
                val id = downloadId ?: continue
                when (action) {
                    NoticeAction.Cancel -> builder.addAction(0, "Cancel", actionIntent(context, ACTION_CANCEL, notice.id, id, redacted))
                    NoticeAction.Retry -> builder.addAction(0, "Retry", actionIntent(context, ACTION_RETRY, notice.id, id, redacted))
                }
            }
            return builder.build()
        }

        private fun iconOf(icon: NoticeIcon): Int = when (icon) {
            NoticeIcon.Downloading -> android.R.drawable.stat_sys_download
            NoticeIcon.Done -> android.R.drawable.stat_sys_download_done
            NoticeIcon.Failed -> android.R.drawable.stat_notify_error
        }

        private fun actionIntent(context: Context, action: String, request: Int, downloadId: Long, redacted: Boolean): PendingIntent {
            val intent = Intent(context, DownloadNoticeReceiver::class.java)
                .setAction(action)
                .setPackage(context.packageName)
                .putExtra(EXTRA_DOWNLOAD, downloadId)
                .putExtra(EXTRA_PRIVATE, redacted)
            return PendingIntent.getBroadcast(context, request * 4 + if (action == ACTION_CANCEL) 1 else 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        private fun openIntent(context: Context, request: Int, downloadId: Long, uri: String, fileName: String, redacted: Boolean): PendingIntent {
            val intent = Intent(context, DownloadOpenActivity::class.java)
                .setPackage(context.packageName)
                .putExtra(EXTRA_DOWNLOAD, downloadId)
                .putExtra(EXTRA_URI, uri)
                .putExtra(EXTRA_FILE_NAME, fileName)
                .putExtra(EXTRA_PRIVATE, redacted)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            return PendingIntent.getActivity(context, request * 4 + 3, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        private fun launchIntent(context: Context, request: Int): PendingIntent? {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            return PendingIntent.getActivity(context, request * 4, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
