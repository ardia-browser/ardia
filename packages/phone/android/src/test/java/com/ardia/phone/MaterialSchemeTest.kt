package com.ardia.phone

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MaterialSchemeTest {
    private fun colourGetters(): Set<String> = ColorScheme::class.java.methods
        .filter { it.parameterCount == 0 && it.returnType == Long::class.javaPrimitiveType && it.name.startsWith("get") && it.name.contains("-") }
        .map { method -> method.name.removePrefix("get").substringBefore('-').replaceFirstChar(Char::lowercaseChar) }
        .filterNot { it.contains("Fixed") }
        .toSet()

    @Test
    fun theKeysAreComposesColorSchemeRolesWithoutTheFixedSet() {
        val keys = MaterialScheme.roles(lightColorScheme()).keys
        assertEquals(colourGetters(), keys)
        assertEquals(36, keys.size)
    }

    @Test
    fun theSchemeTheAppPassesWinsRoleByRoleOverTheBase() {
        val scheme = MaterialScheme.withRoles(lightColorScheme(), mapOf("primary" to "#123456", "error" to "#ABCDEF", "surface" to "nonsense"))
        val roles = MaterialScheme.roles(scheme)
        assertEquals("#123456", roles["primary"])
        assertEquals("#ABCDEF", roles["error"])
        assertEquals(MaterialScheme.roles(lightColorScheme())["surface"], roles["surface"])
    }

    @Test
    @Config(sdk = [30])
    fun belowAndroid12MenusUseArdiasSeededFallbackInBothModes() {
        val app = RuntimeEnvironment.getApplication()
        assertEquals(MaterialFallback.light, MaterialScheme.roles(MaterialScheme.colorScheme(app, dark = false, given = null)))
        assertEquals(MaterialFallback.dark, MaterialScheme.roles(MaterialScheme.colorScheme(app, dark = true, given = null)))
        assertEquals(36, MaterialFallback.light.size)
        assertEquals(MaterialFallback.light.keys, MaterialFallback.dark.keys)
    }

    @Test
    fun anOpenDialogFollowsTheWallpaperOnlyWhenItWasGivenTheWallpapersScheme() {
        val wallpaper = darkColorScheme(primary = Color(0xFF535A92))
        assertTrue("no scheme from JS", MaterialScheme.followsWallpaper(null, wallpaper))
        assertTrue("JS passed the wallpaper's own scheme", MaterialScheme.followsWallpaper(mapOf("primary" to "#535a92"), wallpaper))
        assertFalse("a profile colour seeded the scheme", MaterialScheme.followsWallpaper(mapOf("primary" to "#894A67"), wallpaper))
    }

    @Test
    fun valuesAreHexWithoutAlpha() {
        val roles = MaterialScheme.roles(darkColorScheme(primary = Color(0x80123456)))
        assertEquals("#123456", roles["primary"])
        assertTrue(roles.values.all { Regex("#[0-9A-F]{6}").matches(it) })
    }

    @Test
    @Config(sdk = [30])
    fun belowAndroid12ThereIsNoDynamicScheme() {
        assertNull(MaterialScheme.of(RuntimeEnvironment.getApplication()))
    }

    @Test
    fun fromAndroid12TheSchemeHasEveryRoleForLightAndDark() {
        val schemes = MaterialScheme.of(RuntimeEnvironment.getApplication())!!
        assertEquals(setOf("light", "dark"), schemes.keys)
        assertEquals(36, schemes["light"]!!.size)
        assertEquals(36, schemes["dark"]!!.size)
    }
}
