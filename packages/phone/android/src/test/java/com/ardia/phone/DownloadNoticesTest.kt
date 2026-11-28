package com.ardia.phone

import com.ardia.browser.DownloadFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadNoticesTest {
    private val pdf = NoticeDownload(7, "report.pdf", "https://www.files.example/a/report.pdf", "t0", isPrivate = false, privateSession = null)
    private val secret = NoticeDownload(8, "secret.pdf", "https://files.example/secret.pdf", "t1", isPrivate = true, privateSession = "s1")
    private val blob = NoticeDownload(9, "export.csv", "blob:https://files.example/7b0c", "t0", isPrivate = false, privateSession = null)

    @Test
    fun aRunningDownloadNamesItsFileAndSiteWithABarAndCancel() {
        val notice = DownloadNotices.running(pdf, 450, 1000)
        assertEquals("report.pdf", notice.title)
        assertEquals("files.example", notice.text)
        assertEquals(NoticeProgress(100, 45, false), notice.progress)
        assertTrue(notice.ongoing)
        assertFalse(notice.autoCancel)
        assertEquals(listOf(NoticeAction.Cancel), notice.actions)
        assertEquals(DownloadNotices.RUNNING_GROUP, notice.group)
        assertNull(notice.publicTitle)
    }

    @Test
    fun anUnknownSizeSpinsAndABlobLinkShowsNoHost() {
        val notice = DownloadNotices.running(blob, 1200, null)
        assertEquals(NoticeProgress(0, 0, true), notice.progress)
        assertEquals(DownloadNotices.DOWNLOADING_TEXT, notice.text)
        assertNull(DownloadNotices.host("data:text/plain;base64,AAA"))
        assertEquals("127.0.0.1", DownloadNotices.host("http://user:pw@127.0.0.1:8099/fast/a.pdf"))
    }

    @Test
    fun aFinishedDownloadSaysDownloadCompleteWithItsNameAndSizeAndOpensTheFile() {
        val notice = DownloadNotices.done(pdf, "report (1).pdf", 1_234_567)
        assertEquals("Download complete", notice.title)
        assertEquals("report (1).pdf · 1.2 MB", notice.text)
        assertEquals(NoticeTap.OpenFile, notice.tap)
        assertTrue(notice.autoCancel)
        assertFalse(notice.ongoing)
        assertNull(notice.progress)
        assertNull(notice.group)
        assertEquals("report.pdf", DownloadNotices.done(pdf, "", null).text)
    }

    @Test
    fun aFailureLeadsWithTheHeadlineGivesTheReasonAndOffersRetryOnlyWhereTheCardDoes() {
        val server = DownloadNotices.failed(pdf, "report.pdf", DownloadFailure.Server)
        assertEquals("Couldn’t download report.pdf", server.title)
        assertEquals("The site didn’t send the file.", server.text)
        assertEquals(listOf(NoticeAction.Retry), server.actions)
        assertEquals(emptyList<NoticeAction>(), DownloadNotices.failed(pdf, "report.pdf", DownloadFailure.NoSpace).actions)
        assertEquals(emptyList<NoticeAction>(), DownloadNotices.failed(secret, "secret.pdf", DownloadFailure.Network).actions)
        assertEquals(emptyList<NoticeAction>(), DownloadNotices.failed(blob, "export.csv", DownloadFailure.Network).actions)
        assertEquals(NoticeTap.OpenApp, server.tap)
    }

    @Test
    fun anIncognitoDownloadShowsOnlyIncognitoDownloadOnTheLockScreenAndNoHostAnywhere() {
        val running = DownloadNotices.running(secret, 10, 100)
        assertEquals("Incognito download", running.publicTitle)
        assertEquals(DownloadNotices.DOWNLOADING_TEXT, running.text)
        assertEquals("Incognito download", DownloadNotices.done(secret, "secret.pdf", 100).publicTitle)
        assertEquals("Incognito download", DownloadNotices.failed(secret, "secret.pdf", DownloadFailure.Server).publicTitle)
    }

    @Test
    fun twoRunningDownloadsGetASummaryAndOneDoesNot() {
        assertNull(DownloadNotices.summary(listOf(pdf)))
        val summary = DownloadNotices.summary(listOf(pdf, blob))!!
        assertEquals("2 downloads", summary.title)
        assertEquals("report.pdf, export.csv", summary.text)
        assertTrue(summary.isSummary)
        assertEquals(DownloadNotices.RUNNING_GROUP, summary.group)
        assertNull(summary.publicTitle)
        val mixed = DownloadNotices.summary(listOf(pdf, secret))!!
        assertNull(mixed.text)
        assertEquals("2 downloads", mixed.publicTitle)
        assertEquals(listOf("report.pdf", "Incognito download"), mixed.lines)
    }

    @Test
    fun sizesReadAsTheCardsDo() {
        assertEquals("Zero KB", DownloadNotices.sizeText(0))
        assertEquals("512 bytes", DownloadNotices.sizeText(512))
        assertEquals("12 KB", DownloadNotices.sizeText(12_400))
        assertEquals("1.2 MB", DownloadNotices.sizeText(1_234_567))
        assertEquals("4 MB", DownloadNotices.sizeText(4_000_000))
        assertEquals("2.5 GB", DownloadNotices.sizeText(2_500_000_000))
    }

    @Test
    fun everyFailureButASessionEndHasAReasonAndOnlyApksGoToTheInstaller() {
        DownloadFailure.entries.filter { it != DownloadFailure.PrivateSessionEnded }.forEach { assertTrue(it.name, DownloadNotices.FAILURE_WHY.containsKey(it)) }
        assertTrue(DownloadNotices.opensInInstaller("Ardia.APK"))
        assertFalse(DownloadNotices.opensInInstaller("ardia.apk.zip"))
        assertTrue(DownloadNotices.noticeId(1) != DownloadNotices.SUMMARY_ID)
    }
}
