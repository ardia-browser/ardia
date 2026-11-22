package com.ardia.phone

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ardia.design.ArdiaSymbols
import com.ardia.design.ArdiaType
import com.ardia.design.Palette
import com.ardia.design.Spacing
import com.ardia.design.SystemPalette
import com.ardia.design.bold
import com.ardia.design.semibold
import com.ardia.design.weight
import com.ardia.research.ResearchAnswer
import com.ardia.research.ResearchSearch
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun ResearchScreen(session: ResearchSession, host: BrowseForMeHost) {
    var copies by remember { mutableIntStateOf(0) }
    var showsCopied by remember { mutableStateOf(false) }
    LaunchedEffect(copies) {
        if (copies == 0) return@LaunchedEffect
        showsCopied = true
        delay(1_500)
        showsCopied = false
    }
    Box(Modifier.fillMaxSize().background(SystemPalette.background.current).safeDrawingPadding()) {
        Column(Modifier.fillMaxSize()) {
            TopBar(session, host) { copies += 1 }
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.medium).padding(top = Spacing.tight, bottom = Spacing.section),
                verticalArrangement = Arrangement.spacedBy(Spacing.large),
            ) {
                Text(session.query, style = ArdiaType.title.bold, color = SystemPalette.label.current, modifier = Modifier.semantics { heading() })
                if (!session.isFinished) Status(session)
                Sources(session, host)
                Content(session, host)
            }
        }
        AnimatedVisibility(showsCopied, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = Spacing.section * 3)) {
            Row(
                Modifier.background(Palette.toast.current, RoundedCornerShape(50)).padding(horizontal = Spacing.medium, vertical = Spacing.small),
                horizontalArrangement = Arrangement.spacedBy(Spacing.tight),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(ArdiaSymbols.docOnDoc, null, Modifier.size(16.dp), tint = SystemPalette.label.current)
                Text("Copied Answer", style = ArdiaType.subheadline.semibold, color = SystemPalette.label.current)
            }
        }
    }
}

@Composable
private fun TopBar(session: ResearchSession, host: BrowseForMeHost, onCopied: () -> Unit) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.tight, vertical = Spacing.hairline), verticalAlignment = Alignment.CenterVertically) {
        Box {
            Box(Modifier.size(44.dp).clickable { menu = true }.semantics { contentDescription = "More" }, contentAlignment = Alignment.Center) {
                Icon(ArdiaSymbols.ellipsis, null, Modifier.size(22.dp), tint = SystemPalette.label.current)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Search the Web") }, leadingIcon = { Icon(ArdiaSymbols.magnifyingglass, null, Modifier.size(18.dp)) }, onClick = {
                    menu = false
                    host.searchWeb(session.query)
                })
                if (session.phase is ResearchSession.Phase.Done) {
                    DropdownMenuItem(text = { Text("Copy Answer") }, leadingIcon = { Icon(ArdiaSymbols.docOnDoc, null, Modifier.size(18.dp)) }, onClick = {
                        menu = false
                        copy(context, ResearchAnswer.spoken(session.answer))
                        onCopied()
                    })
                }
                if (session.isFinished) {
                    DropdownMenuItem(text = { Text("Browse Again") }, leadingIcon = { Icon(ArdiaSymbols.arrowClockwise, null, Modifier.size(18.dp)) }, onClick = {
                        menu = false
                        session.retry()
                    })
                }
            }
        }
        Spacer(Modifier.weight(1f))
        Box(Modifier.heightIn(min = 44.dp).clickable { host.dismiss() }.padding(horizontal = Spacing.small), contentAlignment = Alignment.Center) {
            Text("Done", style = ArdiaType.body.semibold, color = Palette.formAccent.current)
        }
    }
}

private fun copy(context: Context, text: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText("Answer", text))
}

@Composable
private fun Status(session: ResearchSession) {
    val text = when (val phase = session.phase) {
        ResearchSession.Phase.Searching -> "Searching the web"
        is ResearchSession.Phase.Reading -> "Reading ${minOf(phase.done + 1, phase.total)} of ${phase.total} pages"
        ResearchSession.Phase.Writing -> "Writing your answer"
        else -> ""
    }
    Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(Spacing.small), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), color = SystemPalette.secondaryLabel.current, strokeWidth = 2.dp)
        Text(text, style = ArdiaType.subheadline.weight(FontWeight.Medium), color = SystemPalette.secondaryLabel.current)
    }
}

private data class Chip(val number: Int?, val url: String, val site: String, val title: String)

@Composable
private fun Sources(session: ResearchSession, host: BrowseForMeHost) {
    val chips = if (session.sources.isNotEmpty()) {
        session.sources.map { Chip(it.id, it.url, it.siteName, it.title) }
    } else {
        session.links.take(ResearchSearch.RESULT_LIMIT).map { Chip(null, it.url, it.host, it.title) }
    }
    if (chips.isEmpty()) return
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(Spacing.tight),
    ) {
        for (chip in chips) {
            Column(
                Modifier
                    .width(176.dp)
                    .background(SystemPalette.secondaryBackground.current.copy(alpha = if (session.sources.isEmpty()) 0.6f else 1f), RoundedCornerShape(14.dp))
                    .clickable { host.openSource(chip.url) }
                    .padding(Spacing.small)
                    .semantics(mergeDescendants = true) { contentDescription = "${chip.site}, ${chip.title}" },
                verticalArrangement = Arrangement.spacedBy(Spacing.hairline),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(ArdiaSymbols.globe, null, Modifier.size(14.dp), tint = SystemPalette.secondaryLabel.current)
                    Text(chip.site, style = ArdiaType.caption.semibold, color = SystemPalette.label.current, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    chip.number?.let { Text("$it", style = ArdiaType.caption.bold, color = SystemPalette.secondaryLabel.current) }
                }
                Text(chip.title, style = ArdiaType.footnote, color = SystemPalette.secondaryLabel.current, maxLines = 2, minLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun Content(session: ResearchSession, host: BrowseForMeHost) {
    val phase = session.phase
    if (phase is ResearchSession.Phase.Failed) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.small)) {
            Text(phase.message, style = ArdiaType.body, color = SystemPalette.secondaryLabel.current)
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.tight)) {
                Pill("Try Again", prominent = true) { session.retry() }
                Pill("Search the Web", prominent = false) { host.searchWeb(session.query) }
            }
        }
        return
    }
    val secondary = SystemPalette.secondaryLabel.current
    val label = SystemPalette.label.current
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.small)) {
            for (block in ResearchAnswer.blocks(session.answer)) {
                when (block) {
                    is ResearchAnswer.Block.Heading -> Text(cited(block.text, secondary), style = ArdiaType.title3.semibold, color = label, modifier = Modifier.padding(top = Spacing.tight).semantics { heading() })
                    is ResearchAnswer.Block.Bullet -> Row(horizontalArrangement = Arrangement.spacedBy(Spacing.tight)) {
                        Text("•", style = ArdiaType.body, color = secondary)
                        Text(cited(block.text, secondary), style = ArdiaType.body, color = label)
                    }
                    is ResearchAnswer.Block.Paragraph -> Text(cited(block.text, secondary), style = ArdiaType.body, color = label)
                }
            }
        }
    }
    val writer = session.writer
    if (phase is ResearchSession.Phase.Done && writer != null) WriterNote(session, writer, host)
}

@Composable
private fun WriterNote(session: ResearchSession, writer: ResearchSession.Writer, host: BrowseForMeHost) {
    val account by host.account.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val note = when (writer) {
        is ResearchSession.Writer.ChatGPT -> "Written by ChatGPT (${writer.model}) on your plan from the pages above. Check them for anything important."
        is ResearchSession.Writer.OnDevice -> writer.fallback?.let { "$it Gemini Nano wrote this on your phone instead." } ?: "Written on this phone by Gemini Nano from the pages above. Check them for anything important."
        is ResearchSession.Writer.Excerpts -> writer.reason
    }
    val symbol = when (writer) {
        is ResearchSession.Writer.Excerpts -> ArdiaSymbols.docText
        else -> ArdiaSymbols.sparkles
    }
    Column(Modifier.padding(top = Spacing.small), verticalArrangement = Arrangement.spacedBy(Spacing.medium)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.tight)) {
            Icon(symbol, null, Modifier.size(16.dp).padding(top = 1.dp), tint = SystemPalette.secondaryLabel.current)
            Text(note, style = ArdiaType.footnote, color = SystemPalette.secondaryLabel.current)
        }
        if (writer is ResearchSession.Writer.Excerpts && session.geminiNanoMissing == OnDeviceWriter.Availability.Downloading.telemetry) GeminiNanoDownload(session)
        if (!account.isConnected && !session.forcesExcerpts) {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.tight)) {
                ContinueWithChatGPT(account.isSigningIn) {
                    val activity = context.findActivity() ?: return@ContinueWithChatGPT
                    scope.launch { if (host.account.signIn(activity)) session.rewrite() }
                }
                Text(
                    account.problem ?: "Better answers from your ChatGPT Plus or Pro plan. Nothing goes through a server of ours.",
                    style = ArdiaType.footnote,
                    color = if (account.problem == null) SystemPalette.secondaryLabel.current else SystemPalette.red.current,
                )
            }
        }
    }
}

@Composable
private fun GeminiNanoDownload(session: ResearchSession) {
    val download by OnDeviceWriter.download.collectAsState()
    when (val state = download) {
        is OnDeviceWriter.Download.Ready -> Row { Pill("Rewrite with Gemini Nano", prominent = true) { session.rewrite(afterGeminiNanoDownload = true) } }
        is OnDeviceWriter.Download.Running -> Text(
            state.fraction?.let { "Downloading Gemini Nano… ${(it * 100).roundToInt()}%. You can rewrite this answer with it when it’s done." } ?: "Downloading Gemini Nano… You can rewrite this answer with it when it’s done.",
            style = ArdiaType.footnote,
            color = SystemPalette.secondaryLabel.current,
        )
        else -> Unit
    }
}

@Composable
internal fun ContinueWithChatGPT(signingIn: Boolean, onPress: () -> Unit) {
    val fill = Palette.primaryAction.current
    val ink = Palette.onPrimaryAction.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(fill, RoundedCornerShape(50))
            .clickable(enabled = !signingIn, onClick = onPress)
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (signingIn) {
            CircularProgressIndicator(Modifier.size(18.dp), color = ink, strokeWidth = 2.dp)
            Spacer(Modifier.width(Spacing.tight))
        }
        Text("Continue with ChatGPT", style = ArdiaType.body.semibold, color = ink)
    }
}

@Composable
private fun Pill(title: String, prominent: Boolean, onPress: () -> Unit) {
    val fill = if (prominent) Palette.formAccent.current else SystemPalette.tertiaryFill.current
    val ink = if (prominent) Color.White else SystemPalette.label.current
    Box(Modifier.heightIn(min = 40.dp).widthIn(min = 44.dp).background(fill, RoundedCornerShape(50)).clickable(onClick = onPress).padding(horizontal = Spacing.page), contentAlignment = Alignment.Center) {
        Text(title, style = ArdiaType.subheadline.semibold, color = ink)
    }
}

private fun cited(text: String, secondary: Color): AnnotatedString = buildAnnotatedString {
    var cursor = 0
    for (run in ResearchAnswer.citationRuns(text)) {
        append(text.substring(cursor, run.range.first))
        pushStyle(SpanStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = secondary, baselineShift = BaselineShift(0.35f), fontFeatureSettings = "tnum"))
        append(" " + run.numbers.joinToString(","))
        pop()
        cursor = run.range.last + 1
    }
    append(text.substring(cursor))
}

internal fun Context.findActivity(): android.app.Activity? {
    var current: Context? = this
    while (current is android.content.ContextWrapper) {
        if (current is android.app.Activity) return current
        current = current.baseContext
    }
    return null
}
