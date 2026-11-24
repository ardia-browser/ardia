package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LiquidGlassShaderTest {
    private val returned = Regex("half4 lensed = half4\\(([^;]*)\\);").find(LiquidGlassRules.LENS_SHADER)!!.groupValues[1]

    @Test
    fun theLensReturnsEachChannelClampedToTheCoverageItReturns() {
        val channels = returned.split(Regex(",\\s*(?![^()]*\\))")).map(String::trim)
        assertEquals(4, channels.size)
        val coverage = channels[3]
        for (channel in channels.take(3)) assertTrue("$channel is not clamped to $coverage", channel.startsWith("min(") && channel.endsWith(", $coverage)"))
        assertTrue("coverage is the green sample's alpha", Regex("half $coverage = green\\.a;").containsMatchIn(LiquidGlassRules.LENS_SHADER))
        assertTrue("the strip's saturation is applied to what the lens returns", LiquidGlassRules.LENS_SHADER.contains("return saturated(lensed);"))
    }
}
