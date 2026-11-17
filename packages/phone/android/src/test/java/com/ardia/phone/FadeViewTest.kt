package com.ardia.phone

import android.app.Activity
import android.view.View
import com.facebook.react.bridge.DynamicFromObject
import com.facebook.react.bridge.JavaOnlyMap
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
class FadeViewTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @Test
    fun eachEdgeFadesFromItsFloorAtTheEdgeToFullAlphaLengthPointsInside() {
        val ramps = FadeRamps.of(300f, 100f, 2f, false, top = FadeRamps.Edge(10f, 0.25f), bottom = null, leading = null, trailing = FadeRamps.Edge(14f, 0f))
        assertEquals(2, ramps.size)
        val top = ramps[0]
        assertEquals(FadeRamps.Ramp(0f, 0f, 300f, 20f, 0f, 0f, 0f, 20f, 0.75f), top)
        val trailing = ramps[1]
        assertEquals(FadeRamps.Ramp(272f, 0f, 300f, 100f, 300f, 0f, 272f, 0f, 1f), trailing)
    }

    @Test
    fun leadingAndTrailingFollowTheLayoutDirection() {
        val rightToLeft = FadeRamps.of(300f, 100f, 1f, true, top = null, bottom = null, leading = null, trailing = FadeRamps.Edge(14f, 0f))
        assertEquals(FadeRamps.Ramp(0f, 0f, 14f, 100f, 0f, 0f, 14f, 0f, 1f), rightToLeft.single())
    }

    @Test
    fun noEdgesAZeroLengthOrAFullFloorDrawsNothingAndARampNeverPassesTheView() {
        assertTrue(FadeRamps.of(300f, 100f, 2f, false, null, null, null, null).isEmpty())
        assertTrue(FadeRamps.of(300f, 100f, 2f, false, FadeRamps.Edge(0f, 0f), null, null, null).isEmpty())
        assertTrue(FadeRamps.of(300f, 100f, 2f, false, FadeRamps.Edge(10f, 1f), null, null, null).isEmpty())
        assertEquals(100f, FadeRamps.of(300f, 100f, 2f, false, null, FadeRamps.Edge(500f, 0f), null, null).single().bottom - FadeRamps.of(300f, 100f, 2f, false, null, FadeRamps.Edge(500f, 0f), null, null).single().top)
    }

    @Suppress("UNCHECKED_CAST")
    @Test
    fun theFourEdgePropsTakeWhatReactNativeSendsAndTheViewBecomesALayerOnlyWhileItFades() {
        val field = ViewManagerDefinition::class.java.getDeclaredField("props").apply { isAccessible = true }
        val props = FadeModule().definition().viewManagerDefinitions.values.map { field.get(it) as Map<String, AnyViewProp> }.first { "trailingFade" in it }
        for (layout in listOf("top", "bottom", "left", "right", "start", "end", "width", "height")) {
            assertFalse("$layout is a layout style prop the new architecture hands every view by that name, a number, never a fade edge", layout in props)
        }
        val view = FadeView(activity, appContext)
        props.getValue("trailingFade").set(DynamicFromObject(JavaOnlyMap.of("length", 14.0)), view, appContext)
        props.getValue("topFade").set(DynamicFromObject(JavaOnlyMap.of("length", 8.0, "floor", 0.4)), view, appContext)
        view.update()
        assertEquals(FadeRamps.Edge(14f, 0f), view.trailing)
        assertEquals(FadeRamps.Edge(8f, 0.4f), view.top)
        assertEquals(View.LAYER_TYPE_HARDWARE, view.layerType)
        props.getValue("trailingFade").set(DynamicFromObject(null), view, appContext)
        props.getValue("topFade").set(DynamicFromObject(null), view, appContext)
        view.update()
        assertFalse(view.fades)
        assertEquals(View.LAYER_TYPE_NONE, view.layerType)
    }
}
