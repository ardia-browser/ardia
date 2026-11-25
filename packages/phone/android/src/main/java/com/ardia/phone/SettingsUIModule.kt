package com.ardia.phone

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import com.ardia.design.AppIconPreview
import com.ardia.design.ArdiaSymbols
import com.ardia.design.ArdiaType
import com.ardia.design.ColorSwatch
import com.ardia.design.LocalArdiaDarkTheme
import com.ardia.design.Motion
import com.ardia.design.Palette
import com.ardia.design.ProfileLook
import com.ardia.design.SettingsHero
import com.ardia.design.SettingsIconTile
import com.ardia.design.SettingsRowLabel
import com.ardia.design.SettingsTile
import com.ardia.design.SettingsTint
import com.ardia.design.SetupStepProgress
import com.ardia.design.SetupStepRow
import com.ardia.design.SystemPalette
import com.ardia.design.profileBackdrop
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ComposeProps
import expo.modules.kotlin.views.FunctionalComposableScope
import expo.modules.kotlin.views.OptimizedComposeProps
import expo.modules.ui.ExpoUIView
import expo.modules.ui.ModifierList
import expo.modules.ui.ModifierRegistry
import expo.modules.ui.ModifierType

internal object SettingsLook {
    var look by mutableStateOf(ProfileLook.plum)
    var usesGlass by mutableStateOf(true)
}

internal object SettingsTints {
    private val named: Map<String, Color> = mapOf(
        "neutral" to SettingsTint.neutral,
        "red" to SettingsTint.red,
        "orange" to SettingsTint.orange,
        "yellow" to SettingsTint.yellow,
        "blue" to SettingsTint.blue,
        "deepBlue" to SettingsTint.deepBlue,
        "purple" to SettingsTint.purple,
        "green" to SettingsTint.green,
        "sync" to SettingsTint.sync,
        "ads" to SettingsTint.ads,
        "trackers" to SettingsTint.trackers,
        "cookies" to SettingsTint.cookies,
        "search" to SettingsTint.search,
        "archive" to SettingsTint.archive,
        "keyboard" to SettingsTint.keyboard,
        "swipe" to SettingsTint.swipe,
        "nightShade" to SettingsTint.nightShade,
        "appLinks" to SettingsTint.appLinks,
        "bottomBar" to SettingsTint.bottomBar,
        "defaultBrowser" to SettingsTint.defaultBrowser,
        "clearData" to SettingsTint.clearData,
        "export" to SettingsTint.export,
        "onboarding" to SettingsTint.onboarding,
    )

    val names: Set<String> get() = named.keys + SWATCH

    fun color(name: String, look: ProfileLook): Color = if (name == SWATCH) look.swatchColor else named[name] ?: SettingsTint.neutral

    const val SWATCH = "swatch"
}

internal object SettingsSteps {
    fun progress(name: String): SetupStepProgress = when (name) {
        "done" -> SetupStepProgress.Done
        "current" -> SetupStepProgress.Current
        else -> SetupStepProgress.Upcoming
    }
}

@OptimizedComposeProps
data class SettingsIconTileProps(val systemImage: String = "gearshape", val tint: String = "neutral", val baseSide: Double? = null, val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class SettingsRowLabelProps(val title: String = "", val systemImage: String = "gearshape", val tint: String = "neutral", val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class SettingsHeroContentProps(val title: String = "", val subtitle: String = "", val systemImage: String = "gearshape", val tint: String = "neutral", val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class SetupStepRowProps(val number: Int = 1, val title: String = "", val detail: String = "", val progress: String = "upcoming", val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class ColorSwatchProps(val preset: String = "plum", val isSelected: Boolean = false, val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class CheckmarkLabelProps(val title: String = "", val isChecked: Boolean = false, val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class AppIconPreviewProps(val side: Double = 29.0, val modifiers: ModifierList = emptyList()) : ComposeProps

class SettingsShortcutRecord : Record {
    @Field val id: String = ""

    @Field val title: String = ""
}

class PinnedTabRecord : Record {
    @Field val key: String = ""

    @Field val title: String = ""

    @Field val url: String = ""
}

class PinnedTileRecord : Record {
    @Field val key: String = ""

    @Field val title: String = ""

    @Field val url: String = ""

    @Field val icon: String? = null

    @Field val folder: List<PinnedTabRecord>? = null

    val item: PinnedTileItem
        get() = PinnedTileItem(key, title, url, icon, folder?.map { PinnedTabItem(it.key.ifEmpty { it.url }, it.title, it.url) })
}

class ShortcutPressEvent(@Field val id: String = "") : Record

class TileOpenEvent(@Field val url: String = "", @Field val title: String = "") : Record

class PresentedChangeEvent(@Field val isPresented: Boolean = false) : Record

class TextChangeEvent(@Field val text: String = "") : Record

@OptimizedComposeProps
data class SettingsShortcutsProps(val shortcuts: List<SettingsShortcutRecord> = emptyList(), val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class SpaceTitleProps(
    val name: String = "",
    val icon: String? = null,
    val color: String? = null,
    val themeColors: List<String> = emptyList(),
    val themeDarkColors: List<String>? = null,
    val showsChevron: Boolean = false,
    val modifiers: ModifierList = emptyList(),
) : ComposeProps

@OptimizedComposeProps
data class GlassCircleButtonProps(val symbol: String = "xmark", val label: String = "", val diameter: Double = 44.0, val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class SpacePageDotsProps(val count: Int = 1, val index: Int = 0, val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class PinnedTilesProps(val tiles: List<PinnedTileRecord> = emptyList(), val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class FullScreenCoverProps(val isPresented: Boolean = false, val modifiers: ModifierList = emptyList()) : ComposeProps

@OptimizedComposeProps
data class FilterTextEditorProps(val text: String = "", val modifiers: ModifierList = emptyList()) : ComposeProps

@Composable
private fun FilterTextEditorFace(text: String, modifier: Modifier, onChange: (String) -> Unit) {
    val dark = isSystemInDarkTheme()
    var shown by remember { mutableStateOf(text) }
    LaunchedEffect(text) { if (text != shown) shown = text }
    BasicTextField(
        value = shown,
        onValueChange = { value ->
            shown = value
            if (value != text) onChange(value)
        },
        textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 16.sp, lineHeight = 21.sp, color = SystemPalette.label.resolve(dark)),
        cursorBrush = SolidColor(Palette.formAccent.resolve(dark)),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii),
        modifier = modifier.background(if (dark) Color.Black else Color.White).padding(horizontal = 12.dp),
    )
}

@Composable
private fun Themed(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalArdiaDarkTheme provides isSystemInDarkTheme(), content = content)
}

@Composable
private fun FunctionalComposableScope.applied(modifiers: ModifierList): Modifier =
    ModifierRegistry.applyModifiers(modifiers, appContext, composableScope, globalEventDispatcher)

@Composable
private fun CheckmarkLabel(title: String, isChecked: Boolean, modifier: Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = ArdiaType.body, color = SystemPalette.label.current, modifier = Modifier.weight(1f))
        if (isChecked) Icon(ArdiaSymbols.checkmark, null, Modifier.size(18.dp), tint = Palette.formAccent.current) else Spacer(Modifier.size(18.dp))
    }
}

@Composable
private fun AppIcon(side: Double, modifier: Modifier) {
    val context = LocalContext.current
    val pixels = with(LocalDensity.current) { side.dp.roundToPx().coerceAtLeast(1) * 2 }
    val painter = remember(pixels) {
        BitmapPainter(context.packageManager.getApplicationIcon(context.packageName).toBitmap(pixels, pixels).asImageBitmap())
    }
    AppIconPreview(painter, modifier, side = side.dp)
}

internal object SettingsSurfaces {
    fun shape(name: String, cornerRadius: Double): Shape = when (name) {
        "circle" -> CircleShape
        "rounded" -> RoundedCornerShape(cornerRadius.dp)
        else -> RoundedCornerShape(percent = 50)
    }
}

internal object SettingsUIModifiers {
    val names = listOf("ardia.navigationBarBackButtonHidden", "ardia.minListRowHeight", "ardia.spaceBackdrop", "ardia.settingsChrome", "ardia.settingsPage", "ardia.chromeSurface", "ardia.settingsSwitchStyle", "ardia.pressableStyle", "ardia.legibleInk", "ardia.profileLook", "ardia.contentMargins")

    private fun ModifierType.text(key: String): String? = runCatching { get(key)?.takeUnless { it.isNull }?.asString() }.getOrNull()

    private fun ModifierType.number(key: String): Double? = runCatching { get(key)?.takeUnless { it.isNull }?.asDouble() }.getOrNull()

    private fun ModifierType.flag(key: String): Boolean? = runCatching { get(key)?.takeUnless { it.isNull }?.asBoolean() }.getOrNull()

    private fun ModifierType.texts(key: String): List<String>? = runCatching {
        get(key)?.takeUnless { it.isNull }?.asArray()?.let { array -> (0 until array.size()).mapNotNull { array.getString(it) } }
    }.getOrNull()

    fun register() {
        ModifierRegistry.register("ardia.navigationBarBackButtonHidden") { _, _, _, _ -> Modifier }
        ModifierRegistry.register("ardia.minListRowHeight") { _, _, _, _ -> Modifier }
        ModifierRegistry.register("ardia.spaceBackdrop") { params, _, _, _ ->
            val dark = isSystemInDarkTheme()
            Modifier.spaceBackdrop(SpaceRules.tones(params.text("color"), params.texts("themeColors").orEmpty(), params.texts("themeDarkColors"), dark, increasedContrast = false), dark)
        }
        ModifierRegistry.register("ardia.settingsChrome") { _, _, _, _ ->
            val dark = isSystemInDarkTheme()
            Modifier.profileBackdrop(SettingsLook.look, dark)
        }
        ModifierRegistry.register("ardia.settingsPage") { _, _, _, _ -> Modifier }
        ModifierRegistry.register("ardia.chromeSurface") { params, _, _, _ ->
            val shape = SettingsSurfaces.shape(params.text("shape") ?: "capsule", params.number("cornerRadius") ?: 0.0)
            val dark = isSystemInDarkTheme()
            val look = SettingsLook.look
            val fill = if (params.flag("tinted") == true) look.swatchColor else look.surface.resolve(dark)
            val stroke = (if (dark) Color.White else Color.Black).copy(alpha = 0.12f)
            Modifier.clip(shape).background(fill, shape).border(0.5.dp, stroke, shape)
        }
        ModifierRegistry.register("ardia.settingsSwitchStyle") { _, _, _, _ -> Modifier }
        ModifierRegistry.register("ardia.pressableStyle") { _, _, _, _ ->
            var pressed by remember { mutableStateOf(false) }
            val scale by animateFloatAsState(if (pressed) 0.94f else 1f, Motion.press.spec(), label = "pressable")
            Modifier
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            pressed = event.changes.any { it.pressed }
                        }
                    }
                }
        }
        ModifierRegistry.register("ardia.legibleInk") { _, _, _, _ -> Modifier }
        ModifierRegistry.register("ardia.contentMargins") { _, _, _, _ -> Modifier }
        ModifierRegistry.register("ardia.profileLook") { params, _, _, _ ->
            val look = ProfileLook.of(params.text("color"), params.texts("themeColors").orEmpty(), params.texts("darkThemeColors"))
            val glass = params.flag("usesGlass") ?: true
            SideEffect {
                if (SettingsLook.look != look) SettingsLook.look = look
                SettingsLook.usesGlass = glass
            }
            Modifier
        }
    }

    fun unregister() = names.forEach(ModifierRegistry::unregister)
}

class SettingsUIModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneSettingsUI")

        OnCreate { SettingsUIModifiers.register() }

        OnDestroy { SettingsUIModifiers.unregister() }

        ExpoUIView<SettingsIconTileProps>("SettingsIconTileView") {
            Content { props ->
                Themed {
                    SettingsIconTile(SettingsSymbols.vector(props.systemImage), SettingsTints.color(props.tint, SettingsLook.look), applied(props.modifiers), baseSide = props.baseSide?.dp ?: SettingsTile.side)
                }
            }
        }

        ExpoUIView<SettingsRowLabelProps>("SettingsRowLabelView") {
            Content { props ->
                Themed { SettingsRowLabel(props.title, SettingsSymbols.vector(props.systemImage), SettingsTints.color(props.tint, SettingsLook.look), applied(props.modifiers)) }
            }
        }

        ExpoUIView<SettingsHeroContentProps>("SettingsHeroContentView") {
            Content { props ->
                Themed {
                    SettingsHero(props.title, props.subtitle, SettingsSymbols.vector(props.systemImage), SettingsTints.color(props.tint, SettingsLook.look), applied(props.modifiers)) {
                        Children(composableScope)
                    }
                }
            }
        }

        ExpoUIView<SetupStepRowProps>("SetupStepRowView") {
            Content { props ->
                Themed {
                    SetupStepRow(props.number, props.title, props.detail, SettingsSteps.progress(props.progress), applied(props.modifiers)) {
                        Children(composableScope)
                    }
                }
            }
        }

        ExpoUIView<ColorSwatchProps>("ColorSwatchView") {
            Content { props ->
                Themed {
                    val preset = ProfileLook.Preset.fromKey(props.preset) ?: ProfileLook.Preset.Plum
                    ColorSwatch(ProfileLook.of(preset).swatchColor, props.isSelected, applied(props.modifiers))
                }
            }
        }

        ExpoUIView<CheckmarkLabelProps>("CheckmarkLabelView") {
            Content { props ->
                Themed { CheckmarkLabel(props.title, props.isChecked, applied(props.modifiers)) }
            }
        }

        ExpoUIView<AppIconPreviewProps>("AppIconPreviewView") {
            Content { props ->
                Themed { AppIcon(props.side, applied(props.modifiers)) }
            }
        }

        ExpoUIView<SettingsShortcutsProps>("SettingsShortcutsView") {
            val onShortcutPress by Event<ShortcutPressEvent>()
            Content { props ->
                Themed { SettingsShortcutsFace(props.shortcuts.map { it.id to it.title }, applied(props.modifiers)) { onShortcutPress(ShortcutPressEvent(it)) } }
            }
        }

        ExpoUIView<SpaceTitleProps>("SpaceTitleView") {
            Content { props ->
                Themed { SpaceTitleFace(props.name, props.icon, props.showsChevron, applied(props.modifiers)) }
            }
        }

        ExpoUIView<GlassCircleButtonProps>("GlassCircleButtonView") {
            val onButtonPress by Event<Unit>()
            Content { props ->
                Themed { GlassCircleFace(props.symbol, props.label, props.diameter.dp, applied(props.modifiers)) { onButtonPress(Unit) } }
            }
        }

        ExpoUIView<SpacePageDotsProps>("SpacePageDotsView") {
            Content { props ->
                Themed { SpacePageDotsFace(props.count, props.index, applied(props.modifiers)) }
            }
        }

        ExpoUIView<PinnedTilesProps>("PinnedTilesView") {
            val onTileOpen by Event<TileOpenEvent>()
            Content { props ->
                Themed { PinnedTilesFace(props.tiles.map { it.item }, applied(props.modifiers)) { url, title -> onTileOpen(TileOpenEvent(url, title)) } }
            }
        }

        ExpoUIView<FullScreenCoverProps>("FullScreenCoverView") {
            val onIsPresentedChange by Event<PresentedChangeEvent>()
            Content { props ->
                if (props.isPresented) {
                    Dialog(onDismissRequest = { onIsPresentedChange(PresentedChangeEvent(false)) }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
                        Themed {
                            Box(applied(props.modifiers).fillMaxSize().background(if (isSystemInDarkTheme()) Color.Black else Color.White)) { Children(composableScope) }
                        }
                    }
                }
            }
        }

        ExpoUIView<FilterTextEditorProps>("FilterTextEditorView") {
            val onTextChange by Event<TextChangeEvent>()
            Content { props ->
                Themed { FilterTextEditorFace(props.text, applied(props.modifiers)) { onTextChange(TextChangeEvent(it)) } }
            }
        }

        Function("spaceMenuSymbol") { name: String, icon: String? -> SpaceRules.menuSymbol(name, icon) }

        Function("spaceSymbol") { icon: String? -> SpaceRules.symbol(icon) }

        Function("spaceColor") { name: String? -> SpaceRules.colour(name) }
    }
}
