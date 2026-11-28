package com.ardia.phone

import com.ardia.browser.DownloadFailure
import java.util.Locale

data class NoticeDownload(
    val id: Long,
    val fileName: String,
    val url: String,
    val pageId: String,
    val isPrivate: Boolean,
    val privateSession: String?,
)

enum class NoticeAction { Cancel, Retry }

enum class NoticeTap { None, OpenFile, OpenApp }

enum class NoticeIcon { Downloading, Done, Failed }

data class NoticeProgress(val max: Int, val current: Int, val indeterminate: Boolean)

data class DownloadNotice(
    val tag: String,
    val id: Int,
    val title: String,
    val text: String?,
    val publicTitle: String?,
    val progress: NoticeProgress?,
    val ongoing: Boolean,
    val autoCancel: Boolean,
    val actions: List<NoticeAction>,
    val group: String?,
    val isSummary: Boolean,
    val icon: NoticeIcon,
    val tap: NoticeTap,
    val lines: List<String> = emptyList(),
)

object DownloadNotices {
    const val CHANNEL = "ardia-downloads"
    const val CHANNEL_NAME = "Downloads"
    const val TAG = "ardia-download"
    const val SUMMARY_TAG = "ardia-download-summary"
    const val SUMMARY_ID = 1
    const val RUNNING_GROUP = "ardia.downloads.running"
    const val PRIVATE_TITLE = "Incognito download"
    const val COMPLETE_TITLE = "Download complete"
    const val DOWNLOADING_TEXT = "Downloading…"
    const val PROGRESS_STEPS = 100

    val FAILURE_WHY: Map<DownloadFailure, String> = mapOf(
        DownloadFailure.Network to "Check your connection and try again.",
        DownloadFailure.Server to "The site didn’t send the file.",
        DownloadFailure.InsecureRedirect to "The site moved it to an insecure address.",
        DownloadFailure.TooManyRedirects to "The site kept redirecting.",
        DownloadFailure.Unsupported to "Ardia can’t save this kind of link.",
        DownloadFailure.Storage to "Ardia couldn’t write it to Downloads.",
        DownloadFailure.NoSpace to "Your phone is out of space.",
    )

    private val RETRYABLE = setOf(DownloadFailure.Network, DownloadFailure.Server, DownloadFailure.Storage)

    private val HOST = Regex("^https?://(?:[^@/?#]*@)?(\\[[^\\]]*]|[^:/?#]+)", RegexOption.IGNORE_CASE)

    fun noticeId(downloadId: Long): Int = (downloadId and 0x3fffffffL).toInt() + 2

    fun host(url: String): String? {
        val found = HOST.find(url.trim())?.groupValues?.get(1)?.lowercase(Locale.ROOT)?.removePrefix("www.") ?: return null
        return found.ifEmpty { null }
    }

    fun shownHost(download: NoticeDownload): String? = if (download.isPrivate) null else host(download.url)

    fun sizeText(bytes: Long): String {
        if (bytes <= 0) return "Zero KB"
        if (bytes < 1000) return if (bytes == 1L) "1 byte" else "$bytes bytes"
        val units = listOf(Triple("KB", 1e3, 0), Triple("MB", 1e6, 1), Triple("GB", 1e9, 2), Triple("TB", 1e12, 2))
        val unit = units.last { bytes >= it.second }
        val value = bytes / unit.second
        val factor = Math.pow(10.0, unit.third.toDouble())
        val rounded = Math.round(value * factor) / factor
        val shown = if (rounded == Math.floor(rounded)) String.format(Locale.US, "%,d", rounded.toLong()) else String.format(Locale.US, "%,." + unit.third + "f", rounded).trimEnd('0').trimEnd('.')
        return "$shown ${unit.first}"
    }

    fun retries(download: NoticeDownload, failure: DownloadFailure): Boolean =
        !download.isPrivate && failure in RETRYABLE && download.url.trim().let { it.startsWith("http://", true) || it.startsWith("https://", true) }

    fun failedTitle(fileName: String): String = if (fileName.isBlank()) "Couldn’t download the file" else "Couldn’t download $fileName"

    private fun nameOf(download: NoticeDownload) = download.fileName.ifBlank { "Download" }

    private fun publicTitle(download: NoticeDownload) = if (download.isPrivate) PRIVATE_TITLE else null

    fun running(download: NoticeDownload, bytes: Long, total: Long?): DownloadNotice {
        val known = total?.takeIf { it > 0 }
        val progress = if (known == null) NoticeProgress(0, 0, true) else NoticeProgress(PROGRESS_STEPS, ((bytes.coerceIn(0, known) * PROGRESS_STEPS) / known).toInt(), false)
        return DownloadNotice(
            tag = TAG,
            id = noticeId(download.id),
            title = nameOf(download),
            text = shownHost(download) ?: DOWNLOADING_TEXT,
            publicTitle = publicTitle(download),
            progress = progress,
            ongoing = true,
            autoCancel = false,
            actions = listOf(NoticeAction.Cancel),
            group = RUNNING_GROUP,
            isSummary = false,
            icon = NoticeIcon.Downloading,
            tap = NoticeTap.OpenApp,
        )
    }

    fun done(download: NoticeDownload, fileName: String, size: Long?): DownloadNotice {
        val name = fileName.ifBlank { nameOf(download) }
        val text = listOfNotNull(name, size?.takeIf { it > 0 }?.let(::sizeText)).joinToString(" · ")
        return DownloadNotice(
            tag = TAG,
            id = noticeId(download.id),
            title = COMPLETE_TITLE,
            text = text,
            publicTitle = publicTitle(download),
            progress = null,
            ongoing = false,
            autoCancel = true,
            actions = emptyList(),
            group = null,
            isSummary = false,
            icon = NoticeIcon.Done,
            tap = NoticeTap.OpenFile,
        )
    }

    fun failed(download: NoticeDownload, fileName: String, failure: DownloadFailure): DownloadNotice = DownloadNotice(
        tag = TAG,
        id = noticeId(download.id),
        title = failedTitle(fileName.ifBlank { download.fileName }),
        text = FAILURE_WHY[failure],
        publicTitle = publicTitle(download),
        progress = null,
        ongoing = false,
        autoCancel = true,
        actions = if (retries(download, failure)) listOf(NoticeAction.Retry) else emptyList(),
        group = null,
        isSummary = false,
        icon = NoticeIcon.Failed,
        tap = NoticeTap.OpenApp,
    )

    fun summary(running: List<NoticeDownload>): DownloadNotice? {
        if (running.size < 2) return null
        val anyPrivate = running.any { it.isPrivate }
        return DownloadNotice(
            tag = SUMMARY_TAG,
            id = SUMMARY_ID,
            title = "${running.size} downloads",
            text = if (anyPrivate) null else running.joinToString(", ") { nameOf(it) },
            publicTitle = if (anyPrivate) "${running.size} downloads" else null,
            progress = null,
            ongoing = true,
            autoCancel = false,
            actions = emptyList(),
            group = RUNNING_GROUP,
            isSummary = true,
            icon = NoticeIcon.Downloading,
            tap = NoticeTap.OpenApp,
            lines = running.map { if (it.isPrivate) PRIVATE_TITLE else nameOf(it) },
        )
    }

    fun opensInInstaller(fileName: String): Boolean = fileName.trim().endsWith(".apk", ignoreCase = true)
}
