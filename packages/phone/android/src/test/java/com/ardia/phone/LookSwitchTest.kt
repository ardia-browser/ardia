package com.ardia.phone

import android.content.Context
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LookSwitchTest {
    private val app: Context = RuntimeEnvironment.getApplication()

    @After
    fun reset() = LookSwitch.forgetForTests()

    @Test
    fun turningTheLookOffLastsAcrossALaunchInALabBuildOnly() {
        assertFalse(LookSwitch.isOff(app, lab = true))
        LookSwitch.set(app, off = true, lab = true)
        LookSwitch.forgetForTests()
        assertTrue(LookSwitch.isOff(app, lab = true))
        assertFalse("a store build never reads the switch", LookSwitch.isOff(app, lab = false))
        assertThrows(IllegalStateException::class.java) { LookSwitch.set(app, off = false, lab = false) }
        LookSwitch.set(app, off = false, lab = true)
        LookSwitch.forgetForTests()
        assertFalse(LookSwitch.isOff(app, lab = true))
    }

    @Test
    fun withTheLookOffEachViewDrawsOneFlatColour() {
        val look = com.ardia.design.ProfileLook.of("plum")
        assertEquals(look.deckBase(false).first(), LookSwitch.flatDeck(look, dark = false))
        assertEquals(look.backdropColors(true, true).first(), LookSwitch.flatBackdrop(look, dark = true, themed = true))
    }
}
