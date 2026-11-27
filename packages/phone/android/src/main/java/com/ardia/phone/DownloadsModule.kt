package com.ardia.phone

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class DownloadsModule : Module() {
    private val context: Context get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app context is gone", null)
    private var completions: BroadcastReceiver? = null

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneDownloads")

        Events("onDownloadEvent", "onAppUpdateDownloaded", "onAppUpdateInstallStatus")

        OnCreate {
            PhonePages.downloadSink = { sendEvent("onDownloadEvent", it) }
            AppUpdateInstaller.statusSink = { sendEvent("onAppUpdateInstallStatus", it) }
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(received: Context, intent: Intent) {
                    val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                    if (id > 0) sendEvent("onAppUpdateDownloaded", mapOf("id" to id.toString()))
                }
            }
            appContext.reactContext?.let { owner ->
                runCatching { ContextCompat.registerReceiver(owner, receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED) }
                    .onSuccess { completions = receiver }
            }
        }

        OnDestroy {
            PhonePages.downloadSink = null
            AppUpdateInstaller.statusSink = null
            completions?.let { receiver -> runCatching { appContext.reactContext?.unregisterReceiver(receiver) } }
            completions = null
        }

        AsyncFunction("active") { ->
            PhonePages.engine(context)
            PhonePages.downloads.active.value.map {
                mapOf(
                    "id" to it.id.toString(),
                    "fileName" to it.fileName,
                    "bytes" to it.bytes.toDouble(),
                    "total" to it.total?.toDouble(),
                    "fraction" to it.fraction?.toDouble(),
                    "isQueued" to it.isQueued,
                )
            }
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("cancel") { id: String ->
            PhonePages.engine(context)
            id.toLongOrNull()?.let(PhonePages.downloads::cancel)
            Unit
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("open") { uri: String ->
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                (appContext.currentActivity ?: context).startActivity(intent)
                true
            } catch (missing: ActivityNotFoundException) {
                false
            } catch (refused: SecurityException) {
                false
            }
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("handOffAppUpdate") { url: String, title: String ->
            AppUpdateHandoff.start(context, appContext.currentActivity, url, title)
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("appUpdateStatus") { id: String -> AppUpdateHandoff.status(context, id) }

        AsyncFunction("appUpdateProgress") { id: String -> AppUpdateHandoff.progress(context, id) }

        AsyncFunction("verifyAppUpdate") { id: String, sha256: String, fileName: String -> AppUpdateHandoff.verify(context, id, sha256, fileName) }

        AsyncFunction("installVerifiedUpdate") { fileName: String, sha256: String, downloadId: String -> AppUpdateHandoff.installVerified(context, fileName, sha256, downloadId) }

        Function("updateNotificationsShown") { AppUpdateHandoff.notificationsShown(context) }

        Function("takeInstallRequest") { AppUpdateHandoff.takeInstallRequest(context, appContext.currentActivity) }

        Function("takeInstallStatus") { AppUpdateInstaller.takeUnreported() }

        AsyncFunction("notifyUpdateReady") { fileName: String, title: String, text: String -> AppUpdateHandoff.notifyReady(context, fileName, title, text) }

        AsyncFunction("askForUpdateNotifications") { AppUpdateHandoff.askForNotifications(appContext.currentActivity) }.runOnQueue(Queues.MAIN)

        AsyncFunction("discardAppUpdate") { id: String -> AppUpdateHandoff.discard(context, id) }

        Function("canInstallPackages") { AppUpdateHandoff.canInstallPackages(context) }

        AsyncFunction("openInstallPermission") { AppUpdateHandoff.openInstallPermission(context, appContext.currentActivity) }.runOnQueue(Queues.MAIN)

        AsyncFunction("installDownloadedFile") { uri: String -> AppUpdateHandoff.installDownloadedFile(context, uri) }

        OnNewIntent { intent -> appContext.reactContext?.let { AppUpdateHandoff.noteInstallRequest(it, intent) } }

        AsyncFunction("files") { -> DownloadedFiles.list(context) }

        AsyncFunction("delete") { uri: String -> DownloadedFiles.delete(context, uri) }

        AsyncFunction("deleteAll") { -> DownloadedFiles.deleteAll(context) }

        AsyncFunction("preview") { uri: String -> DownloadedFiles.preview(context, uri) }.runOnQueue(Queues.MAIN)

        AsyncFunction("share") { uri: String -> DownloadedFiles.share(context, uri) }.runOnQueue(Queues.MAIN)
    }
}
