package com.ardia.phone

import android.app.Activity
import android.widget.EditText
import android.widget.FrameLayout
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.DynamicFromObject
import com.facebook.react.uimanager.ThemedReactContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.AnyViewProp
import expo.modules.kotlin.views.ViewManagerDefinition
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
class RevealFocusTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @Suppress("UNCHECKED_CAST")
    private val revealProp: AnyViewProp = run {
        val field = ViewManagerDefinition::class.java.getDeclaredField("props").apply { isAccessible = true }
        CompletingFieldModule().definition().viewManagerDefinitions.values
            .map { field.get(it) as Map<String, AnyViewProp> }
            .first { "revealFocus" in it }
            .getValue("revealFocus")
    }

    private val other = EditText(activity)

    @Suppress("DEPRECATION")
    private val noModules = object : BridgeReactContext(activity) {
        override fun isBridgeless(): Boolean = true

        override fun getNativeModules(): Collection<NativeModule> = emptyList()
    }

    private val reactContext = ThemedReactContext(noModules, activity, null, -1)

    private val view = CompletingFieldView(reactContext, appContext)
    private val editor get() = view.getChildAt(0) as EditText

    init {
        activity.setContentView(FrameLayout(activity).apply {
            addView(other)
            addView(view)
        })
        other.requestFocus()
    }

    private fun reveal(generation: Int?) {
        revealProp.set(DynamicFromObject(generation?.toDouble()), view, appContext)
        view.propsUpdated()
    }

    @Test
    fun aGenerationFocusesOnlyWhenItChanges() {
        assertEquals(RevealFocus.Step.FOCUS, RevealFocus.step(0, 3))
        assertEquals(RevealFocus.Step.NONE, RevealFocus.step(3, 3))
        assertEquals(RevealFocus.Step.FOCUS, RevealFocus.step(3, 4))
        assertEquals(RevealFocus.Step.WITHDRAW, RevealFocus.step(4, 0))
        assertEquals(RevealFocus.Step.NONE, RevealFocus.step(0, 0))
    }

    @Test
    fun theRevealPropFocusesTheEditorInThePropsPassThatAppliesIt() {
        reveal(0)
        assertFalse(editor.isFocused)
        reveal(7)
        assertTrue("the props pass that carries the generation focuses the editor, with no JS focus call", editor.isFocused)
    }

    @Test
    fun aRepeatedGenerationLeavesAFieldTheUserMovedAwayFromAlone() {
        reveal(7)
        other.requestFocus()
        reveal(7)
        assertFalse("an unrelated props pass doesn't pull focus back", editor.isFocused)
    }

    @Test
    fun withdrawingAnUnadoptedRevealBlursAndClearsWhatWasTyped() {
        reveal(7)
        editor.setText("ot")
        editor.setSelection(2)
        reveal(0)
        assertFalse(editor.isFocused)
        assertEquals("", editor.text.toString())
    }

    @Test
    fun aFieldThatWasNeverRevealedIsNotTouchedByAZeroProp() {
        editor.requestFocus()
        editor.setText("kept")
        reveal(0)
        assertTrue(editor.isFocused)
        assertEquals("kept", editor.text.toString())
    }
}
