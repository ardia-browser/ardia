package com.ardia.phone

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageToneGateTest {
    @Test
    fun aJustAttachedPageReportsNoToneUntilItHasBeenSampledUnlessItNamesATheme() {
        assertFalse("the CSS background alone, before the first sample: python.org's white", PageToneGate.reports(themeColor = null, failed = false, sampledSinceBind = false))
        assertTrue("after a sample attempt, whatever it found", PageToneGate.reports(themeColor = null, failed = false, sampledSinceBind = true))
        assertTrue("a theme colour is the page's own word", PageToneGate.reports(themeColor = 0xFF11171D.toInt(), failed = false, sampledSinceBind = false))
        assertTrue("an error page's tone needs no sample", PageToneGate.reports(themeColor = null, failed = true, sampledSinceBind = false))
    }
}
