package com.ardia.browser.android

import android.content.Context
import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.test.core.app.ApplicationProvider
import com.ardia.appmodel.AppEnvironment
import com.ardia.appmodel.AppModel
import com.ardia.appmodel.LaunchArguments
import com.ardia.browser.ScrollDirection
import com.ardia.browsing.BrowsingTags
import com.ardia.browsing.LocalTabPager
import com.ardia.browsing.TabPager
import com.ardia.browsing.rememberTabPager
import com.ardia.design.ArdiaTheme
import com.ardia.store.CoreScript
import com.ardia.store.TabOrigin
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class BrowserBottomBarTest {
    @get:Rule
    val compose = createComposeRule()
    private lateinit var model: AppModel
    private lateinit var engine: StillPageEngine
    private lateinit var pager: TabPager

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val real = AppEnvironment.forApp(context, isDemo = true)
        engine = StillPageEngine()
        val environment = AppEnvironment(
            isDemo = true,
            preferences = real.preferences,
            blockingStore = real.blockingStore,
            openStore = real.openStore,
            makeEngine = { engine },
            makeSync = real.makeSync,
            makeFilterLists = real.makeFilterLists,
            coreScript = { CoreScript { _, _ -> "null" } },
            omniboxDirectory = null,
            system = real.system,
        )
        model = AppModel(LaunchArguments(isDemo = true, restingStart = true), environment)
        settle { model.isReady }
        compose.setContent {
            ArdiaTheme(darkTheme = false, look = model.look, reduceMotion = true, reduceTransparency = true) {
                pager = rememberTabPager(model)
                pager.widthDp = 400f
                CompositionLocalProvider(LocalTabPager provides pager) {
                    BrowserBottomBar(model)
                }
            }
        }
        settle { true }
    }

    @After
    fun tearDown() {
        model.close()
    }

    private fun settle(label: String = "", condition: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < end) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.mainClock.advanceTimeByFrame()
            Thread.sleep(5)
        }
        shadowOf(Looper.getMainLooper()).idle()
        if (!condition()) error("timed out waiting for condition: $label")
    }

    private fun openPage(url: String): StillPage {
        model.openPage(url, TabOrigin.TYPED)
        settle("surface and page ready") { model.surface == AppModel.Surface.Browsing && model.currentPage != null }
        compose.waitForIdle()
        return model.currentPage as StillPage
    }

    @Test
    fun barHidesOnScrollDownAndShowsOnScrollUp() {
        val page = openPage("https://example.com/")
        assertFalse(model.browse.isBarHidden)

        page.mutableState.value = page.mutableState.value.copy(scrollDirection = ScrollDirection.Down)
        settle("bar hidden on scroll down") { model.browse.isBarHidden }
        assertTrue(model.browse.isBarHidden)

        page.mutableState.value = page.mutableState.value.copy(scrollDirection = ScrollDirection.Up)
        settle("bar shown on scroll up") { !model.browse.isBarHidden }
        assertFalse(model.browse.isBarHidden)
    }

    @Test
    fun hiddenBarRemovesControlsFromComposition() {
        val page = openPage("https://example.com/")
        compose.onNodeWithTag(BrowsingTags.TABS).assertExists()

        page.mutableState.value = page.mutableState.value.copy(scrollDirection = ScrollDirection.Down)
        settle("bar hidden") { model.browse.isBarHidden }
        compose.mainClock.advanceTimeBy(500)
        compose.waitForIdle()
        compose.onNodeWithTag(BrowsingTags.TABS).assertDoesNotExist()
        compose.onNodeWithTag(BrowsingTags.PLUS).assertDoesNotExist()

        page.mutableState.value = page.mutableState.value.copy(scrollDirection = ScrollDirection.Up)
        settle("bar restored") { !model.browse.isBarHidden }
        compose.mainClock.advanceTimeBy(500)
        compose.waitForIdle()
        compose.onNodeWithTag(BrowsingTags.TABS).assertExists()
    }

    @Test
    fun barDoesNotHideWhenCollapsesSettingIsDisabled() {
        model.settings.collapsesBottomBar = false
        val page = openPage("https://example.com/")
        assertFalse(model.browse.isBarHidden)

        page.mutableState.value = page.mutableState.value.copy(scrollDirection = ScrollDirection.Down)
        shadowOf(Looper.getMainLooper()).idle()
        compose.mainClock.advanceTimeByFrame()
        assertFalse(model.browse.isBarHidden)
    }

    @Test
    fun barResetsOnTabChange() {
        val page1 = openPage("https://example.com/one")
        page1.mutableState.value = page1.mutableState.value.copy(scrollDirection = ScrollDirection.Down)
        settle("bar hidden tab 1") { model.browse.isBarHidden }
        assertTrue(model.browse.isBarHidden)

        openPage("https://example.com/two")
        settle("bar reset tab 2") { !model.browse.isBarHidden }
        assertFalse(model.browse.isBarHidden)
    }

    @Test
    fun barShowsWhenGoingBackOrResettingScrollDirection() {
        val page = openPage("https://example.com/one")
        page.mutableState.value = page.mutableState.value.copy(scrollDirection = ScrollDirection.Down)
        settle("bar hidden on scroll down") { model.browse.isBarHidden }
        assertTrue(model.browse.isBarHidden)

        page.mutableState.value = page.mutableState.value.copy(scrollDirection = ScrollDirection.Up)
        settle("bar visible on navigation back") { !model.browse.isBarHidden }
        assertFalse(model.browse.isBarHidden)
    }

    @Test
    fun closeAllShowsConfirmationBeforeClosingTabs() {
        openPage("https://example.com/one")
        openPage("https://example.com/two")
        model.showTabSwitcher()
        settle("tab switcher") { model.surface == AppModel.Surface.TabSwitcher }
        compose.waitForIdle()

        val countBefore = model.deckTabs.size
        assertTrue(countBefore >= 2)

        compose.onNodeWithContentDescription("New Tab").performTouchInput { longClick() }
        compose.waitForIdle()
        compose.onNodeWithText("Close All Tabs").performClick()
        compose.waitForIdle()

        assertTrue(model.deck.isConfirmingCloseAll)
        assertEquals(countBefore, model.deckTabs.size)
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()

        assertFalse(model.deck.isConfirmingCloseAll)
        assertEquals(countBefore, model.deckTabs.size)

        compose.onNodeWithContentDescription("New Tab").performTouchInput { longClick() }
        compose.waitForIdle()
        compose.onNodeWithText("Close All Tabs").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Close All Tabs").performClick()
        settle("all tabs closed") { model.deckTabs.isEmpty() }
    }

    @Test
    fun horizontalSwipeAcrossBarSwitchesTabs() {
        openPage("https://example.com/one")
        val firstId = model.tabs.selectedTabId!!
        openPage("https://example.com/two")
        val secondId = model.tabs.selectedTabId!!
        assertEquals(secondId, model.tabs.selectedTabId)

        compose.onNodeWithTag(BrowsingTags.BAR).performTouchInput { swipeRight() }
        compose.mainClock.advanceTimeBy(500)
        settle("switched to previous tab") { model.tabs.selectedTabId == firstId }
        assertEquals(firstId, model.tabs.selectedTabId)
    }

    @Test
    fun choosingTabFromBarCancelsSettlingSwipe() {
        openPage("https://one.example/")
        val firstId = model.tabs.selectedTabId!!
        openPage("https://two.example/")
        val secondId = model.tabs.selectedTabId!!
        openPage("https://three.example/")
        val thirdId = model.tabs.selectedTabId!!
        assertEquals(thirdId, model.tabs.selectedTabId)

        compose.runOnIdle {
            assertTrue(pager.grab())
            pager.track(250f)
            pager.release(2000f)
            assertTrue(pager.isActive)
        }

        compose.onNodeWithTag(BrowsingTags.TABS).performTouchInput { longClick() }
        compose.waitForIdle()
        compose.onNodeWithText("one.example").performClick()
        compose.waitForIdle()

        assertFalse(pager.isActive)
        assertEquals(firstId, model.tabs.selectedTabId)

        compose.mainClock.advanceTimeBy(500)
        settle("settled without override") { true }
        assertEquals(firstId, model.tabs.selectedTabId)

        compose.runOnIdle {
            assertTrue(pager.grab())
            pager.track(-250f)
            pager.release(-2000f)
            assertTrue(pager.isActive)
            pager.stepTab(2)
        }
        compose.mainClock.advanceTimeBy(500)
        settle("stepTab cancels settling swipe") { model.tabs.selectedTabId == thirdId }
        assertFalse(pager.isActive)
        assertEquals(thirdId, model.tabs.selectedTabId)
        assertTrue(secondId != thirdId)
    }
}
