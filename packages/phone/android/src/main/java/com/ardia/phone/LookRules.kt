package com.ardia.phone

import com.ardia.design.DeckBackdropStyle
import com.ardia.design.FrostedStyle
import com.ardia.design.LookFrosting
import com.ardia.design.ProfileBackdropStyle
import com.ardia.design.ProfileLook
import com.ardia.design.TabsBackdropMotion
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

object LookRules {
    fun frost(variant: String?, look: ProfileLook?): FrostedStyle = when (variant) {
        "sheet" -> look?.let(LookFrosting::sheet) ?: FrostedStyle.sheet
        "glass" -> FrostedStyle.glass
        "thin" -> FrostedStyle.thin
        else -> look?.let(LookFrosting::bar) ?: FrostedStyle.bar
    }

    fun blobSide(width: Float, height: Float): Float = max(width, height) * DeckBackdropStyle.BLOB_SIDE_SHARE

    fun blobRadius(width: Float, height: Float): Float = max(MIN_BLOB_RADIUS, blobSide(width, height) / 2f)

    private const val MIN_BLOB_RADIUS = 1f

    const val BLOB_STEP_SHARE = 0.01f
    const val FADE_SCENE_MILLIS = 400L
    const val FADE_FRAME_MILLIS = 75L
    const val EVERY_FRAME = -1
    const val PACED = 0
    private const val MIN_PACE_MILLIS = 16L
    private const val MAX_PACE_MILLIS = 200L

    fun blobPaceMillis(width: Float, height: Float): Long {
        val side = blobSide(width, height)
        var fastest = 0f
        for (index in TabsBackdropMotion.loopsMillis.indices) {
            val dx = (0.5f - TabsBackdropMotion.anchors[index * 2]) * side
            val dy = (0.5f - TabsBackdropMotion.anchors[index * 2 + 1]) * side
            val speed = kotlin.math.hypot(dx, dy) * (2f * PI.toFloat()) / TabsBackdropMotion.loopsMillis[index]
            if (speed > fastest) fastest = speed
        }
        if (fastest <= 0f) return MAX_PACE_MILLIS
        return (blobRadius(width, height) * BLOB_STEP_SHARE / fastest).toLong().coerceIn(MIN_PACE_MILLIS, MAX_PACE_MILLIS)
    }

    const val QUIET_BEFORE_MOVING_MILLIS = 1000L

    fun othersMovedRecently(lastOthersDrew: Long, now: Long): Boolean =
        lastOthersDrew > 0L && now - lastOthersDrew in 0 until QUIET_BEFORE_MOVING_MILLIS

    fun nextBlobFrameMillis(rate: Int, width: Float, height: Float): Long = when {
        rate == EVERY_FRAME -> 0L
        rate > 0 -> 1000L / rate
        else -> blobPaceMillis(width, height)
    }

    fun blobCenterInto(index: Int, angle: Float, width: Float, height: Float, out: FloatArray) {
        val side = blobSide(width, height)
        val dx = (0.5f - TabsBackdropMotion.anchors[index * 2]) * side
        val dy = (0.5f - TabsBackdropMotion.anchors[index * 2 + 1]) * side
        val pivotX = width * TabsBackdropMotion.placements[index * 2]
        val pivotY = height * TabsBackdropMotion.placements[index * 2 + 1]
        val cosine = cos(angle)
        val sine = sin(angle)
        out[0] = pivotX + dx * cosine - dy * sine
        out[1] = pivotY + dx * sine + dy * cosine
    }

    fun blobCenter(index: Int, angle: Float, width: Float, height: Float): Pair<Float, Float> {
        val side = blobSide(width, height)
        val dx = (0.5f - TabsBackdropMotion.anchors[index * 2]) * side
        val dy = (0.5f - TabsBackdropMotion.anchors[index * 2 + 1]) * side
        val pivotX = width * TabsBackdropMotion.placements[index * 2]
        val pivotY = height * TabsBackdropMotion.placements[index * 2 + 1]
        return (pivotX + dx * cos(angle) - dy * sin(angle)) to (pivotY + dx * sin(angle) + dy * cos(angle))
    }

    const val INCOGNITO = "incognito"

    fun look(color: String?, themeColors: List<String>?, darkThemeColors: List<String>?): ProfileLook =
        if (color == INCOGNITO) ProfileLook.incognito else ProfileLook.of(color, themeColors.orEmpty(), darkThemeColors)

    fun lookOrNull(color: String?, themeColors: List<String>?, darkThemeColors: List<String>?): ProfileLook? =
        if (color == null && themeColors.isNullOrEmpty() && darkThemeColors.isNullOrEmpty()) null else look(color, themeColors, darkThemeColors)

    fun dark(requested: Boolean?, system: Boolean, look: ProfileLook?): Boolean = (requested ?: system) || look?.isAlwaysDark == true

    fun fadeMask(): Pair<FloatArray, FloatArray> =
        ProfileBackdropStyle.fadeStops.map { it.first }.toFloatArray() to ProfileBackdropStyle.fadeStops.map { it.second }.toFloatArray()
}
