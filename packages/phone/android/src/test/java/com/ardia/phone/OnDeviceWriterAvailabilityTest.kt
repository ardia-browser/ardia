package com.ardia.phone

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class OnDeviceWriterAvailabilityTest {
    private fun failure(code: Int) = OnDeviceWriter.Availability.of(GenAiException(IllegalStateException("AICore"), code))

    @Test
    fun aStatusAnswerMapsToWhatThePhoneCanDo() {
        assertEquals(OnDeviceWriter.Availability.Available, OnDeviceWriter.Availability.of(FeatureStatus.AVAILABLE))
        assertEquals(OnDeviceWriter.Availability.Downloading, OnDeviceWriter.Availability.of(FeatureStatus.DOWNLOADABLE))
        assertEquals(OnDeviceWriter.Availability.Downloading, OnDeviceWriter.Availability.of(FeatureStatus.DOWNLOADING))
        assertEquals(OnDeviceWriter.Availability.NotOffered, OnDeviceWriter.Availability.of(FeatureStatus.UNAVAILABLE))
    }

    @Test
    fun anAICoreErrorIsNeverReportedAsAPhoneThatCantRunTheModel() {
        assertEquals(OnDeviceWriter.Availability.NeedsUpdate, failure(GenAiException.ErrorCode.AICORE_INCOMPATIBLE))
        assertEquals(OnDeviceWriter.Availability.NeedsUpdate, failure(GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE))
        assertEquals(OnDeviceWriter.Availability.NeedsSpace, failure(GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE))
        assertEquals(OnDeviceWriter.Availability.Busy, failure(GenAiException.ErrorCode.BUSY))
        assertEquals(OnDeviceWriter.Availability.Busy, failure(GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED))
        assertEquals(OnDeviceWriter.Availability.Busy, failure(GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED))
        assertEquals(OnDeviceWriter.Availability.NotOffered, failure(GenAiException.ErrorCode.NOT_AVAILABLE))
        assertEquals(OnDeviceWriter.Availability.Failed, failure(GenAiException.ErrorCode.UNKNOWN))
        assertEquals(OnDeviceWriter.Availability.Failed, OnDeviceWriter.Availability.of(IllegalStateException("binder died")))
    }

    @Test
    fun everyMissingModelExplainsItselfAndIsCounted() {
        for (availability in OnDeviceWriter.Availability.entries.filter { it != OnDeviceWriter.Availability.Available }) {
            assertFalse(availability.reason.isNullOrBlank())
            assertFalse(availability.telemetry.isNullOrBlank())
            assertFalse(availability.excerptsNote.contains("can’t run"))
        }
    }
}
