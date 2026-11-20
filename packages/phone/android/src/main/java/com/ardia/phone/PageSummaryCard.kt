package com.ardia.phone

import android.content.Context
import android.content.res.Configuration
import android.graphics.Rect
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.ardia.design.ArdiaSymbols
import com.ardia.design.ArdiaType
import com.ardia.design.LocalArdiaDarkTheme
import com.ardia.design.Palette
import com.ardia.design.Spacing
import com.ardia.design.SystemPalette
import com.ardia.design.semibold
import com.ardia.research.ResearchAnswer
import kotlin.math.roundToInt

internal class PageSummaryPresenter {
    var session: PageSummarySession? by mutableStateOf<PageSummarySession?>(null)
    var shown: Boolean by mutableStateOf(false)
    var maxHeightDp: Float by mutableFloatStateOf(240f)
    val cardBounds = Rect()
    var onClose: (() -> Unit)? = null

    fun close() {
        onClose?.invoke()
    }
}

internal fun pageSummaryLayer(context: Context, presenter: PageSummaryPresenter): ComposeView = ComposeView(context).apply {
    setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
    setContent {
        val dark = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        CompositionLocalProvider(LocalArdiaDarkTheme provides dark) { PageSummaryOverlay(presenter) }
    }
}

@Composable
private fun PageSummaryOverlay(presenter: PageSummaryPresenter) {
    val visibility = remember { MutableTransitionState(false) }
    val wanted = presenter.shown && presenter.session != null
    SideEffect { visibility.targetState = wanted }
    AnimatedVisibility(
        visibleState = visibility,
        enter = slideInVertically(tween(280)) { it / 3 } + fadeIn(tween(200)),
        exit = slideOutVertically(tween(220)) { it / 3 } + fadeOut(tween(180)),
    ) {
        val shownSession = presenter.session ?: return@AnimatedVisibility
        Box(Modifier.fillMaxWidth().padding(horizontal = Spacing.small), contentAlignment = Alignment.BottomCenter) {
            PageSummaryCard(
                shownSession,
                presenter.maxHeightDp.dp,
                Modifier.onGloballyPositioned { coordinates ->
                    val bounds = coordinates.boundsInRoot()
                    presenter.cardBounds.set(bounds.left.roundToInt(), bounds.top.roundToInt(), bounds.right.roundToInt(), bounds.bottom.roundToInt())
                },
            ) { presenter.close() }
        }
    }
}

@Composable
private fun PageSummaryCard(session: PageSummarySession, maxHeight: Dp, modifier: Modifier, onClose: () -> Unit) {
    val shape = RoundedCornerShape(24.dp)
    Column(
        modifier
            .widthIn(max = 560.dp)
            .fillMaxWidth()
            .heightIn(max = maxHeight)
            .shadow(12.dp, shape, ambientColor = Palette.toastShadow.current, spotColor = Palette.toastShadow.current)
            .background(Palette.panel.current, shape)
            .border(1.dp, Palette.panelBorder.current, shape)
            .padding(start = Spacing.page, end = Spacing.page, bottom = Spacing.page)
            .semantics {
                paneTitle = "Summary"
                customActions = listOf(CustomAccessibilityAction("Close Summary") { onClose(); true })
            },
    ) {
        Header(session, onClose)
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Spacing.tight)) {
            Body(session)
        }
    }
}

@Composable
private fun Header(session: PageSummarySession, onClose: () -> Unit) {
    var pulled by remember { mutableFloatStateOf(0f) }
    Row(
        Modifier
            .fillMaxWidth()
            .pointerInput(session.id) {
                detectVerticalDragGestures(
                    onDragStart = { pulled = 0f },
                    onDragEnd = { if (pulled > 48.dp.toPx()) onClose() },
                    onDragCancel = { pulled = 0f },
                ) { _, amount -> pulled += amount }
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(top = Spacing.page).semantics(mergeDescendants = true) { heading() }) {
            Text("Summary", style = ArdiaType.headline, color = SystemPalette.label.current)
            if (session.title.isNotEmpty()) Text(session.title, style = ArdiaType.footnote, color = SystemPalette.secondaryLabel.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(
            Modifier.size(44.dp).padding(top = Spacing.tight).clickable(onClick = onClose).semantics { contentDescription = "Close Summary" },
            contentAlignment = Alignment.Center,
        ) {
            Icon(ArdiaSymbols.xmark, null, Modifier.size(16.dp), tint = SystemPalette.secondaryLabel.current)
        }
    }
}

@Composable
private fun Body(session: PageSummarySession) {
    val secondary = SystemPalette.secondaryLabel.current
    val label = SystemPalette.label.current
    when (val phase = session.phase) {
        is PageSummarySession.Phase.Failed -> Text(phase.message, style = ArdiaType.body, color = secondary, modifier = Modifier.padding(top = Spacing.tight).semantics { liveRegion = LiveRegionMode.Polite })
        else -> {
            if (session.text.isEmpty()) {
                Row(
                    Modifier.padding(top = Spacing.tight).semantics(mergeDescendants = true) {},
                    horizontalArrangement = Arrangement.spacedBy(Spacing.tight),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = secondary, strokeWidth = 2.dp)
                    Text("Summarizing…", style = ArdiaType.body, color = secondary)
                }
            } else {
                Column(Modifier.padding(top = Spacing.tight), verticalArrangement = Arrangement.spacedBy(Spacing.tight)) {
                    for (block in ResearchAnswer.blocks(session.text)) {
                        when (block) {
                            is ResearchAnswer.Block.Heading -> Text(ResearchAnswer.withoutCitations(block.text), style = ArdiaType.subheadline.semibold, color = label)
                            is ResearchAnswer.Block.Bullet -> Row(horizontalArrangement = Arrangement.spacedBy(Spacing.tight)) {
                                Text("•", style = ArdiaType.body, color = secondary)
                                Text(ResearchAnswer.withoutCitations(block.text), style = ArdiaType.body, color = label)
                            }
                            is ResearchAnswer.Block.Paragraph -> Text(ResearchAnswer.withoutCitations(block.text), style = ArdiaType.body, color = label)
                        }
                    }
                }
            }
            val note = session.note
            if (note != null && phase is PageSummarySession.Phase.Done) {
                Row(Modifier.padding(top = Spacing.hairline).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, horizontalArrangement = Arrangement.spacedBy(Spacing.tight)) {
                    Icon(ArdiaSymbols.sparkles, null, Modifier.size(16.dp).padding(top = 1.dp), tint = secondary)
                    Text(note, style = ArdiaType.footnote, color = secondary)
                }
            }
        }
    }
}
