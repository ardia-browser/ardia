package com.ardia.sync.core

import com.ardia.sync.core.SyncVectors.base64
import com.ardia.sync.core.SyncVectors.base64String
import com.ardia.sync.core.SyncVectors.hex
import com.ardia.sync.core.SyncVectors.objects
import com.ardia.sync.core.SyncVectors.string
import com.ardia.sync.core.SyncVectors.strings
import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncVectorsTest {
    private val inputs = SyncVectors.inputs
    private val expected = SyncVectors.expected
    private val root = SyncVectors.root

    private fun rejects(message: String, body: () -> Unit) {
        assertEquals(message, SyncKeys.Failure.Authentication, assertThrows(message, SyncKeys.Failure::class.java) { body() })
    }

    private fun <T> scratch(body: (File) -> T): T {
        val folder = Files.createTempDirectory("ardia-sync-vectors").toFile()
        try {
            return body(folder)
        } finally {
            folder.deleteRecursively()
        }
    }

    @Test
    fun fixedNoncesReproduceTheCommittedBytes() = scratch { folder ->
        val built = SyncVectors.build(inputs, folder)
        assertEquals(expected.wordlistSha256, built.wordlistSha256)
        assertEquals(expected.chains, built.chains)
        assertEquals(expected.passwords, built.passwords)
        assertEquals(expected.localStates, built.localStates)
        assertEquals(expected.files, built.files)
        assertEquals(expected.damaged, built.damaged)
        assertEquals(expected.pending, built.pending)
        val builtTree = SyncVectors.tree(File(folder, "vault"))
        val committedTree = SyncVectors.tree(File(root, "vault"))
        assertEquals(committedTree.keys.sorted(), builtTree.keys.sorted())
        for ((path, bytes) in committedTree) assertArrayEquals(path, bytes, builtTree.getValue(path))
        val listed = (expected.files + expected.damaged + expected.pending).map { it.path.removePrefix("vault/") }
        assertEquals(committedTree.keys.sorted(), listed.sorted())
    }

    @Test
    fun randomNoncesKeepTheFormatAndOpen() {
        val keys = inputs.keys("ordinary")
        for (name in SyncVectors.vaultPayloads) {
            val plain = inputs.payload(name)
            val sealed = keys.seal(plain, keys.scopeTag("app"), "f")
            val padded = (4 + plain.size + 1023) / 1024 * 1024
            assertEquals(name, 4 + 12 + padded + 16, sealed.size)
            assertArrayEquals(SyncKeys.MAGIC, sealed.copyOf(4))
            assertArrayEquals(plain, keys.open(sealed, keys.scopeTag("app"), "f"))
            assertFalse(keys.seal(plain, keys.scopeTag("app"), "f").contentEquals(sealed))
        }
        scratch { folder ->
            SyncVectors.writeRandomSet(inputs, "kotlin", folder)
            checkRandomSet(folder, "kotlin")
        }
    }

    @Test
    fun phrasesTagsAndWordlistMatch() {
        assertEquals(expected.wordlistSha256, SyncVectors.wordlistDigest())
        assertEquals(2048, Wordlist.english.size)
        assertEquals(inputs.entropies.keys, expected.chains.keys)
        for ((name, chain) in expected.chains) {
            val entropy = inputs.entropies.getValue(name)
            assertEquals(chain.phrase, RecoveryPhrase.words(entropy).joinToString(" "))
            assertArrayEquals(entropy, RecoveryPhrase.entropy(chain.phrase))
            val keys = SyncKeys(entropy)
            assertEquals(chain.chainTag, keys.chainTag)
            assertEquals(inputs.scopes.toSet(), chain.scopeTags.keys)
            for ((scope, tag) in chain.scopeTags) assertEquals(tag, keys.scopeTag(scope))
        }
    }

    @Test
    fun committedSealsOpenToTheirPlaintext() {
        assertEquals(inputs.json.objects("vaultFiles").size, expected.files.size)
        for (file in expected.files) {
            val keys = inputs.keys(file.entropy)
            val sealed = File(root, file.path).readBytes()
            assertArrayEquals(file.path, inputs.payload(file.payload!!), keys.open(sealed, keys.scopeTag(file.scope), file.id))
        }
        assertEquals(inputs.json.objects("localStates").size, expected.localStates.size)
        for (state in expected.localStates) {
            assertArrayEquals(inputs.payload(state.payload), inputs.keys(state.entropy).open(base64(state.sealed), "local", state.fileId))
        }
        assertEquals(inputs.passwords.size * inputs.entropies.size, expected.passwords.size)
        for (login in expected.passwords) {
            assertEquals(login.password, inputs.keys(login.entropy).openPassword(login.sealed, login.origin, login.username))
        }
    }

    @Test
    fun theVaultReadsTheExactInventory() {
        for (entropy in inputs.entropies.keys.sorted()) {
            val vault = SyncVault(FolderStorage(File(root, "vault")), inputs.keys(entropy))
            assertTrue(vault.chainExists())
            for (scope in inputs.scopes) {
                fun mine(entries: List<SyncVectors.Entry>) = entries.filter { it.entropy == entropy && it.scope == scope }
                val listing = vault.read(scope, emptySet())
                assertEquals(mine(expected.files).map { it.id }.sorted(), listing.files.map { it.id }.sorted())
                assertEquals(mine(expected.files).map { inputs.payloads.getValue(it.payload!!) }.sorted(), listing.files.map { base64String(it.payload) }.sorted())
                assertEquals(mine(expected.damaged).map { it.id }.sorted(), listing.damaged.map { it.id }.sorted())
                assertEquals(mine(expected.pending).map { it.id }.sorted(), listing.pending.sorted())
                assertEquals(mine(expected.files + expected.damaged + expected.pending).map { it.id }.sorted(), listing.present.sorted())
            }
        }
        assertTrue(expected.damaged.isNotEmpty())
        assertTrue(expected.pending.isNotEmpty())
        assertTrue(expected.files.any { it.payload == "empty" })
    }

    @Test
    fun damagedTamperedAndWrongContextSealsAreRejected() {
        for (file in expected.damaged) {
            val keys = inputs.keys(file.entropy)
            rejects(file.path) { keys.open(File(root, file.path).readBytes(), keys.scopeTag(file.scope), file.id) }
        }
        for (file in expected.pending) assertEquals(0L, File(root, file.path).length())
        for (file in expected.files) {
            val keys = inputs.keys(file.entropy)
            val other = inputs.keys(inputs.entropies.keys.first { it != file.entropy })
            val otherScope = inputs.scopes.first { it != file.scope }
            val sealed = File(root, file.path).readBytes()
            rejects("scope ${file.path}") { keys.open(sealed, keys.scopeTag(otherScope), file.id) }
            rejects("file id ${file.path}") { keys.open(sealed, keys.scopeTag(file.scope), "state") }
            rejects("chain ${file.path}") { other.open(sealed, other.scopeTag(file.scope), file.id) }
            for (index in listOf(4, 15, 16, 40, sealed.size - 1)) {
                val tampered = sealed.copyOf()
                tampered[index] = (tampered[index].toInt() xor 0x80).toByte()
                rejects("byte $index of ${file.path}") { keys.open(tampered, keys.scopeTag(file.scope), file.id) }
            }
        }
        for (state in expected.localStates) {
            val keys = inputs.keys(state.entropy)
            val sealed = base64(state.sealed)
            rejects("local state file id") { keys.open(sealed, "local", "other") }
            rejects("local state scope") { keys.open(sealed, keys.scopeTag("app"), state.fileId) }
        }
        for (login in expected.passwords) {
            val keys = inputs.keys(login.entropy)
            rejects("origin") { keys.openPassword(login.sealed, login.origin + "x", login.username) }
            rejects("username") { keys.openPassword(login.sealed, login.origin, login.username + "x") }
            val tampered = base64(login.sealed)
            tampered[tampered.size - 1] = (tampered[tampered.size - 1].toInt() xor 1).toByte()
            rejects("tampered password") { keys.openPassword(base64String(tampered), login.origin, login.username) }
        }
    }

    @Test
    fun bothSidesRandomSetsOpen() {
        for (writer in SyncVectors.writers) checkRandomSet(File(root, writer), writer)
    }

    private fun checkRandomSet(folder: File, writer: String) {
        val set = SyncVectors.json(File(folder, "manifest.json"))
        assertEquals(writer, set.string("writer"))
        val entropy = hex(set.string("entropy"))
        assertEquals(32, entropy.size)
        assertEquals(set.string("phrase"), RecoveryPhrase.words(entropy).joinToString(" "))
        assertArrayEquals(entropy, RecoveryPhrase.entropy(set.string("phrase")))
        val keys = SyncKeys(entropy)
        assertEquals(set.string("chainTag"), keys.chainTag)
        val scopeTags = set.strings("scopeTags")
        assertEquals(inputs.scopes.toSet(), scopeTags.keys)
        for ((scope, tag) in scopeTags) assertEquals(tag, keys.scopeTag(scope))
        val files = set.objects("files")
        val vault = SyncVault(FolderStorage(File(folder, "vault")), keys)
        for (scope in inputs.scopes) {
            val mine = files.filter { it.string("scope") == scope }
            assertEquals(SyncVectors.vaultPayloads.sorted(), mine.map { it.string("payload") }.sorted())
            val listing = vault.read(scope, emptySet())
            assertEquals(emptyList<String>(), listing.damaged.map { it.id })
            assertEquals(emptyList<String>(), listing.pending)
            assertEquals(mine.map { it.string("id") }.sorted(), listing.files.map { it.id }.sorted())
            assertEquals(mine.map { inputs.payloads.getValue(it.string("payload")) }.sorted(), listing.files.map { base64String(it.payload) }.sorted())
            for (file in mine) {
                val id = file.string("id")
                assertEquals(SyncVectors.vaultPath(keys, scope, "$id.nns"), file.string("path"))
                val sealed = File(folder, file.string("path")).readBytes()
                assertArrayEquals(SyncKeys.MAGIC, sealed.copyOf(4))
                assertArrayEquals(inputs.payload(file.string("payload")), keys.open(sealed, keys.scopeTag(scope), id))
                rejects("file id $id") { keys.open(sealed, keys.scopeTag(scope), "state") }
            }
        }
        assertEquals(files.map { it.string("path").removePrefix("vault/") }.toSet(), SyncVectors.tree(File(folder, "vault")).keys)
        val login = set.getValue("password").jsonObject
        val (origin, username, password) = listOf("origin", "username", "password").map { login.string(it) }
        assertEquals(password, keys.openPassword(set.string("sealedPassword"), origin, username))
        assertEquals(set.string("sealedPassword"), keys.sealPassword(password, origin, username))
        val local = set.getValue("localState").jsonObject
        val sealedLocal = base64(local.string("sealed"))
        assertArrayEquals(inputs.payload(local.string("payload")), keys.open(sealedLocal, "local", local.string("fileId")))
        rejects("local state file id") { keys.open(sealedLocal, "local", "other") }
    }
}
