package com.ardia.phone

import android.app.Activity
import android.graphics.Color
import android.widget.FrameLayout
import android.widget.TextView
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FrostTintTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @Before
    fun reactFlags() = com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()

    @After
    fun reset() = LookSwitch.forgetForTests()

    @Test
    fun aTintedFillIsTheBackdropColourDesaturatedAsTheBlurWouldBeWithTheTintOverIt() {
        val clear = Color.argb(0, 0, 0, 0)
        assertEquals(Color.rgb(200, 100, 50), FrostTint.frosted(Color.rgb(200, 100, 50), 1f, clear))
        val grey = FrostTint.frosted(Color.rgb(200, 100, 50), 0f, clear)
        assertEquals(Color.red(grey), Color.green(grey))
        val half = FrostTint.frosted(Color.rgb(0, 0, 0), 1f, Color.argb(128, 255, 255, 255))
        assertEquals(128f, Color.red(half).toFloat(), 1f)
    }

    private fun <T : android.view.View> T.at(left: Int, top: Int, width: Int, height: Int): T = apply { layout(left, top, left + width, top + height) }

    private fun deckSourceAsTheAppBuildsIt(): Pair<FrostSourceView, DeckBackdropView> {
        val source = FrostSourceView(activity, appContext).at(0, 0, 1080, 2400)
        val base = com.facebook.react.views.view.ReactViewGroup(activity).apply { setBackgroundColor(Color.rgb(240, 200, 220)) }.at(0, 0, 1080, 2400)
        val backdrop = DeckBackdropView(activity, appContext).at(0, 0, 1080, 2400)
        source.addView(base)
        source.addView(backdrop)
        return source to backdrop
    }

    @Test
    fun theDeckSourceAsTheAppMountsItHoldsOnlyTheBackdropBecauseTheColouredBaseIsUnderIt() {
        val (source, backdrop) = deckSourceAsTheAppBuildsIt()
        val found = FrostTint.inspect(source)
        assertEquals(backdrop, found.backdrop)
        assertTrue(found.why, found.why.startsWith("only the deck backdrop shows: 1 view(s) under it"))
        val alone = FrostSourceView(activity, appContext).at(0, 0, 1080, 2400)
        val only = DeckBackdropView(activity, appContext).at(0, 0, 1080, 2400)
        alone.addView(only)
        assertEquals("sync15's shape, with the base beside the source (63001023d)", only, FrostTint.inspect(alone).backdrop)
    }

    @Test
    fun harmlessSiblingsOverTheBackdropDoNotDefeatTheTint() {
        val (source, backdrop) = deckSourceAsTheAppBuildsIt()
        source.addView(com.facebook.react.views.view.ReactViewGroup(activity).at(0, 0, 1080, 2400))
        source.addView(android.view.View(activity).at(0, 0, 10, 10))
        source.addView(TextView(activity).apply { text = "hidden"; visibility = android.view.View.GONE }.at(0, 0, 100, 100))
        source.addView(FilmGrainView(activity, appContext).at(0, 0, 1080, 2400))
        val wrapped = FrostSourceView(activity, appContext).at(0, 0, 1080, 2400)
        val wrapper = FrameLayout(activity).at(0, 0, 1080, 2400)
        val inner = DeckBackdropView(activity, appContext).at(0, 0, 1080, 2400)
        wrapper.addView(inner)
        wrapped.addView(wrapper)
        assertEquals(backdrop, FrostTint.inspect(source).backdrop)
        assertEquals("a plain wrapper around the backdrop still counts", inner, FrostTint.inspect(wrapped).backdrop)
    }

    @Test
    fun anythingThatDrawsOverTheBackdropOrABackdropThatDoesNotCoverTheSourceKeepsTheBlurAndSaysWhy() {
        val (withCards, _) = deckSourceAsTheAppBuildsIt()
        withCards.addView(TextView(activity).apply { text = "card" }.at(0, 0, 300, 100))
        val cards = FrostTint.inspect(withCards)
        assertEquals(null, cards.backdrop)
        assertTrue(cards.why, cards.why.startsWith("TextView 300x100 draws over the deck backdrop"))
        val (tinted, _) = deckSourceAsTheAppBuildsIt()
        tinted.addView(com.facebook.react.views.view.ReactViewGroup(activity).apply { setBackgroundColor(Color.BLACK) }.at(0, 0, 1080, 300))
        assertTrue(FrostTint.inspect(tinted).why.contains("with a background draws over"))
        val short = FrostSourceView(activity, appContext).at(0, 0, 1080, 2400)
        short.addView(DeckBackdropView(activity, appContext).at(0, 0, 1080, 1200))
        assertTrue(FrostTint.inspect(short).why.startsWith("the deck backdrop covers 0,0 to 1080,1200 of 1080x2400"))
        val empty = FrostTint.inspect(FrostSourceView(activity, appContext).at(0, 0, 1080, 2400))
        assertEquals(null, empty.backdrop)
        assertTrue(empty.why.startsWith("no deck backdrop in it"))
    }

    @Test
    fun aFrostOverTheBackdropAloneIsTintedAndNeedsNoRecordingUnlessTheLabAsksForBlur() {
        val tinted = FrostPage.choose(blurSupported = true, reduceTransparency = false, hasSource = true, sourceHasContent = true, hardware = true, insideSource = false, holdsPage = false, pageMode = FrostSources.PageMode.Solid, onlyBackdropUnder = true)
        assertEquals(FrostPage.Path.Tinted, tinted.path)
        val belowAndroid12 = FrostPage.choose(blurSupported = false, reduceTransparency = false, hasSource = true, sourceHasContent = false, hardware = true, insideSource = false, holdsPage = false, pageMode = FrostSources.PageMode.Solid, onlyBackdropUnder = true)
        assertEquals("the fill needs no blur, so older phones get it too", FrostPage.Path.Tinted, belowAndroid12.path)
        val asked = FrostPage.choose(blurSupported = true, reduceTransparency = false, hasSource = true, sourceHasContent = true, hardware = true, insideSource = false, holdsPage = false, pageMode = FrostSources.PageMode.Solid, onlyBackdropUnder = true, blurOverBackdrop = true)
        assertEquals(FrostPage.Path.Live, asked.path)
        val reduced = FrostPage.choose(blurSupported = true, reduceTransparency = true, hasSource = true, sourceHasContent = true, hardware = true, insideSource = false, holdsPage = false, pageMode = FrostSources.PageMode.Solid, onlyBackdropUnder = true)
        assertEquals("Reduce Transparency still wins: a plain fill", FrostPage.Path.Fallback, reduced.path)
        val degraded = FrostPage.choose(blurSupported = true, reduceTransparency = false, budgetDegraded = true, hasSource = true, sourceHasContent = true, hardware = true, insideSource = false, holdsPage = false, pageMode = FrostSources.PageMode.Solid, onlyBackdropUnder = true)
        assertEquals(FrostPage.Path.Fallback, degraded.path)
    }

    @Test
    fun theRestingDeckIsWhatTheDeckDrawsAfterItsBackdropBranch() {
        val root = FrameLayout(activity).at(0, 0, 1080, 2400)
        val backdropBranch = FrameLayout(activity).at(0, 0, 1080, 2400)
        val base = FrameLayout(activity).at(0, 0, 1080, 2400)
        val source = FrostSourceView(activity, appContext).at(0, 0, 1080, 2400)
        val backdrop = DeckBackdropView(activity, appContext).at(0, 0, 1080, 2400)
        source.addView(backdrop)
        backdropBranch.addView(base)
        backdropBranch.addView(source)
        val cards = FrameLayout(activity).at(0, 0, 1080, 2400)
        val bar = FrameLayout(activity).at(0, 2200, 1080, 200)
        val gone = FrameLayout(activity).apply { visibility = android.view.View.GONE }.at(0, 0, 10, 10)
        root.addView(backdropBranch)
        root.addView(cards)
        root.addView(bar)
        root.addView(gone)
        assertEquals("the cards and the bar, not the base under the backdrop or a gone view", listOf<android.view.View>(cards, bar), DeckLayers.restingContent(backdrop))
        val plate = FrameLayout(activity).at(0, 0, 160, 160)
        val frost = FrostView(activity, appContext).at(0, 0, 160, 160)
        val icon = android.view.View(activity).at(40, 40, 80, 80)
        plate.addView(frost)
        plate.addView(icon)
        val label = TextView(activity).at(200, 0, 300, 160)
        bar.addView(plate)
        bar.addView(label)
        assertEquals(
            "a frost's retint must not re-raster a full-screen layer: layers go only on subtrees without a frost",
            listOf<android.view.View>(cards, icon, label),
            DeckLayers.layerable(backdrop),
        )
    }

    @Test
    fun aFrostOffScreenHoldsNoLayerAndAsksNothingOfItsSource() {
        val offScreen = FrostPage.choose(blurSupported = true, reduceTransparency = false, hasSource = true, sourceHasContent = true, hardware = true, insideSource = false, holdsPage = false, pageMode = FrostSources.PageMode.Solid, onScreen = false)
        assertEquals(FrostPage.Path.Fallback, offScreen.path)
        assertEquals(FrostPage.OFF_SCREEN, offScreen.reason)
        val seen = FrostPage.choose(blurSupported = true, reduceTransparency = false, hasSource = true, sourceHasContent = true, hardware = true, insideSource = false, holdsPage = false, pageMode = FrostSources.PageMode.Solid, onScreen = true)
        assertEquals(FrostPage.Path.Live, seen.path)
    }

    @Test
    fun theLabSwitchForBlurOverTheBackdropIsLabOnlyAndOffByDefault() {
        assertFalse(LookSwitch.blurOverBackdrop(activity, lab = true))
        LookSwitch.setBlurOverBackdrop(activity, true, lab = true)
        LookSwitch.forgetForTests()
        assertTrue(LookSwitch.blurOverBackdrop(activity, lab = true))
        assertFalse(LookSwitch.blurOverBackdrop(activity, lab = false))
        LookSwitch.setBlurOverBackdrop(activity, false, lab = true)
    }
}
