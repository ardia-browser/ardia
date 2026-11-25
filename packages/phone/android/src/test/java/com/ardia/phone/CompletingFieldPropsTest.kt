package com.ardia.phone

import android.app.Activity
import com.facebook.react.bridge.DynamicFromObject
import com.facebook.react.bridge.JavaOnlyMap
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.AnyViewProp
import expo.modules.kotlin.views.ViewManagerDefinition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CompletingFieldPropsTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @Suppress("UNCHECKED_CAST")
    private fun props(): Map<String, AnyViewProp> {
        val field = ViewManagerDefinition::class.java.getDeclaredField("props").apply { isAccessible = true }
        return CompletingFieldModule().definition().viewManagerDefinitions.values
            .map { field.get(it) as Map<String, AnyViewProp> }
            .first { "highlightColor" in it }
    }

    private val highlight = 0x4D0A84FF
    private val ink = 0xFF1C1C1E.toInt()
    private val placeholderInk = 0x993C3C43.toInt()
    private val cursor = 0xFF0A84FF.toInt()

    private val sentByReactNative: Map<String, Any?> = mapOf(
        "text" to "goo",
        "textEventCount" to 3.0,
        "offer" to JavaOnlyMap.of("query", "goo", "completion", "gle.com"),
        "highlightColor" to highlight.toDouble(),
        "selectsAllOnFocus" to true,
        "placeholder" to "Search or Enter Address",
        "placeholderTextColor" to placeholderInk.toDouble(),
        "color" to ink.toDouble(),
        "cursorColor" to cursor.toDouble(),
        "selectionColor" to highlight.toDouble(),
        "fontSize" to 20.0,
        "fontWeight" to "regular",
        "keyboardType" to "web-search",
        "autoCorrect" to false,
        "autoCapitalize" to "none",
        "returnKeyType" to "go",
        "editable" to true,
        "maxLength" to 2048.0,
        "autoFocus" to true,
        "fieldLabel" to "Search",
        "revealFocus" to 0.0,
    )

    @Test
    fun everyPropTheWrapperSendsIsAcceptedWithTheTypesReactNativeSends() {
        val declared = props()
        val fieldProps = declared.keys.filterNot { it.startsWith("border") || it == "backgroundColor" || it == "boxShadow" }
        assertEquals("each prop the field declares has a value of the type React Native sends in this test", fieldProps.sorted(), sentByReactNative.keys.sorted())
        val view = CompletingFieldView(activity, appContext)
        for ((name, value) in sentByReactNative) declared.getValue(name).set(DynamicFromObject(value), view, appContext)
        for (name in sentByReactNative.keys) declared.getValue(name).set(DynamicFromObject(null), view, appContext)
        for ((name, value) in sentByReactNative) declared.getValue(name).set(DynamicFromObject(value), view, appContext)
        assertEquals(highlight, view.highlightColor)
        assertEquals(ink, view.shownTextColor)
        assertEquals(placeholderInk, view.shownPlaceholderColor)
        assertEquals(cursor, view.shownCursorColor)
        assertEquals(highlight, view.shownSelectionColor)
    }

    @Test
    fun aColourSentAsACssStringIsWhatTheF4Rejected() {
        val view = CompletingFieldView(activity, appContext)
        assertThrows(Exception::class.java) { props().getValue("highlightColor").set(DynamicFromObject("rgba(10, 132, 255, 0.3)"), view, appContext) }
    }
}
