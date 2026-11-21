package com.ardia.phone

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.widget.FrameLayout
import android.widget.LinearLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScreenReaderFocusTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().visible().get()

    private val row = View(activity).apply {
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = "Archive"
    }

    @Before
    fun screenReaderOn() {
        val manager = activity.getSystemService(AccessibilityManager::class.java)
        shadowOf(manager).setEnabled(true)
        shadowOf(manager).setTouchExplorationEnabled(true)
    }

    @Test
    fun aViewThatIsMissingOrNotYetLaidOutIsNotFocusedSoTheModuleWaitsAFrameAndTriesAgain() {
        assertFalse(ScreenReaderFocus.focus(null))
        assertFalse(ScreenReaderFocus.focus(row))
    }

    @Test
    fun aLaidOutViewIsAskedForTheScreenReadersFocusWithTheAccessibilityFocusAction() {
        val asked = mutableListOf<Int>()
        val target = recording(asked)
        assertFalse("a view not yet attached waits", ScreenReaderFocus.focus(target))
        assertTrue("nothing is asked of a view that isn't ready", asked.isEmpty())
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        layOut()
        assertTrue("an attached view", target.isAttachedToWindow)
        assertTrue("a laid-out view", target.isLaidOut)
        assertTrue("an attached, laid-out view is ready", ScreenReaderFocus.ready(target))
        assertTrue(ScreenReaderFocus.focus(target))
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS), asked)
    }

    @Test
    fun aViewUnderAHiddenOverlayOrNotImportantIsNeverFocused() {
        val asked = mutableListOf<Int>()
        val target = recording(asked)
        val closing = FrameLayout(activity).apply { addView(target, 200, 100) }
        activity.setContentView(closing)
        layOut()
        closing.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        assertFalse("under a parent hiding its descendants", ScreenReaderFocus.focus(target))
        closing.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        target.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        assertFalse("not important for accessibility", ScreenReaderFocus.focus(target))
        target.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        target.visibility = View.INVISIBLE
        assertFalse("not visible", ScreenReaderFocus.focus(target))
        assertTrue(asked.isEmpty())
    }

    @Test
    fun aRequestRetriesOnTheMainHandlerUntilItsViewIsReadyAndEndsThere() {
        val asked = mutableListOf<Int>()
        val target = recording(asked)
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        requests.start {
            looked += 1
            if (looked < 3) null else target
        }
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        layOut()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS), asked)
        assertEquals(0, requests.waiting)
        assertEquals(3, looked)
    }

    @Test
    fun anAttemptPastTheDeadlineGivesUpWithoutLookingForOrFocusingTheView() {
        val asked = mutableListOf<Int>()
        val target = recording(asked)
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        layOut()
        var now = 0L
        var ready = false
        var looked = 0
        val requests = FocusRequests(Handler(Looper.getMainLooper()), { now })
        requests.start {
            looked += 1
            if (ready) target else null
        }
        assertEquals(1, looked)
        now = FocusRequests.GIVE_UP_AFTER_MS + 12
        ready = true
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals(1, looked)
        assertTrue("past its deadline a request focuses nothing", asked.isEmpty())
        assertEquals(0, requests.waiting)
        now = 0L
        val inTime = FocusRequests(Handler(Looper.getMainLooper()), { now })
        ready = false
        inTime.start { if (ready) target else null }
        now = FocusRequests.GIVE_UP_AFTER_MS - 4
        ready = true
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS), asked)
        assertEquals(0, inTime.waiting)
    }

    @Test
    fun aReturnedFocusIsAskedOnceMoreAfterItLandsOnlyIfTheViewLostItAndNeverAfterACancelOrWithoutALanding() {
        val asked = mutableListOf<Int>()
        var held = false
        val target = holding(asked) { held }
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        layOut()
        val looper = shadowOf(Looper.getMainLooper())
        val focusAction = AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)

        requests.start(recheck = true) { target }
        assertEquals("the first ask lands at once", listOf(focusAction), asked)
        held = true
        looper.idleFor(Duration.ofMillis(FocusRequests.RECHECK_AFTER_MS + 100))
        assertEquals("focus stayed, so nothing is asked again", listOf(focusAction), asked)
        assertEquals(0, requests.waiting)

        asked.clear()
        held = false
        requests.start(recheck = true) { target }
        looper.idleFor(Duration.ofMillis(FocusRequests.RECHECK_AFTER_MS - 50))
        assertEquals("nothing more before the window ends", listOf(focusAction), asked)
        looper.idleFor(Duration.ofMillis(100))
        assertEquals("focus was taken, so it is asked once more", listOf(focusAction, focusAction), asked)
        looper.idleFor(Duration.ofSeconds(1))
        assertEquals("and only once", 2, asked.size)
        assertEquals(0, requests.waiting)

        asked.clear()
        val id = requests.start(recheck = true) { target }
        requests.cancel(id)
        looper.idleFor(Duration.ofSeconds(1))
        assertEquals("a cancel drops the second ask", listOf(focusAction), asked)

        asked.clear()
        requests.start(recheck = true) { null }
        looper.idleFor(Duration.ofSeconds(2))
        assertTrue("a first ask that never landed asks nothing again", asked.isEmpty())
        assertEquals(0, requests.waiting)

        requests.start { target }
        looper.idleFor(Duration.ofSeconds(1))
        assertEquals("a plain focus never asks again", listOf(focusAction), asked)
    }

    @Test
    fun theSecondAskLeavesAMoveToAnotherNodeAndRestoresFocusThatWentToTheFirstStopOrNowhere() {
        val asked = mutableListOf<Int>()
        var focusOn = "none"
        val header = stop("Space, Personal") { focusOn == "header" }
        val target = holding(asked) { focusOn == "target" }
        val next = stop("Incognito") { focusOn == "next" }
        val screen = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            addView(header, 200, 100)
            addView(target, 200, 100)
            addView(next, 200, 100)
        }
        activity.setContentView(screen)
        layOut()
        assertTrue(ScreenReaderFocus.firstStop(screen) === header)
        val looper = shadowOf(Looper.getMainLooper())
        val focusAction = AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis) { screen }
        fun afterTheFirstAskFocusMovesTo(place: String): Int {
            asked.clear()
            focusOn = "none"
            requests.start(recheck = true) { target }
            assertEquals(listOf(focusAction), asked)
            focusOn = place
            looper.idleFor(Duration.ofMillis(FocusRequests.RECHECK_AFTER_MS + 100))
            assertEquals(0, requests.waiting)
            return asked.size
        }
        assertEquals("focus on the first stop is restored, whether TalkBack's reset or, by design, a user's own move there", 2, afterTheFirstAskFocusMovesTo("header"))
        assertEquals("focus held by nothing is returned", 2, afterTheFirstAskFocusMovesTo("none"))
        assertEquals("a user's move to the next node is left alone", 1, afterTheFirstAskFocusMovesTo("next"))
        assertEquals("focus that stayed needs nothing", 1, afterTheFirstAskFocusMovesTo("target"))
        header.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        assertTrue("a hidden node is never the first stop", ScreenReaderFocus.firstStop(screen) === next)
    }

    @Test
    fun firstStopGeometryTakesTheTopmostStopThenTheLeftmostInLeftToRightAndTheRightmostInRightToLeftWhateverTheTreeOrder() {
        val deck = FrameLayout(activity)
        val card = stop("Lisbon - Wikipedia") { false }
        val left = stop("Space, Personal") { false }
        val right = stop("More") { false }
        val at = { top: Int, start: Int, width: Int, height: Int -> FrameLayout.LayoutParams(width, height, Gravity.TOP or Gravity.LEFT).apply { topMargin = top; leftMargin = start } }
        deck.addView(card, at(100, 0, 200, 100))
        deck.addView(left, at(10, 10, 100, 40))
        deck.addView(right, at(10, 200, 60, 40))
        activity.setContentView(deck)
        layOut()
        assertTrue("left to right: the card comes first in the tree, the top-left stop is first on screen", ScreenReaderFocus.firstStop(deck) === left)
        assertTrue("right to left: the top-right stop is first, as Space sits on the right", ScreenReaderFocus.firstStop(deck, rightToLeft = true) === right)
    }

    @Test
    fun focusOnAVirtualNodeOfAPageIsTheUsersSoARestoreLeavesItUnlessThePageIsHidden() {
        val asked = mutableListOf<Int>()
        var linkFocused = false
        var hiddenLinkFocused = false
        val deck = FrameLayout(activity)
        val header = stop("Space, Personal") { false }
        var targetHeld = false
        val target = holding(asked) { targetHeld }
        val shownPage = page { linkFocused }
        val closing = FrameLayout(activity).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }
        closing.addView(page { hiddenLinkFocused }, 100, 40)
        val at = { top: Int, start: Int, width: Int, height: Int -> FrameLayout.LayoutParams(width, height, Gravity.TOP or Gravity.LEFT).apply { topMargin = top; leftMargin = start } }
        deck.addView(header, at(10, 10, 100, 40))
        deck.addView(target, at(10, 200, 60, 40))
        deck.addView(shownPage, at(100, 0, 300, 200))
        deck.addView(closing, at(320, 0, 100, 40))
        activity.setContentView(deck)
        layOut()
        assertFalse("the page's host doesn't report the focus itself", ScreenReaderFocus.holds(shownPage))
        val looper = shadowOf(Looper.getMainLooper())
        val focusAction = AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis) { deck }
        fun restore(): List<Int> {
            asked.clear()
            targetHeld = false
            requests.start(recheck = true) { target }
            targetHeld = asked.isNotEmpty()
            looper.idleFor(Duration.ofSeconds(1))
            return asked.toList()
        }
        linkFocused = true
        assertEquals("a user reading a link on the page is left there", emptyList<Int>(), restore())
        linkFocused = false
        hiddenLinkFocused = true
        assertEquals("a link focused in a hidden layer doesn't hold the user", listOf(focusAction), restore())
        hiddenLinkFocused = false
        targetHeld = false
        asked.clear()
        requests.start(recheck = true) { target }
        assertEquals(listOf(focusAction), asked)
        linkFocused = true
        looper.idleFor(Duration.ofSeconds(1))
        assertEquals("a move into the page after the first ask isn't undone", listOf(focusAction), asked)
    }

    @Test
    fun aRestoresFirstAskAndItsRetriesLeaveAUserWhoHasAlreadyMovedAndGoAheadOnlyFromTheResetANothingAClosingLayerOrTheTargetItself() {
        val asked = mutableListOf<Int>()
        var focusOn = "none"
        val deck = FrameLayout(activity)
        val card = stop("Lisbon - Wikipedia") { focusOn == "card" }
        val header = stop("Space, Personal") { focusOn == "header" }
        val target = holding(asked) { focusOn == "target" }
        val next = stop("Incognito") { focusOn == "next" }
        val closing = FrameLayout(activity).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS }
        val closingRow = stop("Archive") { focusOn == "closing" }
        closing.addView(closingRow, 100, 40)
        deck.addView(card, FrameLayout.LayoutParams(200, 100).apply { topMargin = 100 })
        deck.addView(header, FrameLayout.LayoutParams(100, 40).apply { topMargin = 10; leftMargin = 10 })
        deck.addView(target, FrameLayout.LayoutParams(60, 40).apply { topMargin = 10; leftMargin = 200 })
        deck.addView(next, FrameLayout.LayoutParams(100, 40).apply { topMargin = 250 })
        deck.addView(closing, FrameLayout.LayoutParams(100, 40).apply { topMargin = 320 })
        activity.setContentView(deck)
        layOut()
        assertTrue("the target can take focus", ScreenReaderFocus.reachable(target))
        assertTrue("the next node is on screen", ScreenReaderFocus.reachable(next))
        assertTrue(ScreenReaderFocus.firstStop(deck) === header)
        val looper = shadowOf(Looper.getMainLooper())
        val focusAction = AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis) { deck }
        fun askedWhileFocusIsOn(place: String): List<Int> {
            asked.clear()
            focusOn = place
            requests.start(recheck = true) { target }
            if (asked.isNotEmpty()) focusOn = "target"
            looper.idleFor(Duration.ofSeconds(1))
            assertEquals(0, requests.waiting)
            return asked.toList()
        }
        assertEquals("a user already on the next node is left there", emptyList<Int>(), askedWhileFocusIsOn("next"))
        assertEquals("a user on a card is left there", emptyList<Int>(), askedWhileFocusIsOn("card"))
        assertEquals("TalkBack's reset to the first stop is taken back", listOf(focusAction), askedWhileFocusIsOn("header"))
        assertEquals("focus nowhere is taken", listOf(focusAction), askedWhileFocusIsOn("none"))
        assertEquals("focus still in the closing layer is taken", listOf(focusAction), askedWhileFocusIsOn("closing"))
        assertEquals("focus already on the target lands with nothing to do", emptyList<Int>(), askedWhileFocusIsOn("target"))

        asked.clear()
        focusOn = "none"
        var ready = false
        requests.start(recheck = true) { if (ready) target else null }
        looper.idleFor(Duration.ofMillis(50))
        focusOn = "next"
        ready = true
        looper.idleFor(Duration.ofSeconds(1))
        assertTrue("a retry that finds the user moved on gives up", asked.isEmpty())
        assertEquals(0, requests.waiting)

        asked.clear()
        focusOn = "next"
        requests.start { target }
        looper.idleFor(Duration.ofSeconds(1))
        assertEquals("focus into a menu's first row is not a restore and goes ahead", listOf(focusAction), asked)
    }

    @Test
    fun aCancelledRequestNeverLooksAgain() {
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        val id = requests.start {
            looked += 1
            null
        }
        requests.cancel(id)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(1, looked)
        assertEquals(0, requests.waiting)
    }

    @Test
    fun aRequestGivesUpAfterItsTimeAndTeardownDropsEveryRequest() {
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        requests.start {
            looked += 1
            null
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        assertEquals(0, requests.waiting)
        val tries = looked
        assertTrue(tries > 1)
        requests.start { null }
        requests.start { null }
        assertEquals(2, requests.waiting)
        requests.cancelAll()
        assertEquals(0, requests.waiting)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(tries, looked)
    }

    @Test
    fun destroyingFromAnotherThreadWhileARequestRetriesStopsItThereAndRefusesNewOnes() {
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        requests.start {
            looked += 1
            null
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(40))
        val before = looked
        var failure: Throwable? = null
        val teardown = Thread {
            try {
                requests.destroy()
            } catch (thrown: Throwable) {
                failure = thrown
            }
        }
        teardown.start()
        teardown.join()
        assertEquals(null, failure)
        assertTrue(requests.destroyed)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(before, looked)
        assertEquals(0, requests.waiting)
        assertEquals(0, requests.start { looked += 1; null })
        assertEquals(before, looked)
    }

    @Test
    fun aViewThatAlreadyHoldsTheScreenReadersFocusCountsAsLandedWithoutBeingAskedAgainSoARepeatedRequestEndsAtOnce() {
        val asked = mutableListOf<Int>()
        val target = recording(asked, focused = true)
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        layOut()
        assertTrue(ScreenReaderFocus.holds(target))
        assertTrue(ScreenReaderFocus.focus(target))
        assertTrue("a view that has the focus isn't asked for it again", asked.isEmpty())
        val other = recording(asked)
        (target.parent as FrameLayout).addView(other, 200, 100)
        layOut()
        assertFalse(ScreenReaderFocus.holds(other))
        assertTrue(ScreenReaderFocus.focus(other))
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS), asked)
    }

    @Test
    fun anAnnouncementReachesTheScreenReaderAsAnAnnouncementEvent() {
        activity.setContentView(FrameLayout(activity).apply { addView(row, 200, 100) })
        shadowOf(Looper.getMainLooper()).idle()
        val manager = activity.getSystemService(AccessibilityManager::class.java)
        ScreenReaderFocus.announce(activity.window.decorView, "Close 3 Tabs? They’ll stay in your Archive.")
        assertTrue(shadowOf(manager).sentAccessibilityEvents.any { it.eventType == AccessibilityEvent.TYPE_ANNOUNCEMENT && it.text.joinToString().contains("Close 3 Tabs?") })
    }

    private fun recording(asked: MutableList<Int>, focused: Boolean = false): View = object : View(activity) {
        init {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
            super.onInitializeAccessibilityNodeInfo(info)
            if (focused) info.isAccessibilityFocused = true
        }

        override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
            asked += action
            return action == AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
        }
    }

    private fun holding(asked: MutableList<Int>, held: () -> Boolean): View = object : View(activity) {
        init {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
            super.onInitializeAccessibilityNodeInfo(info)
            if (held()) info.isAccessibilityFocused = true
        }

        override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
            asked += action
            return action == AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
        }
    }

    private fun stop(label: String, held: () -> Boolean): View = object : View(activity) {
        init {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
            contentDescription = label
        }

        override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
            super.onInitializeAccessibilityNodeInfo(info)
            if (held()) info.isAccessibilityFocused = true
        }
    }

    private fun page(linkFocused: () -> Boolean): View = object : View(activity) {
        private val links = object : AccessibilityNodeProvider() {
            override fun findFocus(focus: Int): AccessibilityNodeInfo? =
                if (focus == AccessibilityNodeInfo.FOCUS_ACCESSIBILITY && linkFocused()) AccessibilityNodeInfo().apply { isVisibleToUser = true } else null
        }

        init {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        override fun getAccessibilityNodeProvider(): AccessibilityNodeProvider = links
    }

    private fun layOut() {
        shadowOf(Looper.getMainLooper()).idle()
        val decor = activity.window.decorView
        decor.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
        decor.layout(0, 0, 1080, 2400)
    }
}
