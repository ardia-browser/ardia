package com.ardia.phone

import android.app.Activity
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LookBudgetTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    private val appContext: AppContext = run {
        val unsafe = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        unsafe.javaClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, AppContext::class.java) as AppContext
    }

    @After
    fun reset() {
        LookBudget.save(activity, """{"version":"t","verdict":"unknown","apply":"full","measuredAt":null,"pendingOver":false,"last":null}""")
        LookBudget.force(activity, null, lab = true)
        LookBudget.forgetForTests()
    }

    @Test
    fun theNativeSideReadsOnlyWhatToApplyAndALabForceWinsOverIt() {
        assertFalse(LookBudget.appliedFrom(null, null))
        assertFalse(LookBudget.appliedFrom("{", null))
        assertTrue(LookBudget.appliedFrom("""{"apply":"degraded"}""", null))
        assertFalse(LookBudget.appliedFrom("""{"apply":"degraded"}""", "full"))
        assertTrue(LookBudget.appliedFrom("""{"apply":"full"}""", "degraded"))
        assertThrows(IllegalStateException::class.java) { LookBudget.force(activity, "degraded", lab = false) }
    }

    @Test
    fun aViewTakesTheVerdictWhenItIsBuiltAndKeepsItWhileShown() {
        LookBudget.save(activity, """{"version":"t","verdict":"fail","apply":"degraded","measuredAt":1,"pendingOver":false,"last":null}""")
        val root = FrameLayout(activity)
        activity.setContentView(root)
        val frost = FrostView(activity, appContext).apply { source = "budget-test-${System.nanoTime()}" }
        val deck = DeckBackdropView(activity, appContext)
        root.addView(frost)
        root.addView(deck)
        assertFalse("a degraded phone's frost is its fill", frost.canBlur())
        assertFalse("a degraded phone's deck stands still", deck.isAnimating)
        LookBudget.save(activity, """{"version":"t","verdict":"pass","apply":"full","measuredAt":2,"pendingOver":false,"last":null}""")
        assertFalse("a verdict that changes mid-session waits for the next build", frost.canBlur())
        val rebuilt = FrostView(activity, appContext).apply { source = frost.source }
        root.addView(rebuilt)
        org.junit.Assert.assertEquals(com.ardia.design.Frosting.isBlurSupported, rebuilt.canBlur())
    }
}
