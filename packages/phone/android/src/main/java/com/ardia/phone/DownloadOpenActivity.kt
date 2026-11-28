package com.ardia.phone

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper

class DownloadOpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.getStringExtra(DownloadNotifications.EXTRA_URI)
        val fileName = intent.getStringExtra(DownloadNotifications.EXTRA_FILE_NAME).orEmpty()
        val isPrivate = intent.getBooleanExtra(DownloadNotifications.EXTRA_PRIVATE, true)
        val parsed = uri?.let(Uri::parse)
        if (parsed == null || parsed.scheme != "content") {
            finish()
            return
        }
        if (!isPrivate) PendingCounts.add(this, DOWNLOAD_NOTIFICATIONS_OPENED, UsageConsent.window(this))
        if (DownloadNotices.opensInInstaller(fileName)) install(parsed) else view(parsed)
    }

    private fun install(uri: Uri) {
        val app = applicationContext
        Thread {
            val result = runCatching { AppUpdateHandoff.installDownloadedFile(app, uri.toString())["result"] }.getOrNull()
            Handler(Looper.getMainLooper()).post {
                if (result == "needs_permission") AppUpdateHandoff.openInstallPermission(app, this)
                else if (result != "committed") view(uri)
                finish()
            }
        }.start()
    }

    private fun view(uri: Uri) {
        val open = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(open)
        } catch (missing: ActivityNotFoundException) {
            packageManager.getLaunchIntentForPackage(packageName)?.let { runCatching { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
        } catch (refused: SecurityException) {
            Unit
        }
        if (!isFinishing) finish()
    }

    companion object {
        const val DOWNLOAD_NOTIFICATIONS_OPENED = "download_notifications_opened"
    }
}
