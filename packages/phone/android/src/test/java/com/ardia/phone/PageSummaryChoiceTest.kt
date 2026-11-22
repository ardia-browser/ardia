package com.ardia.phone

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PageSummaryChoiceTest {
    private val context: Context = RuntimeEnvironment.getApplication()

    @Test
    fun aFreshOrOlderInstallHasPinchToSummarizeOffOnThisPhone() {
        assertFalse(PageSummaryChoice.isEnabled(context))
        assertEquals(PageSummaryProvider.OnDevice, PageSummaryChoice.stored(context))
        context.getSharedPreferences("ardia-page-summary", Context.MODE_PRIVATE).edit().putString("provider", "chatgpt").commit()
        assertFalse(PageSummaryChoice.isEnabled(context))
    }

    @Test
    fun turningItOnAndOffIsRememberedAndLeavesTheProviderAlone() {
        PageSummaryChoice.choose(context, PageSummaryProvider.ChatGPT)
        PageSummaryChoice.enable(context, true)
        assertTrue(PageSummaryChoice.isEnabled(context))
        assertEquals(PageSummaryProvider.ChatGPT, PageSummaryChoice.stored(context))
        PageSummaryChoice.enable(context, false)
        assertFalse(PageSummaryChoice.isEnabled(context))
        assertEquals(PageSummaryProvider.ChatGPT, PageSummaryChoice.stored(context))
        PageSummaryChoice.choose(context, PageSummaryProvider.OnDevice)
        assertFalse(PageSummaryChoice.isEnabled(context))
    }

    @Test
    fun everySwitchMovesTheRevisionSoOlderWorkCanTellItIsStale() {
        val before = PageSummaryChoice.revision
        PageSummaryChoice.enable(context, true)
        val on = PageSummaryChoice.revision
        assertNotEquals(before, on)
        PageSummaryChoice.enable(context, false)
        PageSummaryChoice.enable(context, true)
        assertNotEquals(on, PageSummaryChoice.revision)
        PageSummaryChoice.choose(context, PageSummaryProvider.ChatGPT)
        assertEquals(on + 2, PageSummaryChoice.revision)
    }
}
