package com.ardia.phone

import android.app.WallpaperColors
import android.app.WallpaperManager
import android.content.ComponentCallbacks
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class MaterialSearchAppearanceRecord : Record {
    @Field val dark: Boolean? = null

    @Field val scheme: Map<String, String>? = null
}

internal object MaterialScheme {
    val dynamic: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    fun hex(color: Color): String = String.format("#%06X", color.toArgb() and 0xFFFFFF)

    fun roles(scheme: ColorScheme): Map<String, String> = linkedMapOf(
        "primary" to hex(scheme.primary),
        "onPrimary" to hex(scheme.onPrimary),
        "primaryContainer" to hex(scheme.primaryContainer),
        "onPrimaryContainer" to hex(scheme.onPrimaryContainer),
        "inversePrimary" to hex(scheme.inversePrimary),
        "secondary" to hex(scheme.secondary),
        "onSecondary" to hex(scheme.onSecondary),
        "secondaryContainer" to hex(scheme.secondaryContainer),
        "onSecondaryContainer" to hex(scheme.onSecondaryContainer),
        "tertiary" to hex(scheme.tertiary),
        "onTertiary" to hex(scheme.onTertiary),
        "tertiaryContainer" to hex(scheme.tertiaryContainer),
        "onTertiaryContainer" to hex(scheme.onTertiaryContainer),
        "background" to hex(scheme.background),
        "onBackground" to hex(scheme.onBackground),
        "surface" to hex(scheme.surface),
        "onSurface" to hex(scheme.onSurface),
        "surfaceVariant" to hex(scheme.surfaceVariant),
        "onSurfaceVariant" to hex(scheme.onSurfaceVariant),
        "surfaceTint" to hex(scheme.surfaceTint),
        "surfaceBright" to hex(scheme.surfaceBright),
        "surfaceDim" to hex(scheme.surfaceDim),
        "surfaceContainer" to hex(scheme.surfaceContainer),
        "surfaceContainerHigh" to hex(scheme.surfaceContainerHigh),
        "surfaceContainerHighest" to hex(scheme.surfaceContainerHighest),
        "surfaceContainerLow" to hex(scheme.surfaceContainerLow),
        "surfaceContainerLowest" to hex(scheme.surfaceContainerLowest),
        "inverseSurface" to hex(scheme.inverseSurface),
        "inverseOnSurface" to hex(scheme.inverseOnSurface),
        "error" to hex(scheme.error),
        "onError" to hex(scheme.onError),
        "errorContainer" to hex(scheme.errorContainer),
        "onErrorContainer" to hex(scheme.onErrorContainer),
        "outline" to hex(scheme.outline),
        "outlineVariant" to hex(scheme.outlineVariant),
        "scrim" to hex(scheme.scrim),
    )

    fun of(context: Context): Map<String, Map<String, String>>? {
        if (!dynamic) return null
        return mapOf("light" to roles(dynamicLightColorScheme(context)), "dark" to roles(dynamicDarkColorScheme(context)))
    }

    fun parse(hex: String?): Color? {
        val digits = hex?.removePrefix("#")?.takeIf { it.length == 6 } ?: return null
        return digits.toLongOrNull(16)?.let { Color(0xFF000000L or it) }
    }

    private fun pick(given: Map<String, String>, role: String, base: Color): Color = parse(given[role]) ?: base

    fun withRoles(base: ColorScheme, given: Map<String, String>): ColorScheme = base.copy(
        primary = pick(given, "primary", base.primary),
        onPrimary = pick(given, "onPrimary", base.onPrimary),
        primaryContainer = pick(given, "primaryContainer", base.primaryContainer),
        onPrimaryContainer = pick(given, "onPrimaryContainer", base.onPrimaryContainer),
        inversePrimary = pick(given, "inversePrimary", base.inversePrimary),
        secondary = pick(given, "secondary", base.secondary),
        onSecondary = pick(given, "onSecondary", base.onSecondary),
        secondaryContainer = pick(given, "secondaryContainer", base.secondaryContainer),
        onSecondaryContainer = pick(given, "onSecondaryContainer", base.onSecondaryContainer),
        tertiary = pick(given, "tertiary", base.tertiary),
        onTertiary = pick(given, "onTertiary", base.onTertiary),
        tertiaryContainer = pick(given, "tertiaryContainer", base.tertiaryContainer),
        onTertiaryContainer = pick(given, "onTertiaryContainer", base.onTertiaryContainer),
        background = pick(given, "background", base.background),
        onBackground = pick(given, "onBackground", base.onBackground),
        surface = pick(given, "surface", base.surface),
        onSurface = pick(given, "onSurface", base.onSurface),
        surfaceVariant = pick(given, "surfaceVariant", base.surfaceVariant),
        onSurfaceVariant = pick(given, "onSurfaceVariant", base.onSurfaceVariant),
        surfaceTint = pick(given, "surfaceTint", base.surfaceTint),
        surfaceBright = pick(given, "surfaceBright", base.surfaceBright),
        surfaceDim = pick(given, "surfaceDim", base.surfaceDim),
        surfaceContainer = pick(given, "surfaceContainer", base.surfaceContainer),
        surfaceContainerHigh = pick(given, "surfaceContainerHigh", base.surfaceContainerHigh),
        surfaceContainerHighest = pick(given, "surfaceContainerHighest", base.surfaceContainerHighest),
        surfaceContainerLow = pick(given, "surfaceContainerLow", base.surfaceContainerLow),
        surfaceContainerLowest = pick(given, "surfaceContainerLowest", base.surfaceContainerLowest),
        inverseSurface = pick(given, "inverseSurface", base.inverseSurface),
        inverseOnSurface = pick(given, "inverseOnSurface", base.inverseOnSurface),
        error = pick(given, "error", base.error),
        onError = pick(given, "onError", base.onError),
        errorContainer = pick(given, "errorContainer", base.errorContainer),
        onErrorContainer = pick(given, "onErrorContainer", base.onErrorContainer),
        outline = pick(given, "outline", base.outline),
        outlineVariant = pick(given, "outlineVariant", base.outlineVariant),
        scrim = pick(given, "scrim", base.scrim),
    )

    fun fallback(dark: Boolean): ColorScheme =
        if (dark) withRoles(darkColorScheme(), MaterialFallback.dark) else withRoles(lightColorScheme(), MaterialFallback.light)

    fun colorScheme(context: Context, dark: Boolean, given: Map<String, String>?): ColorScheme {
        val base = when {
            dynamic -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            else -> fallback(dark)
        }
        return if (given.isNullOrEmpty()) base else withRoles(base, given)
    }

    fun followsWallpaper(given: Map<String, String>?, system: ColorScheme): Boolean {
        if (given.isNullOrEmpty()) return true
        return given["primary"].equals(hex(system.primary), ignoreCase = true)
    }

    fun nightOf(configuration: Configuration): Int = configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
}

internal object MaterialFallback {
    val light: Map<String, String> = linkedMapOf(
        "primary" to "#1E6B4F",
        "onPrimary" to "#FFFFFF",
        "primaryContainer" to "#A7F2CF",
        "onPrimaryContainer" to "#005139",
        "inversePrimary" to "#8CD5B4",
        "secondary" to "#4C6358",
        "onSecondary" to "#FFFFFF",
        "secondaryContainer" to "#CFE9DA",
        "onSecondaryContainer" to "#354B41",
        "tertiary" to "#3E6374",
        "onTertiary" to "#FFFFFF",
        "tertiaryContainer" to "#C1E8FC",
        "onTertiaryContainer" to "#254B5B",
        "background" to "#F5FBF5",
        "onBackground" to "#171D1A",
        "surface" to "#F5FBF5",
        "onSurface" to "#171D1A",
        "surfaceVariant" to "#DBE5DE",
        "onSurfaceVariant" to "#404944",
        "surfaceTint" to "#1E6B4F",
        "inverseSurface" to "#2C322E",
        "inverseOnSurface" to "#ECF2ED",
        "error" to "#BA1A1A",
        "onError" to "#FFFFFF",
        "errorContainer" to "#FFDAD6",
        "onErrorContainer" to "#93000A",
        "outline" to "#707973",
        "outlineVariant" to "#BFC9C2",
        "scrim" to "#000000",
        "surfaceBright" to "#F5FBF5",
        "surfaceContainer" to "#EAEFEA",
        "surfaceContainerHigh" to "#E4EAE4",
        "surfaceContainerHighest" to "#DEE4DE",
        "surfaceContainerLow" to "#EFF5EF",
        "surfaceContainerLowest" to "#FFFFFF",
        "surfaceDim" to "#D6DBD6",
    )

    val dark: Map<String, String> = linkedMapOf(
        "primary" to "#8CD5B4",
        "onPrimary" to "#003827",
        "primaryContainer" to "#005139",
        "onPrimaryContainer" to "#A7F2CF",
        "inversePrimary" to "#1E6B4F",
        "secondary" to "#B3CCBE",
        "onSecondary" to "#1F352B",
        "secondaryContainer" to "#354B41",
        "onSecondaryContainer" to "#CFE9DA",
        "tertiary" to "#A6CCDF",
        "onTertiary" to "#083544",
        "tertiaryContainer" to "#254B5B",
        "onTertiaryContainer" to "#C1E8FC",
        "background" to "#0F1512",
        "onBackground" to "#DEE4DE",
        "surface" to "#0F1512",
        "onSurface" to "#DEE4DE",
        "surfaceVariant" to "#404944",
        "onSurfaceVariant" to "#BFC9C2",
        "surfaceTint" to "#8CD5B4",
        "inverseSurface" to "#DEE4DE",
        "inverseOnSurface" to "#2C322E",
        "error" to "#FFB4AB",
        "onError" to "#690005",
        "errorContainer" to "#93000A",
        "onErrorContainer" to "#FFDAD6",
        "outline" to "#8A938D",
        "outlineVariant" to "#404944",
        "scrim" to "#000000",
        "surfaceBright" to "#353B37",
        "surfaceContainer" to "#1B211E",
        "surfaceContainerHigh" to "#252B28",
        "surfaceContainerHighest" to "#303633",
        "surfaceContainerLow" to "#171D1A",
        "surfaceContainerLowest" to "#0A0F0D",
        "surfaceDim" to "#0F1512",
    )
}

internal class SchemeChanges(private val current: () -> Map<String, Map<String, String>>?, private val send: (String) -> Unit) {
    private var last: Map<String, Map<String, String>>? = null
    private var night: Int? = null

    fun read(): Map<String, Map<String, String>>? = current().also { last = it }

    fun check(reason: String) {
        val now = current()
        if (now == last) return
        last = now
        send(reason)
    }

    fun configuration(nightNow: Int) {
        val before = night
        night = nightNow
        if (before != null && before != nightNow) {
            last = current()
            send("night")
            return
        }
        check("wallpaper")
    }
}

class MaterialModule : Module() {
    private val main = Handler(Looper.getMainLooper())
    private var wallpaperListener: WallpaperManager.OnColorsChangedListener? = null
    private var configurationListener: ComponentCallbacks? = null
    private val changes = SchemeChanges({ freshContext()?.let(MaterialScheme::of) }) { reason -> runCatching { sendEvent(CHANGE, mapOf("reason" to reason)) } }

    private fun context(): Context? = appContext.reactContext?.applicationContext

    private fun freshContext(): Context? = appContext.currentActivity ?: context()

    private var watchedContext: Context? = null

    private fun startWatching() {
        val context = context() ?: return
        watchedContext = context
        changes.check("wallpaper")
        if (MaterialScheme.dynamic && wallpaperListener == null) {
            val listener = WallpaperManager.OnColorsChangedListener { _: WallpaperColors?, _: Int ->
                changes.check("wallpaper")
                main.postDelayed({ changes.check("wallpaper") }, SETTLE_TOKEN, PALETTE_SETTLE_MS)
            }
            runCatching { WallpaperManager.getInstance(context).addOnColorsChangedListener(listener, main) }.onSuccess { wallpaperListener = listener }
        }
        if (configurationListener == null) {
            changes.configuration(MaterialScheme.nightOf(context.resources.configuration))
            val listener = object : ComponentCallbacks {
                override fun onConfigurationChanged(configuration: Configuration) {
                    main.post { changes.configuration(MaterialScheme.nightOf(configuration)) }
                }

                @Deprecated("Deprecated in Java")
                override fun onLowMemory() = Unit
            }
            context.registerComponentCallbacks(listener)
            configurationListener = listener
        }
    }

    private fun stopWatching() {
        main.removeCallbacksAndMessages(SETTLE_TOKEN)
        val context = watchedContext ?: return
        watchedContext = null
        wallpaperListener?.let { listener -> runCatching { WallpaperManager.getInstance(context).removeOnColorsChangedListener(listener) } }
        wallpaperListener = null
        configurationListener?.let(context::unregisterComponentCallbacks)
        configurationListener = null
    }

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneMaterial")

        Constants { mapOf("dynamic" to MaterialScheme.dynamic) }

        Events(CHANGE)

        Function("schemes") { changes.read() }

        OnStartObserving { main.post { startWatching() } }

        OnStopObserving { main.post { stopWatching() } }

        OnDestroy { main.post { stopWatching() } }

        View(MaterialSearchBarView::class) {
            Events("onTypedChange", "onSubmit", "onFocusChange", "onSuffixChange", "onClearPress", "onVoicePress", "onIncognitoPress")

            Prop("text") { view: MaterialSearchBarView, text: String? -> view.textProp = text ?: "" }
            Prop("textEventCount") { view: MaterialSearchBarView, count: Int? -> view.textCountProp = count ?: 0 }
            Prop("offer") { view: MaterialSearchBarView, offer: Map<String, Any?>? ->
                view.setOffer(offer?.get("query") as? String, offer?.get("completion") as? String)
            }
            Prop("selectsAllOnFocus") { view: MaterialSearchBarView, value: Boolean? -> view.setSelectsAllOnFocus(value == true) }
            Prop("placeholder") { view: MaterialSearchBarView, text: String? -> view.setPlaceholder(text) }
            Prop("fieldLabel") { view: MaterialSearchBarView, value: String? -> view.setLabel(value) }
            Prop("incognito") { view: MaterialSearchBarView, value: Boolean? -> view.setIncognito(value == true) }
            Prop("showsVoice") { view: MaterialSearchBarView, value: Boolean? -> view.setShowsVoice(value == true) }
            Prop("fieldOnly") { view: MaterialSearchBarView, value: Boolean? -> view.setFieldOnly(value == true) }
            Prop("embedded") { view: MaterialSearchBarView, value: Boolean? -> view.embedded = value == true }
            Prop("appearance") { view: MaterialSearchBarView, value: MaterialSearchAppearanceRecord? ->
                view.dark = value?.dark
                view.scheme = value?.scheme
            }

            OnViewDidUpdateProps { view -> view.propsUpdated() }

            AsyncFunction("focus") { view: MaterialSearchBarView -> view.focusField() }.runOnQueue(Queues.MAIN)

            AsyncFunction("blur") { view: MaterialSearchBarView -> view.blurField() }.runOnQueue(Queues.MAIN)

            AsyncFunction("setText") { view: MaterialSearchBarView, text: String, selectsAll: Boolean? -> view.replace(text, selectsAll == true) }.runOnQueue(Queues.MAIN)
        }
    }

    private companion object {
        const val CHANGE = "onSchemeChange"
        const val PALETTE_SETTLE_MS = 800L
        val SETTLE_TOKEN = Any()
    }
}
