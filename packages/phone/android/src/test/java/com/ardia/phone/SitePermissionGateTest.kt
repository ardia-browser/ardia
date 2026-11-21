package com.ardia.phone

import android.Manifest
import com.ardia.browser.SitePermission
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SitePermissionGateTest {
    @Test
    fun aSiteIsAskedOnlyOnceAndroidHoldsWhatItWants() {
        assertTrue(SitePermissionGate.granted(SitePermission.Camera, mapOf(Manifest.permission.CAMERA to true)))
        assertFalse(SitePermissionGate.granted(SitePermission.Camera, mapOf(Manifest.permission.CAMERA to false)))
        assertFalse("camera and microphone need both", SitePermissionGate.granted(SitePermission.CameraAndMicrophone, mapOf(Manifest.permission.CAMERA to true, Manifest.permission.RECORD_AUDIO to false)))
        assertTrue(SitePermissionGate.granted(SitePermission.CameraAndMicrophone, mapOf(Manifest.permission.CAMERA to true, Manifest.permission.RECORD_AUDIO to true)))
        assertTrue("approximate location is enough, as Compose takes it", SitePermissionGate.granted(SitePermission.Location, mapOf(Manifest.permission.ACCESS_FINE_LOCATION to false, Manifest.permission.ACCESS_COARSE_LOCATION to true)))
        assertFalse(SitePermissionGate.granted(SitePermission.Location, emptyMap()))
    }
}
