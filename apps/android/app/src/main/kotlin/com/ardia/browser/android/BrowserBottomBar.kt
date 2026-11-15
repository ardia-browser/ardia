package com.ardia.browser.android

import android.view.HapticFeedbackConstants
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.ardia.appmodel.AppModel
import com.ardia.browser.PageColors
import com.ardia.browser.ScrollDirection
import com.ardia.browsing.BarGeometry
import com.ardia.browsing.BottomBar
import com.ardia.browsing.BrowsingTags
import com.ardia.browsing.LocalTabPager
import com.ardia.browsing.barBacking
import com.ardia.browsing.rememberTabPager
import com.ardia.browsing.select
import com.ardia.browsing.tabPagerDrag
import com.ardia.design.ArdiaSymbols
import com.ardia.design.BrowseLayout
import com.ardia.design.LocalArdiaDarkTheme
import com.ardia.design.LocalProfileLook
import com.ardia.design.LocalReduceMotion
import com.ardia.design.Motion
import com.ardia.design.SwiftEasing
import com.ardia.design.rememberFrostedBackdrop
import com.ardia.tabs.CloseAllTabsDialog
import com.ardia.tabs.DeckBarActions
import com.ardia.tabs.TabDeckBar
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

@Composable
fun BrowserBottomBar(
    model: AppModel,
    modifier: Modifier = Modifier,
) {
    val surface = model.surface
    val isOpeningTab = model.deck.openingTabId != null
    val isBrowsing = surface == AppModel.Surface.Browsing || isOpeningTab
    val isHome = surface == AppModel.Surface.Search

    val activeTabId = model.deck.openingTabId ?: model.tabs.selectedTabId
    val tab = activeTabId?.let { model.tab(it) } ?: model.tabs.selectedTab
    val page = activeTabId?.let { model.page(it) } ?: model.currentPage
    val collapses = model.settings.collapsesBottomBar
    val pager = LocalTabPager.current ?: rememberTabPager(model)

    LaunchedEffect(model.tabs.selectedTabId, isBrowsing) {
        model.browse.isBarHidden = false
    }

    LaunchedEffect(page, collapses, isBrowsing) {
        if (page == null || !isBrowsing) {
            model.browse.isBarHidden = false
            return@LaunchedEffect
        }
        page.state.map { it.scrollDirection }.distinctUntilChanged().collect { direction ->
            model.browse.isBarHidden = collapses && direction == ScrollDirection.Down
        }
    }

    val fullscreen = page?.fullscreen?.collectAsState()?.value
    val isFinding = model.browse.isFindPresented && isBrowsing
    val trayPresented = model.browse.search != null
    val barHidden = model.browse.isBarHidden && isBrowsing
    val hidden = fullscreen != null || isFinding || trayPresented || barHidden

    val density = LocalDensity.current
    val navigationBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val centerFromBottom = BarGeometry.centerFromBottom(navigationBottom)
    val bottomPadding = centerFromBottom - BrowseLayout.hitTarget / 2
    val barHeight = BarGeometry.height(navigationBottom)

    val reduceMotion = LocalReduceMotion.current
    val hideState = animateFloatAsState(
        targetValue = if (hidden) 1f else 0f,
        animationSpec = if (reduceMotion) tween(200) else Motion.barCollapse.spec(),
        label = "barCollapse",
    )
    val hide by hideState
    val gone by remember { derivedStateOf { hideState.value > 0.99f } }
    val controlsHidden = hidden && gone

    val travel = with(density) { BrowseLayout.barCollapseTravel.toPx() }
    val colors = page?.select { it.themeColor to it.backgroundColor }?.value
    val tone = tab?.let { model.tone(it, colors?.first, colors?.second) }?.bottom

    val backgroundAlpha by animateFloatAsState(
        targetValue = if (isBrowsing) 1f else 0f,
        animationSpec = if (reduceMotion) tween(150) else Motion.barTone.spec(),
        label = "barBgAlpha",
    )

    val look = LocalProfileLook.current
    val barDark = tone?.let(PageColors::isDark) ?: LocalArdiaDarkTheme.current

    Box(
        modifier = modifier
            .testTag(BrowsingTags.BAR)
            .fillMaxWidth()
            .height(barHeight)
            .graphicsLayer {
                translationY = hide * travel
                alpha = 1f - hide
            }
            .barBacking(tone, if (controlsHidden) 0f else backgroundAlpha)
            .tabPagerDrag(pager, enabled = surface == AppModel.Surface.Browsing && !hidden),
    ) {
        if (!controlsHidden) {
            val opensTabs = model.deckTabs.isNotEmpty() && isHome
            val backdrop = rememberFrostedBackdrop()
            val insets = WindowInsets.safeDrawing
            val direction = LocalLayoutDirection.current
            val safeSide = with(density) { maxOf(insets.getLeft(this, direction), insets.getRight(this, direction)).toDp() }
            val barSidePadding = safeSide + BrowseLayout.barSideInset - 4.dp

            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = bottomPadding)
                    .height(BrowseLayout.hitTarget)
                    .fillMaxWidth(),
            ) {
                AnimatedContent(
                    targetState = isBrowsing,
                    transitionSpec = {
                        (fadeIn(animationSpec = if (reduceMotion) tween(150) else tween(180, easing = SwiftEasing.easeOut)) togetherWith
                         fadeOut(animationSpec = if (reduceMotion) tween(100) else tween(140, easing = SwiftEasing.easeIn)))
                    },
                    label = "barMode",
                ) { browsingMode ->
                    if (browsingMode) {
                        CompositionLocalProvider(LocalArdiaDarkTheme provides barDark) {
                            BottomBar(
                                model = model,
                                isSearchPresented = model.browse.search != null,
                                onTabs = {
                                    pager.cancel()
                                    model.browse.thawOrder()
                                    model.showTabSwitcher()
                                },
                                onPlus = model::newTab,
                                onMore = { model.browse.isToolbarPresented = true },
                                onStep = pager::stepTab,
                                onSelectTab = pager::switchTab,
                                onCloseTab = { model.tabs.selectedTabId?.let(model::closeTab) },
                                modifier = Modifier.padding(horizontal = safeSide),
                            )
                        }
                    } else {
                        val actions = remember(model, opensTabs) {
                            DeckBarActions(
                                newTab = model::newTab,
                                newRegularTab = model::newRegularTab,
                                newIncognitoTab = model::newIncognitoTab,
                                reopen = model::reopenLastClosed,
                                closeAll = { model.deck.isConfirmingCloseAll = true },
                                leading = {
                                    if (opensTabs) {
                                        model.showTabSwitcher()
                                    } else if (model.syncState.isEnabled) {
                                        model.openSyncedSpaces()
                                    } else {
                                        model.openArchive()
                                    }
                                },
                                settings = { model.sheet = AppModel.Sheet.Settings },
                            )
                        }
                        TabDeckBar(
                            backdrop = backdrop,
                            look = look,
                            isIncognito = model.isIncognito,
                            showsSyncedTabs = model.syncState.isEnabled && !opensTabs,
                            canReopen = model.tabs.canReopenClosed,
                            hasTabs = model.deckTabs.isNotEmpty(),
                            actions = actions,
                            leadingSymbol = if (opensTabs) ArdiaSymbols.squareOnSquare else null,
                            leadingLabel = if (opensTabs) stringResource(com.ardia.search.R.string.deck_tabs) else null,
                            modifier = Modifier.padding(horizontal = barSidePadding),
                        )
                    }
                }
            }
        }
    }
    if (model.deck.isConfirmingCloseAll && model.deckTabs.isNotEmpty()) {
        val view = LocalView.current
        CloseAllTabsDialog(
            count = model.deckTabs.size,
            hasPrivate = model.tabs.privateTabs.isNotEmpty(),
            onConfirm = {
                model.deck.isConfirmingCloseAll = false
                view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                model.closeAllTabs()
            },
            onDismiss = { model.deck.isConfirmingCloseAll = false },
        )
    }
}
