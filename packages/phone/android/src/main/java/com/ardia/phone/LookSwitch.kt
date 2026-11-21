package com.ardia.phone

import android.content.Context
import androidx.compose.ui.graphics.Color
import com.ardia.design.ProfileLook

object LookSwitch {
    private const val PREFERENCES = "ardia-lab"
    private const val KEY_OFF = "look.off"
    private const val KEY_BLOB_RATE = "look.blobFramesPerSecond"
    private const val KEY_BLUR_OVER_BACKDROP = "look.blurOverBackdrop"
    private const val KEY_BACKDROP_DRAW = "look.backdropDraw"
    private const val KEY_DECK_LAYERS = "look.deckLayers"

    @Volatile
    private var knownDeckLayers: Boolean? = null

    fun deckLayers(context: Context, lab: Boolean = PhoneLab.isOn): Boolean {
        if (!lab) return true
        return knownDeckLayers ?: (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(KEY_DECK_LAYERS, true).also { knownDeckLayers = it }
    }

    fun setDeckLayers(context: Context, on: Boolean, lab: Boolean = PhoneLab.isOn) {
        check(lab) { "holding the resting deck on layers is a lab switch" }
        (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(KEY_DECK_LAYERS, on).commit()
        knownDeckLayers = on
    }

    @Volatile
    private var knownBlurOverBackdrop: Boolean? = null

    fun blurOverBackdrop(context: Context, lab: Boolean = PhoneLab.isOn): Boolean {
        if (!lab) return false
        return knownBlurOverBackdrop ?: (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(KEY_BLUR_OVER_BACKDROP, false).also { knownBlurOverBackdrop = it }
    }

    fun setBlurOverBackdrop(context: Context, blur: Boolean, lab: Boolean = PhoneLab.isOn) {
        check(lab) { "blurring frosts over the backdrop is a lab switch" }
        (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(KEY_BLUR_OVER_BACKDROP, blur).commit()
        knownBlurOverBackdrop = blur
    }

    enum class BackdropDraw(val label: String) {
        Small("a small image scaled up"),
        SmallNoGrain("a small image scaled up, without the grain"),
        Full("full size, as Compose draws it"),
        Flat("a flat colour at the blobs' pace, to measure what redrawing the rest costs"),
    }

    @Volatile
    private var knownBackdropDraw: BackdropDraw? = null

    fun backdropDraw(context: Context, lab: Boolean = PhoneLab.isOn): BackdropDraw {
        if (!lab) return BackdropDraw.Small
        return knownBackdropDraw ?: (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY_BACKDROP_DRAW, null)
            .let { stored -> BackdropDraw.entries.firstOrNull { it.name == stored } ?: BackdropDraw.Small }
            .also { knownBackdropDraw = it }
    }

    fun setBackdropDraw(context: Context, draw: BackdropDraw, lab: Boolean = PhoneLab.isOn) {
        check(lab) { "how the backdrop draws is a lab switch" }
        (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(KEY_BACKDROP_DRAW, draw.name).commit()
        knownBackdropDraw = draw
    }

    @Volatile
    private var known: Boolean? = null

    fun isOff(context: Context, lab: Boolean = PhoneLab.isOn): Boolean {
        if (!lab) return false
        return known ?: (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(KEY_OFF, false).also { known = it }
    }

    fun set(context: Context, off: Boolean, lab: Boolean = PhoneLab.isOn) {
        check(lab) { "turning the look off is a lab switch" }
        (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(KEY_OFF, off).commit()
        known = off
    }

    @Volatile
    private var knownRate: Int? = null

    fun blobFramesPerSecond(context: Context, lab: Boolean = PhoneLab.isOn): Int {
        if (!lab) return 0
        return knownRate ?: (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getInt(KEY_BLOB_RATE, 0).also { knownRate = it }
    }

    fun setBlobFramesPerSecond(context: Context, rate: Int, lab: Boolean = PhoneLab.isOn) {
        check(lab) { "the blob frame rate is a lab switch" }
        val kept = rate.coerceIn(LookRules.EVERY_FRAME, 120)
        (context.applicationContext ?: context).getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putInt(KEY_BLOB_RATE, kept).commit()
        knownRate = kept
    }

    fun flatDeck(look: ProfileLook, dark: Boolean): Color = look.deckBase(dark).firstOrNull() ?: if (dark) Color.Black else Color.White

    fun flatBackdrop(look: ProfileLook, dark: Boolean, themed: Boolean): Color = look.backdropColors(dark, themed).firstOrNull() ?: if (dark) Color.Black else Color.White

    internal fun forgetForTests() {
        known = null
        knownRate = null
        knownBlurOverBackdrop = null
        knownBackdropDraw = null
        knownDeckLayers = null
    }
}
