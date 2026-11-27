package com.ardia.browser

import android.content.res.Configuration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageThemeContextTest {
    @Test
    fun thePagesNightReplacesTheAppsAndKeepsTheDeviceType() {
        val lightWatch = Configuration.UI_MODE_TYPE_WATCH or Configuration.UI_MODE_NIGHT_NO
        assertEquals(Configuration.UI_MODE_TYPE_WATCH or Configuration.UI_MODE_NIGHT_YES, PageThemeContext.withNight(lightWatch, true))
        val darkPhone = Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_YES
        assertEquals(Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_NO, PageThemeContext.withNight(darkPhone, false))
    }

    @Test
    fun anUndefinedTypeBecomesAPhone() {
        assertEquals(Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_YES, PageThemeContext.withNight(0, true))
    }

    @Test
    fun nightIsReadFromTheNightBitsOnly() {
        assertTrue(PageThemeContext.isNight(Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_YES))
        assertFalse(PageThemeContext.isNight(Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_NO))
        assertFalse(PageThemeContext.isNight(Configuration.UI_MODE_TYPE_NORMAL))
    }
}
