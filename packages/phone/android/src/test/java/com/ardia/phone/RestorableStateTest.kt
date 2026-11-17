package com.ardia.phone

import android.os.Bundle
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RestorableStateTest {
    @After
    fun forget() = RestorableState.forgetForTests()

    @Test
    fun aValueSetBeforeTheActivityIsSavedComesBackAfterTheProcessIsRecreated() {
        RestorableState.set("onboarding.step", "3")
        RestorableState.set("gone", "x")
        RestorableState.set("gone", null)
        val saved = Bundle().also(RestorableState::save)
        RestorableState.forgetForTests()
        assertNull(RestorableState.get("onboarding.step"))
        RestorableState.restore(saved)
        assertEquals("3", RestorableState.get("onboarding.step"))
        assertNull(RestorableState.get("gone"))
    }

    @Test
    fun aRecreationInTheSameProcessKeepsWhatWasSetSinceTheSave() {
        RestorableState.set("onboarding.step", "2")
        val saved = Bundle().also(RestorableState::save)
        RestorableState.set("onboarding.step", "4")
        RestorableState.restore(saved)
        assertEquals("4", RestorableState.get("onboarding.step"))
        RestorableState.restore(null)
        assertEquals("4", RestorableState.get("onboarding.step"))
    }
}
