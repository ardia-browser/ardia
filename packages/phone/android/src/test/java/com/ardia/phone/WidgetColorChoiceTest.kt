package com.ardia.phone

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WidgetColorChoiceTest {
    private val app = RuntimeEnvironment.getApplication()

    @After
    fun forget() = WidgetColorChoice.forgetForTests()

    @Test
    fun theWidgetsFollowTheChosenColourAndRememberItAcrossLaunches() {
        assertNull("no choice: the profile's own colour", WidgetColorChoice.flow(app).value)
        WidgetColorChoice.set(app, "green")
        assertEquals("green", WidgetColorChoice.flow(app).value)
        WidgetColorChoice.forgetForTests()
        assertEquals("a relaunch reads it back", "green", WidgetColorChoice.flow(app).value)
        WidgetColorChoice.set(app, null)
        assertNull(WidgetColorChoice.flow(app).value)
        WidgetColorChoice.set(app, " ")
        assertNull(WidgetColorChoice.flow(app).value)
    }
}
