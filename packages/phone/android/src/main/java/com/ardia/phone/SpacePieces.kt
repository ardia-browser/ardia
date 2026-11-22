package com.ardia.phone

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.Image
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ardia.browser.BrowserUrl
import com.ardia.design.ArdiaSymbols
import com.ardia.design.ArdiaType
import com.ardia.design.ColorMath
import com.ardia.design.FaviconPixels
import com.ardia.design.HttpFaviconFetcher
import com.ardia.design.LocalArdiaDarkTheme
import com.ardia.design.Palette
import com.ardia.design.ProfileLook
import com.ardia.design.SystemPalette
import com.ardia.design.parseHexColor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal object SpaceRules {
    const val TILES_PER_ROW = 4
    val tileHeight = 52.dp
    val tileRadius = 14.dp
    val tileGap = 8.dp
    val tileIcon = 20.dp
    val badge = 20.dp
    val pageDot = 7.dp
    val pageDotSpacing = 21.dp
    val hitTarget = 44.dp

    private val lightColours = mapOf(
        "red" to 0xFF3B30, "orange" to 0xFF9500, "yellow" to 0xFFCC00, "green" to 0x34C759, "mint" to 0x00C7BE,
        "teal" to 0x30B0C7, "cyan" to 0x32ADE6, "blue" to 0x007AFF, "indigo" to 0x5856D6, "purple" to 0xAF52DE,
        "violet" to 0xAF52DE, "pink" to 0xFF2D55, "brown" to 0xA2845E, "gray" to 0x8E8E93, "grey" to 0x8E8E93,
    )
    private val darkColours = mapOf(
        "red" to 0xFF453A, "orange" to 0xFF9F0A, "yellow" to 0xFFD60A, "green" to 0x30D158, "mint" to 0x63E6E2,
        "teal" to 0x40C8E0, "cyan" to 0x64D2FF, "blue" to 0x0A84FF, "indigo" to 0x5E5CE6, "purple" to 0xBF5AF2,
        "violet" to 0xBF5AF2, "pink" to 0xFF375F, "brown" to 0xAC8E68, "gray" to 0x8E8E93, "grey" to 0x8E8E93,
    )

    fun colourRgb(name: String?, dark: Boolean): Int? {
        val key = name?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (key.startsWith("#")) return key.drop(1).takeIf { it.length == 6 }?.toIntOrNull(16)
        return (if (dark) darkColours else lightColours)[key]
    }

    fun hex(rgb: Int): String = "#%06X".format(rgb and 0xFFFFFF)

    fun colour(name: String?): Map<String, String>? {
        val light = colourRgb(name, dark = false) ?: return null
        val dark = colourRgb(name, dark = true) ?: light
        return mapOf("light" to hex(light), "dark" to hex(dark))
    }

    fun symbol(name: String?): String? = name?.takeIf { it.isNotEmpty() && ArdiaSymbols.named(it) != null }

    fun filled(symbol: String): String = if (symbol.endsWith(".fill") || ArdiaSymbols.named("$symbol.fill") == null) symbol else "$symbol.fill"

    fun initial(name: String): String {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return "•"
        val end = trimmed.offsetByCodePoints(0, 1)
        return trimmed.substring(0, end).uppercase()
    }

    fun emoji(icon: String?): String? {
        if (icon.isNullOrEmpty() || icon.codePointCount(0, icon.length) > 2) return null
        val looksLikeOne = icon.codePoints().anyMatch { it >= 0x1F000 || it in 0x2600..0x27BF || it in 0x2B00..0x2BFF }
        return if (looksLikeOne) icon else null
    }

    fun menuSymbol(name: String, icon: String?): String {
        symbol(icon)?.let { return filled(it) }
        val squared = "${initial(name).lowercase()}.square.fill"
        return if (ArdiaSymbols.named(squared) != null) squared else "square.fill"
    }

    fun tones(color: String?, themeColors: List<String>, themeDarkColors: List<String>?, dark: Boolean, increasedContrast: Boolean): List<Color> {
        val toward = if (dark) Color.Black else Color.White
        val amount = if (dark) (if (increasedContrast) 0.8f else 0.66f) else (if (increasedContrast) 0.9f else 0.8f)
        if (themeColors.isNotEmpty()) {
            val source = if (dark) themeDarkColors ?: themeColors else themeColors
            val colours = source.mapNotNull(::parseHexColor)
            if (colours.isNotEmpty()) {
                val themeAmount = if (dark && themeDarkColors != null) (if (increasedContrast) 0.5f else 0.25f) else amount
                return colours.map { ColorMath.mixEncoded(it, toward, themeAmount) }
            }
        }
        val base = ProfileLook.of(color).swatchColor
        return listOf(ColorMath.mixEncoded(base, toward, amount), ColorMath.mixEncoded(base, toward, amount + if (dark) 0.06f else -0.04f))
    }

    fun tileLabel(title: String, url: String): String = title.ifEmpty { BrowserUrl.rawHost(url) ?: url }

    fun rows(count: Int): List<IntRange> {
        if (count <= 0) return emptyList()
        val columns = maxOf(1, minOf(TILES_PER_ROW, count))
        return (0 until count step columns).map { start -> start until minOf(start + columns, count) }
    }

    fun columns(count: Int): Int = maxOf(1, minOf(TILES_PER_ROW, count))
}

internal object SpaceInk {
    fun headerText(dark: Boolean): Color = if (dark) Color.White.copy(alpha = 0.92f) else Color(0xFF0E0F10).copy(alpha = 0.88f)

    fun badge(dark: Boolean): Color = if (dark) Color(0xFF1C1C1E) else Color.White

    fun badgeInk(dark: Boolean): Color = if (dark) Color.White else Color.Black

    fun pageDot(dark: Boolean): Color = (if (dark) Color.White else Color.Black).copy(alpha = 0.32f)

    fun hairline(dark: Boolean): Color = (if (dark) Color.White else Color.Black).copy(alpha = 0.12f)
}

class PinnedTabItem(val key: String, val title: String, val url: String)

class PinnedTileItem(val key: String, val title: String, val url: String, val icon: String?, val folder: List<PinnedTabItem>?)

@Composable
internal fun Modifier.lookSurface(shape: Shape): Modifier {
    val dark = LocalArdiaDarkTheme.current
    return clip(shape).background(SettingsLook.look.surface.resolve(dark), shape).border(0.5.dp, SpaceInk.hairline(dark), shape)
}

@Composable
internal fun SpaceGlyphFace(name: String, icon: String?, size: Dp = SpaceRules.badge) {
    val dark = LocalArdiaDarkTheme.current
    val symbol = SpaceRules.symbol(icon)?.let(SpaceRules::filled)?.let(ArdiaSymbols::named)
    val emoji = SpaceRules.emoji(icon)
    when {
        symbol != null -> Box(Modifier.size(width = size * 1.25f, height = size), contentAlignment = Alignment.Center) {
            Icon(symbol, null, Modifier.size(size * 0.85f), tint = SpaceInk.badgeInk(dark))
        }
        emoji != null -> Box(Modifier.size(size), contentAlignment = Alignment.Center) { Text(emoji, fontSize = (size.value * 0.8f).sp) }
        else -> Box(Modifier.size(size).background(SpaceInk.badge(dark), CircleShape), contentAlignment = Alignment.Center) {
            Text(SpaceRules.initial(name), fontSize = (size.value * 0.55f).sp, fontWeight = FontWeight.Bold, color = SpaceInk.badgeInk(dark))
        }
    }
}

@Composable
internal fun SpaceTitleFace(name: String, icon: String?, showsChevron: Boolean, modifier: Modifier) {
    val dark = LocalArdiaDarkTheme.current
    Row(
        modifier.heightIn(min = SpaceRules.hitTarget).semantics(mergeDescendants = true) { contentDescription = name },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SpaceGlyphFace(name, icon)
        Text(name, style = ArdiaType.headline, color = SpaceInk.headerText(dark), maxLines = 1)
        if (showsChevron) Icon(ArdiaSymbols.chevronDown, null, Modifier.size(12.dp), tint = SystemPalette.secondaryLabel.resolve(dark))
    }
}

@Composable
internal fun SpacePageDotsFace(count: Int, index: Int, modifier: Modifier) {
    val dark = LocalArdiaDarkTheme.current
    Row(modifier.semantics(mergeDescendants = true) { contentDescription = "Space ${index + 1} of $count" }, horizontalArrangement = Arrangement.spacedBy(SpaceRules.pageDotSpacing - SpaceRules.pageDot)) {
        repeat(maxOf(count, 0)) { dot ->
            val colour by animateColorAsState(if (dot == index) SpaceInk.badgeInk(dark) else SpaceInk.pageDot(dark), tween(200), label = "pageDot")
            Box(Modifier.size(SpaceRules.pageDot).background(colour, CircleShape))
        }
    }
}

@Composable
internal fun GlassCircleFace(symbol: String, label: String, diameter: Dp, modifier: Modifier, onPress: () -> Unit) {
    val dark = LocalArdiaDarkTheme.current
    Box(
        modifier
            .size(diameter)
            .lookSurface(CircleShape)
            .combinedClickable(onClick = onPress)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(SettingsSymbols.vector(symbol), null, Modifier.size(18.dp), tint = SystemPalette.label.resolve(dark))
    }
}

@Composable
internal fun SettingsShortcutsFace(shortcuts: List<Pair<String, String>>, modifier: Modifier, onPress: (String) -> Unit) {
    val dark = LocalArdiaDarkTheme.current
    val large = LocalDensity.current.fontScale >= ACCESSIBILITY_FONT_SCALE
    val button: @Composable (Modifier, Pair<String, String>) -> Unit = { place, (id, title) ->
        Box(
            place
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(percent = 50))
                .background(SystemPalette.secondaryGroupedBackground.resolve(dark))
                .combinedClickable(onClick = { onPress(id) })
                .semantics { role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Text(title, style = ArdiaType.body, fontWeight = FontWeight.Medium, color = SystemPalette.label.resolve(dark))
        }
    }
    if (large) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) { shortcuts.forEach { button(Modifier.fillMaxWidth(), it) } }
    } else {
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(12.dp)) { shortcuts.forEach { button(Modifier.weight(1f), it) } }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun PinnedTilesFace(tiles: List<PinnedTileItem>, modifier: Modifier, onOpen: (String, String) -> Unit) {
    val columns = SpaceRules.columns(tiles.size)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(SpaceRules.tileGap)) {
        for (row in SpaceRules.rows(tiles.size)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(SpaceRules.tileGap)) {
                for (index in row) PinnedTileFace(tiles[index], Modifier.weight(1f), onOpen)
                repeat(columns - (row.last - row.first + 1)) { Spacer(Modifier.weight(1f).height(SpaceRules.tileHeight)) }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PinnedTileFace(tile: PinnedTileItem, modifier: Modifier, onOpen: (String, String) -> Unit) {
    val dark = LocalArdiaDarkTheme.current
    var menu by remember { mutableStateOf(false) }
    val folder = tile.folder?.takeIf { it.isNotEmpty() }
    val label = SpaceRules.tileLabel(tile.title, tile.url)
    val clipboard = LocalContext.current
    Box(
        modifier
            .height(SpaceRules.tileHeight)
            .lookSurface(RoundedCornerShape(SpaceRules.tileRadius))
            .combinedClickable(onClick = { if (folder != null) menu = true else onOpen(tile.url, tile.title) }, onLongClick = { if (folder == null) menu = true })
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        val symbol = SpaceRules.symbol(tile.icon)?.let(ArdiaSymbols::named)
        val emoji = SpaceRules.emoji(tile.icon)
        when {
            folder != null -> Icon(ArdiaSymbols.folderFill, null, Modifier.size(SpaceRules.tileIcon * 0.95f), tint = Palette.formAccent.resolve(dark).copy(alpha = 0.55f))
            symbol != null -> Icon(symbol, null, Modifier.size(SpaceRules.tileIcon * 0.9f), tint = SystemPalette.secondaryLabel.resolve(dark))
            emoji != null -> Text(emoji, fontSize = SpaceRules.tileIcon.value.sp)
            else -> TileFavicon(tile.url, label)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (folder != null) {
                folder.forEach { tab ->
                    DropdownMenuItem(text = { Text(SpaceRules.tileLabel(tab.title, tab.url)) }, onClick = {
                        menu = false
                        onOpen(tab.url, tab.title)
                    })
                }
            } else {
                DropdownMenuItem(text = { Text("Copy Link") }, onClick = {
                    menu = false
                    val manager = clipboard.getSystemService(android.content.ClipboardManager::class.java)
                    manager?.setPrimaryClip(android.content.ClipData.newPlainText(label, tile.url))
                })
                DropdownMenuItem(text = { Text("Share") }, onClick = {
                    menu = false
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, tile.url)
                    clipboard.startActivity(android.content.Intent.createChooser(send, null).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                })
            }
        }
    }
}

@Composable
private fun TileFavicon(url: String, label: String) {
    val dark = LocalArdiaDarkTheme.current
    val side = with(LocalDensity.current) { SpaceRules.tileIcon.roundToPx() * 2 }
    val picture by produceState<ImageBitmap?>(TileFavicons.known(url), url) {
        if (value == null) value = TileFavicons.load(url, side)
    }
    val shown = picture
    if (shown != null) {
        Image(shown, null, Modifier.size(SpaceRules.tileIcon).clip(RoundedCornerShape(4.dp)))
    } else {
        Text(SpaceRules.initial(label), style = ArdiaType.callout, fontWeight = FontWeight.SemiBold, color = SystemPalette.secondaryLabel.resolve(dark))
    }
}

internal object TileFavicons {
    private val fetcher = HttpFaviconFetcher()
    private val cache = object : LinkedHashMap<String, ImageBitmap>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ImageBitmap>?): Boolean = size > 96
    }

    fun known(url: String): ImageBitmap? = synchronized(cache) { cache[url] }

    suspend fun load(url: String, side: Int): ImageBitmap? {
        if (!BrowserUrl.isWeb(url)) return null
        val picture = withContext(Dispatchers.IO) {
            val bytes = fetcher.fetch(url) ?: return@withContext null
            FaviconPixels.decode(bytes, side)?.asImageBitmap()
        } ?: return null
        synchronized(cache) { cache[url] = picture }
        return picture
    }
}

internal fun Modifier.spaceBackdrop(tones: List<Color>, dark: Boolean): Modifier {
    val stops = if (tones.size > 1) tones else tones + tones
    return background(if (dark) Color.Black else Color.White).background(Brush.verticalGradient(stops))
}

private const val ACCESSIBILITY_FONT_SCALE = 1.3f
