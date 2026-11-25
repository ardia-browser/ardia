package com.ardia.phone

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GlassChildrenTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @Before
    fun shadersStayOut() {
        GlassShaders.reset()
        GlassShaders.makeRim = { throw IllegalArgumentException("no rim in this test") }
        GlassShaders.makeLens = { throw IllegalArgumentException("no lens in this test") }
    }

    @After
    fun restoreShaders() = GlassShaders.reset()

    @Test
    fun aChildThatOverflowsAZeroHeightWrapperStillDrawsInsideTheGlass() {
        val glass = GlassView(activity, appContext).apply { shape = "capsule" }
        val wrapper = FrameLayout(activity).apply { clipChildren = false }
        val glyph = View(activity).apply { setBackgroundColor(Color.BLUE) }
        wrapper.addView(glyph)
        glass.addView(wrapper)
        glass.layout(0, 0, 200, 80)
        wrapper.layout(0, 0, 200, 0)
        glyph.layout(80, 20, 120, 60)
        assertFalse(glass.clipChildren)
        val bitmap = Bitmap.createBitmap(200, 80, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.TRANSPARENT) }
        glass.draw(Canvas(bitmap))
        assertEquals("the host name drawn by a wrapper React Native laid out at zero height", Color.BLUE, bitmap.getPixel(100, 40))
    }
}
