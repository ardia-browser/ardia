package com.ardia.phone

import com.ardia.phone.NativeMenuRules.Action
import com.ardia.phone.NativeMenuRules.ActionSheetActionShape
import com.ardia.phone.NativeMenuRules.Header
import com.ardia.phone.NativeMenuRules.MenuItemShape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeMenuRulesTest {
    @Test
    fun plainItemsShareTheFirstGroupInTheirOrder() {
        val rows = NativeMenuRules.rows(listOf(MenuItemShape("0", "Copy Link"), MenuItemShape("1", "Share")))
        assertEquals(listOf("Copy Link", "Share"), rows.map { (it as Action).item.title })
        assertEquals(setOf(0), rows.map { it.group }.toSet())
    }

    @Test
    fun anInlineGroupBecomesItsOwnDividedGroupWithItsTitleAsAHeader() {
        val rows = NativeMenuRules.rows(
            listOf(
                MenuItemShape("0", "New Tab"),
                MenuItemShape("g1", "Spaces", inline = true, children = listOf(MenuItemShape("1", "Work", checked = true), MenuItemShape("2", "Home"))),
                MenuItemShape("3", "Close All", destructive = true),
            ),
        )
        assertEquals(Header("Spaces", 1), rows[1])
        assertEquals(listOf(1, 1), rows.subList(2, 4).map { it.group })
        assertTrue((rows[2] as Action).item.checked)
        val last = rows.last() as Action
        assertTrue("what follows a group starts another", last.group > 1)
        assertTrue(last.item.destructive)
    }

    @Test
    fun anUntitledInlineGroupIsOnlyADivider() {
        val rows = NativeMenuRules.rows(listOf(MenuItemShape("g0", "", inline = true, children = listOf(MenuItemShape("1", "Reopen")))))
        assertFalse(rows.any { it is Header })
    }

    @Test
    fun aSubmenuKeepsItsChildren() {
        val rows = NativeMenuRules.rows(listOf(MenuItemShape("0", "Send to Device", children = listOf(MenuItemShape("0.0", "Studio"), MenuItemShape("0.1", "MacBook", disabled = true)))))
        val submenu = (rows.single() as Action).item
        assertEquals(listOf("0.0", "0.1"), submenu.children!!.map { (it as Action).item.id })
        assertTrue((submenu.children!![1] as Action).item.disabled)
    }

    @Test
    fun aConfirmationIsAButtonAndCancelAndALongerChoiceIsAList() {
        val confirm = NativeMenuRules.sheet(listOf(ActionSheetActionShape("confirm", "Close All Tabs", destructive = true), ActionSheetActionShape("cancel", "Cancel", cancel = true)))
        assertEquals(listOf("confirm"), confirm.buttons.map { it.id })
        assertEquals("Cancel", confirm.cancelTitle)
        val longer = NativeMenuRules.sheet(listOf(ActionSheetActionShape("a", "One"), ActionSheetActionShape("b", "Two"), ActionSheetActionShape("c", "Three")))
        assertEquals(listOf("a", "b", "c"), longer.listed.map { it.id })
        assertEquals("a sheet without its own Cancel gets one", "Cancel", longer.cancelTitle)
    }

    @Test
    fun aMenusHeightCountsItsRowsGroupDividersAndPadding() {
        val rows = NativeMenuRules.rows(
            listOf(
                MenuItemShape("0", "Copy Link"),
                MenuItemShape("g1", "Spaces", inline = true, children = listOf(MenuItemShape("1", "Work"), MenuItemShape("2", "Home"))),
                MenuItemShape("3", "Close Tab", destructive = true),
            ),
        )
        assertEquals("5 rows (a header and four actions), 2 dividers between 3 groups, padding top and bottom", 5 * 132 + 2 * 25 + 2 * 22, NativeMenuRules.estimatedHeight(rows, 132, 25, 22))
    }

    @Test
    fun aMenuThatWouldRunUnderTheNavigationBarOpensHigherAndNeverAboveTheStatusBar() {
        assertEquals("room below: the menu opens at the press", 1200, NativeMenuRules.anchorTop(1200, 700, 80, 2248))
        assertEquals("the F4's deck card: Close Tab ended under the 3-button bar at 2270", 2248 - 700, NativeMenuRules.anchorTop(1700, 700, 80, 2248))
        assertEquals("taller than the room: it starts under the status bar", 80, NativeMenuRules.anchorTop(1700, 2400, 80, 2248))
    }

    @Test
    fun aMenuKeepsTheBarsSideInsetFromTheScreenEdgeAndOpensTowardTheMiddle() {
        val left = 33
        val right = 1080 - 33
        assertEquals("the deck's More, at the right edge: the menu's right edge sits on the inset", NativeMenuRules.Across(right, true), NativeMenuRules.across(986, 1080, left, right))
        assertEquals("a long press in the left half opens rightward from the press", NativeMenuRules.Across(430, false), NativeMenuRules.across(430, 430, left, right))
        assertEquals("a long press near the right edge opens leftward from the inset", NativeMenuRules.Across(right, true), NativeMenuRules.across(1070, 1070, left, right))
        assertEquals("a trigger at the left edge keeps the inset too", NativeMenuRules.Across(left, false), NativeMenuRules.across(0, 120, left, right))
    }

    @Test
    fun androidsOwnMenusAreTheDefaultAndOnlyTheLabArgumentBringsBackTheDrawnOnes() {
        assertTrue(NativeMenuRules.nativeMenus(emptyMap()))
        assertFalse(NativeMenuRules.nativeMenus(mapOf("ArdiaDrawnMenus" to true)))
        assertTrue("a store build ignores launch arguments", NativeMenuRules.nativeMenus(LaunchExtras.arguments(mapOf("ArdiaDrawnMenus" to true), allowed = false)))
    }
}
