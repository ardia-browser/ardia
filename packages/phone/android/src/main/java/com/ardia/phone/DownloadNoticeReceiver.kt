package com.ardia.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class DownloadNoticeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getLongExtra(DownloadNotifications.EXTRA_DOWNLOAD, -1L)
        if (id <= 0L) return
        val isPrivate = intent.getBooleanExtra(DownloadNotifications.EXTRA_PRIVATE, true)
        when (intent.action) {
            DownloadNotifications.ACTION_CANCEL -> PhonePages.cancelDownloadFromNotice(context, id, isPrivate)
            DownloadNotifications.ACTION_RETRY -> PhonePages.retryDownloadFromNotice(context, id)
        }
    }
}
