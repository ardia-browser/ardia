package com.ardia.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemDownloadsSessionTest {
    private class EndingEngine : DownloadSessions {
        var live = true
        var listener: ((String) -> Unit)? = null

        override fun privateCookieHeader(url: String, session: String): String? = null

        override fun isPrivateSessionLive(session: String): Boolean = live

        override fun addPrivateSessionEndListener(listener: (String) -> Unit): AutoCloseable {
            this.listener = listener
            return AutoCloseable { this.listener = null }
        }
    }

    private fun download(session: String?) = PageDownload(
        url = "blob:https://a.example/1",
        fileName = "a.txt",
        mimeType = "text/plain",
        contentLength = 1,
        userAgent = null,
        contentDisposition = null,
        referer = null,
        isPrivate = true,
        privateSession = session,
        source = DownloadSource { throw DownloadRefused(DownloadFailure.Server) },
    )

    @Test
    fun aSessionToldItIsEndingTakesNoNewDownloadEvenWhileTheEngineStillCallsItLive() {
        val engine = EndingEngine()
        val downloads = SystemDownloads(RuntimeEnvironment.getApplication(), sessions = engine)
        assertTrue(downloads.start(download("s1")) is DownloadStart.Started)
        val listener = engine.listener ?: error("SystemDownloads listens for session ends")
        listener("s1")
        assertTrue(engine.live)
        assertEquals(DownloadStart.Refused(DownloadFailure.PrivateSessionEnded), downloads.start(download("s1")))
        assertTrue(downloads.start(download("s2")) is DownloadStart.Started)
    }

    @Test
    fun onlyTheLastSessionsAreRemembered() {
        val engine = EndingEngine()
        val downloads = SystemDownloads(RuntimeEnvironment.getApplication(), sessions = engine)
        downloads.start(download("s0"))
        repeat(40) { engine.listener!!("old$it") }
        assertEquals(DownloadStart.Refused(DownloadFailure.PrivateSessionEnded), downloads.start(download("old39")))
        assertTrue(downloads.start(download("old0")) is DownloadStart.Started)
    }
}
