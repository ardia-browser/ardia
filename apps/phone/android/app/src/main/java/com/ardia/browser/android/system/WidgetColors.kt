package com.ardia.browser.android.system

import androidx.compose.ui.graphics.Color
import com.ardia.design.ProfileLook

data class WidgetColors(
    val backdrop: List<Color>,
    val panelTop: Color,
    val panelBottom: Color,
    val panelDiagonal: Boolean,
    val ink: Color,
    val capsule: Color,
    val label: Color,
    val secondaryLabel: Color,
    val accent: Color,
    val monogramFill: Color,
) {
    data class DayNight(val day: WidgetColors, val night: WidgetColors)

    enum class Resolver { Launcher, App }

    companion object {
        const val CAPSULE_SHARE = 0.08f
        const val LIGHT_SOFTENING = 0.72f
        const val DARK_SOFTENING = 0.55f
        const val LAUNCHER_RESOLVES_FROM_SDK = 31
        val INK_ON_LIGHT = Color(0xE60E0F10)

        fun resolver(sdkInt: Int): Resolver = if (sdkInt >= LAUNCHER_RESOLVES_FROM_SDK) Resolver.Launcher else Resolver.App

        fun dayNight(look: ProfileLook, themed: Boolean, softened: Boolean = false): DayNight =
            DayNight(of(look, dark = false, themed = themed, softened = softened), of(look, dark = true, themed = themed, softened = softened))

        fun of(look: ProfileLook, dark: Boolean, themed: Boolean, softened: Boolean = false): WidgetColors {
            val backdrop = look.backdropColors(dark, themed)
            val ink = if (look.inkIsLight(dark, themed)) Color.White else INK_ON_LIGHT
            val fallback = if (dark) Color.Black else Color.White
            val soften = { color: Color -> if (!softened) color else if (dark) blend(color, Color.Black, DARK_SOFTENING) else blend(color, Color.White, LIGHT_SOFTENING) }
            val under = backdrop.lastOrNull() ?: fallback
            return WidgetColors(
                backdrop = backdrop,
                panelTop = soften(backdrop.firstOrNull() ?: fallback),
                panelBottom = soften(under),
                panelDiagonal = look.showsTheme(dark, themed),
                ink = ink,
                capsule = blend(under, ink, CAPSULE_SHARE),
                label = if (dark) Color.White else Color.Black,
                secondaryLabel = if (dark) Color(0x99EBEBF5) else Color(0x993C3C43),
                accent = if (dark) Color(0xFF0A84FF) else Color(0xFF007AFF),
                monogramFill = if (dark) Color(0x29787880) else Color(0x14787880),
            )
        }

        private fun blend(under: Color, over: Color, share: Float): Color = Color(
            red = under.red + (over.red - under.red) * share,
            green = under.green + (over.green - under.green) * share,
            blue = under.blue + (over.blue - under.blue) * share,
        )
    }
}
