package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppReleaseInfoTest {
    @Test
    fun theReleaseHasTheShapeIPhoneGivesTheVersionLabel() {
        val release = AppReleaseInfo.of(RuntimeEnvironment.getApplication())
        assertEquals(setOf("releaseVersion", "build", "receiptName"), release.keys)
        assertEquals("a library build carries no release version, so the label reads Ardia Dev", "", release["releaseVersion"])
        assertNull("no store receipt on Android", release["receiptName"])
        assertEquals(true, (release["build"] as String).toLongOrNull() != null)
    }
}
