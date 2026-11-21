package com.ardia.browser.android.system

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.currentState
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.layout.ContentScale
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.ardia.appmodel.SystemLink
import com.ardia.browser.android.R
import com.ardia.browser.android.SystemIntents
import com.ardia.design.Monogram
import com.ardia.design.ProfileLook

object ArdiaWidgets {
    internal val REVISION = longPreferencesKey("ardia.widget.revision")

    suspend fun refreshSearch(context: Context) = refresh(context, SearchWidget(), SearchWidget::class.java)

    suspend fun refreshMacTabs(context: Context) = refresh(context, MacTabsWidget(), MacTabsWidget::class.java)

    private suspend fun refresh(context: Context, widget: GlanceAppWidget, kind: Class<out GlanceAppWidget>) {
        val ids = runCatching { GlanceAppWidgetManager(context).getGlanceIds(kind) }.getOrDefault(emptyList())
        for (id in ids) {
            runCatching {
                updateAppWidgetState(context, id) { it[REVISION] = (it[REVISION] ?: 0L) + 1L }
                widget.update(context, id)
            }
        }
    }

    fun isDark(context: Context): Boolean =
        context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    fun open(context: Context, link: SystemLink): Action = actionStartActivity(SystemIntents.main(context, link))

    fun open(context: Context, uri: String): Action = actionStartActivity(SystemIntents.main(context, uri))

    fun both(colors: WidgetColors.DayNight, pick: (WidgetColors) -> Color): ColorProvider =
        androidx.glance.color.ColorProvider(day = pick(colors.day), night = pick(colors.night))

    fun logUpdate(context: Context, widget: String, look: ProfileLook) {
        val sdk = Build.VERSION.SDK_INT
        val path = when (WidgetColors.resolver(sdk)) {
            WidgetColors.Resolver.Launcher -> "the launcher picks day or night from colours carried in the widget"
            WidgetColors.Resolver.App -> "the app resolved ${if (isDark(context)) "night" else "day"} at this update"
        }
        Log.i(LOG_TAG, "widget $widget update on API $sdk: $path; the app sees ${if (isDark(context)) "night" else "day"}; look $look")
    }

    enum class Kind(val labelRes: Int) {
        Search(R.string.widget_search_label),
        MacTabs(R.string.widget_mac_tabs_label),
    }

    fun label(context: Context, kind: Kind): String = context.getString(kind.labelRes)

    const val LOG_TAG = "ArdiaWidget"
}

@Composable
private fun WidgetPanel(colors: WidgetColors.DayNight, label: String, modifier: GlanceModifier = GlanceModifier, content: @Composable () -> Unit) {
    val fill = GlanceModifier.fillMaxSize()
    Box(fill.background(ArdiaWidgets.both(colors) { it.panelTop }).cornerRadius(26.dp).semantics { contentDescription = label }) {
        Image(
            ImageProvider(R.drawable.widget_fade_down),
            contentDescription = null,
            modifier = fill,
            contentScale = ContentScale.FillBounds,
            colorFilter = ColorFilter.tint(ArdiaWidgets.both(colors) { if (it.panelDiagonal) it.panelTop else it.panelBottom }),
        )
        Image(
            ImageProvider(R.drawable.widget_fade_diagonal),
            contentDescription = null,
            modifier = fill,
            contentScale = ContentScale.FillBounds,
            colorFilter = ColorFilter.tint(ArdiaWidgets.both(colors) { if (it.panelDiagonal) it.panelBottom else it.panelTop }),
        )
        Box(fill.then(modifier)) { content() }
    }
}

class SearchWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, MEDIUM))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { key(currentState(ArdiaWidgets.REVISION) ?: 0L) { SearchWidgetContent() } }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val MEDIUM = DpSize(250.dp, 110.dp)
    }
}

@Composable
private fun SearchWidgetContent() {
    val context = LocalContext.current
    val isSmall = LocalSize.current.width < SearchWidget.MEDIUM.width
    val look = SystemStore.shared(context).loadSnapshot().look
    ArdiaWidgets.logUpdate(context, "search", look)
    val colors = WidgetColors.dayNight(look, themed = true)
    val inkProvider = ArdiaWidgets.both(colors) { it.ink }
    val capsule = ArdiaWidgets.both(colors) { it.capsule }
    WidgetPanel(colors, ArdiaWidgets.label(context, ArdiaWidgets.Kind.Search)) {
        Column(GlanceModifier.fillMaxSize().padding(16.dp)) {
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                Image(ImageProvider(R.drawable.ardia_logo), contentDescription = null, modifier = GlanceModifier.size(46.dp, 37.dp))
                Spacer(GlanceModifier.defaultWeight())
                if (!isSmall) {
                    Text(
                        context.getString(R.string.app_name),
                        style = TextStyle(color = ArdiaWidgets.both(colors) { it.ink.copy(alpha = 0.85f) }, fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    )
                }
            }
            Spacer(GlanceModifier.defaultWeight())
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    GlanceModifier
                        .defaultWeight()
                        .height(44.dp)
                        .background(capsule)
                        .cornerRadius(22.dp)
                        .padding(horizontal = 14.dp)
                        .clickable(ArdiaWidgets.open(context, SystemLink.Search(null)))
                        .semantics { contentDescription = context.getString(R.string.widget_search) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Image(
                        ImageProvider(R.drawable.ic_shortcut_search),
                        contentDescription = null,
                        modifier = GlanceModifier.size(16.dp),
                        colorFilter = ColorFilter.tint(inkProvider),
                    )
                    Spacer(GlanceModifier.width(6.dp))
                    Text(
                        context.getString(if (isSmall) R.string.widget_search else R.string.widget_search_or_enter_address),
                        maxLines = 1,
                        style = TextStyle(color = inkProvider, fontSize = 15.sp, fontWeight = FontWeight.Medium),
                    )
                }
                if (!isSmall) {
                    Spacer(GlanceModifier.width(8.dp))
                    Box(
                        GlanceModifier
                            .size(44.dp)
                            .background(capsule)
                            .cornerRadius(22.dp)
                            .clickable(ArdiaWidgets.open(context, SystemLink.VoiceSearch))
                            .semantics { contentDescription = context.getString(R.string.widget_voice_search) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            ImageProvider(R.drawable.ic_shortcut_voice),
                            contentDescription = null,
                            modifier = GlanceModifier.size(18.dp),
                            colorFilter = ColorFilter.tint(inkProvider),
                        )
                    }
                }
            }
        }
    }
}

class MacTabsWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(MEDIUM, LARGE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { key(currentState(ArdiaWidgets.REVISION) ?: 0L) { MacTabsWidgetContent() } }
    }

    companion object {
        val MEDIUM = DpSize(250.dp, 110.dp)
        val LARGE = DpSize(250.dp, 260.dp)
        const val MEDIUM_ROWS = 3
        const val LARGE_ROWS = 7

        fun sections(snapshot: SystemSnapshot, rowLimit: Int, large: Boolean): List<SystemDeviceTabs> {
            var remaining = rowLimit
            val result = ArrayList<SystemDeviceTabs>()
            for (group in snapshot.macTabs) {
                if (group.tabs.isEmpty()) continue
                if (remaining <= (if (result.isEmpty()) 0 else 1)) break
                if (result.isNotEmpty()) remaining -= 1
                val tabs = group.tabs.take(remaining)
                remaining -= tabs.size
                result.add(SystemDeviceTabs(group.device, tabs))
                if (!large) break
            }
            return result
        }
    }
}

@Composable
private fun MacTabsWidgetContent() {
    val context = LocalContext.current
    val store = SystemStore.shared(context)
    val snapshot = store.loadSnapshot()
    val icons = snapshot.macTabs.flatMap { it.tabs }.mapNotNull { tab ->
        val name = tab.favicon ?: return@mapNotNull null
        val file = store.favicon(name)
        if (!file.isFile) return@mapNotNull null
        BitmapFactory.decodeFile(file.path)?.let { name to it }
    }.toMap()
    ArdiaWidgets.logUpdate(context, "macTabs", snapshot.look)
    val colors = WidgetColors.dayNight(snapshot.look, themed = false, softened = true)
    val large = LocalSize.current.height >= MacTabsWidget.LARGE.height
    WidgetPanel(colors, ArdiaWidgets.label(context, ArdiaWidgets.Kind.MacTabs), GlanceModifier.padding(16.dp)) {
        when {
            !snapshot.isSyncEnabled -> MacTabsEmpty(R.string.widget_mac_tabs_sync_title, R.string.widget_mac_tabs_sync_message, R.drawable.ic_shortcut_mac_tabs, large, colors)
            !snapshot.hasMacTabs -> MacTabsEmpty(R.string.widget_mac_tabs_empty_title, R.string.widget_mac_tabs_empty_message, R.drawable.ic_shortcut_mac_tabs, large, colors)
            else -> Column(GlanceModifier.fillMaxSize()) {
                val sections = MacTabsWidget.sections(snapshot, if (large) MacTabsWidget.LARGE_ROWS else MacTabsWidget.MEDIUM_ROWS, large)
                sections.forEachIndexed { index, section ->
                    if (index > 0) Spacer(GlanceModifier.height(10.dp))
                    Row(
                        GlanceModifier.fillMaxWidth().clickable(ArdiaWidgets.open(context, SystemLink.MacTabs)),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Image(
                            ImageProvider(R.drawable.ic_shortcut_mac_tabs),
                            contentDescription = null,
                            modifier = GlanceModifier.size(14.dp),
                            colorFilter = ColorFilter.tint(ArdiaWidgets.both(colors) { it.accent }),
                        )
                        Spacer(GlanceModifier.width(5.dp))
                        Text(
                            section.device.name,
                            maxLines = 1,
                            modifier = GlanceModifier.defaultWeight(),
                            style = TextStyle(color = ArdiaWidgets.both(colors) { it.accent }, fontSize = 12.sp, fontWeight = FontWeight.Medium),
                        )
                        Image(ImageProvider(R.drawable.ardia_logo_plain), contentDescription = null, modifier = GlanceModifier.size(18.dp, 14.dp))
                    }
                    section.tabs.forEach { tab ->
                        Spacer(GlanceModifier.height(10.dp))
                        MacTabRow(tab, tab.favicon?.let(icons::get), colors)
                    }
                }
            }
        }
    }
}

@Composable
private fun MacTabRow(tab: SystemTab, icon: Bitmap?, colors: WidgetColors.DayNight) {
    val context = LocalContext.current
    Row(
        GlanceModifier.fillMaxWidth().clickable(ArdiaWidgets.open(context, SystemLink.Open(tab.url))),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Image(ImageProvider(icon), contentDescription = null, modifier = GlanceModifier.size(22.dp).cornerRadius(5.dp))
        } else {
            Box(GlanceModifier.size(22.dp).background(ArdiaWidgets.both(colors) { it.monogramFill }).cornerRadius(5.dp), contentAlignment = Alignment.Center) {
                Text(
                    Monogram.host(tab.url)?.take(1)?.uppercase().orEmpty(),
                    style = TextStyle(color = ArdiaWidgets.both(colors) { it.secondaryLabel }, fontSize = 12.sp, fontWeight = FontWeight.Medium),
                )
            }
        }
        Spacer(GlanceModifier.width(10.dp))
        Column(GlanceModifier.defaultWeight()) {
            Text(tab.displayTitle, maxLines = 1, style = TextStyle(color = ArdiaWidgets.both(colors) { it.label }, fontSize = 15.sp, fontWeight = FontWeight.Medium))
            tab.host?.let { Text(it, maxLines = 1, style = TextStyle(color = ArdiaWidgets.both(colors) { it.secondaryLabel }, fontSize = 11.sp)) }
        }
    }
}

@Composable
private fun MacTabsEmpty(title: Int, message: Int, icon: Int, large: Boolean, colors: WidgetColors.DayNight) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize().clickable(ArdiaWidgets.open(context, SystemLink.MacTabs))) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Image(ImageProvider(icon), contentDescription = null, modifier = GlanceModifier.size(26.dp), colorFilter = ColorFilter.tint(ArdiaWidgets.both(colors) { it.accent }))
            Spacer(GlanceModifier.defaultWeight())
            Image(ImageProvider(R.drawable.ardia_logo), contentDescription = null, modifier = GlanceModifier.size(32.dp, 26.dp))
        }
        Spacer(GlanceModifier.defaultWeight())
        Text(context.getString(title), style = TextStyle(color = ArdiaWidgets.both(colors) { it.label }, fontSize = 17.sp, fontWeight = FontWeight.Bold))
        Text(context.getString(message), maxLines = if (large) 4 else 2, style = TextStyle(color = ArdiaWidgets.both(colors) { it.secondaryLabel }, fontSize = 15.sp))
    }
}

class SearchWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SearchWidget()
}

class MacTabsWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MacTabsWidget()
}
