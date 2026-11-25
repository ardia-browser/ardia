package com.ardia.sync.core

import java.io.File
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

internal object SyncVectors {
    val vaultPayloads = listOf("log-line", "pattern-1019", "pattern-1020", "pattern-1021", "empty")
    val writers = listOf("swift", "kotlin")

    val root: File by lazy {
        val fixtures = System.getProperty("ardia.syncFixtures") ?: error("ardia.syncFixtures isn't set")
        File(fixtures, "sync-vectors").also { check(File(it, "inputs.json").isFile && File(it, "expected.json").isFile) { "no sync vectors at $it" } }
    }

    val inputs: Inputs by lazy { Inputs(json(File(root, "inputs.json"))) }

    val expected: Built by lazy { Built.parse(json(File(root, "expected.json"))) }

    fun json(file: File): JsonObject = Json.parseToJsonElement(file.readText()).jsonObject

    fun JsonObject.string(key: String): String = getValue(key).jsonPrimitive.content

    fun JsonObject.objects(key: String): List<JsonObject> = getValue(key).jsonArray.map { it.jsonObject }

    fun JsonObject.strings(key: String): Map<String, String> = getValue(key).jsonObject.mapValues { it.value.jsonPrimitive.content }

    fun hex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    fun hexString(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun base64(text: String): ByteArray = Base64.getDecoder().decode(text)

    fun base64String(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun wordlistDigest(): String = hexString(MessageDigest.getInstance("SHA-256").digest(Wordlist.english.joinToString("\n").toByteArray()))

    fun vaultPath(keys: SyncKeys, scope: String, name: String) = "vault/${keys.chainTag}/${keys.scopeTag(scope)}/$name"

    fun tree(folder: File): Map<String, ByteArray> =
        folder.walkTopDown().filter { it.isFile }.associate { it.relativeTo(folder).invariantSeparatorsPath to it.readBytes() }

    class Inputs(val json: JsonObject) {
        val entropies: Map<String, ByteArray> = json.strings("entropies").mapValues { hex(it.value) }
        val scopes: List<String> = json.getValue("scopes").jsonArray.map { it.jsonPrimitive.content }
        val payloads: Map<String, String> = json.strings("payloads")
        val passwords: List<JsonObject> = json.objects("passwords")

        fun keys(entropy: String) = SyncKeys(entropies.getValue(entropy))

        fun payload(name: String) = base64(payloads.getValue(name))
    }

    data class Chain(val phrase: String, val chainTag: String, val scopeTags: Map<String, String>)

    data class SealedLogin(val entropy: String, val origin: String, val username: String, val password: String, val sealed: String)

    data class SealedLocalState(val entropy: String, val fileId: String, val payload: String, val sealed: String)

    data class Entry(val entropy: String, val scope: String, val payload: String?, val id: String, val path: String)

    data class Built(
        val wordlistSha256: String,
        val chains: Map<String, Chain>,
        val passwords: List<SealedLogin>,
        val localStates: List<SealedLocalState>,
        val files: List<Entry>,
        val damaged: List<Entry>,
        val pending: List<Entry>,
    ) {
        companion object {
            private fun entries(json: JsonObject, key: String) = json.objects(key).map {
                Entry(it.string("entropy"), it.string("scope"), it["payload"]?.jsonPrimitive?.content, it.string("id"), it.string("path"))
            }

            fun parse(json: JsonObject): Built {
                val vault = json.getValue("vault").jsonObject
                return Built(
                    json.string("wordlistSha256"),
                    json.getValue("chains").jsonObject.mapValues { (_, chain) ->
                        chain.jsonObject.let { Chain(it.string("phrase"), it.string("chainTag"), it.strings("scopeTags")) }
                    },
                    json.objects("passwords").map { SealedLogin(it.string("entropy"), it.string("origin"), it.string("username"), it.string("password"), it.string("sealed")) },
                    json.objects("localStates").map { SealedLocalState(it.string("entropy"), it.string("fileId"), it.string("payload"), it.string("sealed")) },
                    entries(vault, "files"),
                    entries(vault, "damaged"),
                    entries(vault, "pending"),
                )
            }
        }
    }

    fun build(inputs: Inputs, root: File): Built {
        val storage = FolderStorage(File(root, "vault"))
        val chains = inputs.entropies.mapValues { (_, entropy) ->
            val keys = SyncKeys(entropy)
            Chain(RecoveryPhrase.words(entropy).joinToString(" "), keys.chainTag, inputs.scopes.associateWith { keys.scopeTag(it) })
        }
        val passwords = inputs.entropies.keys.sorted().flatMap { name ->
            inputs.passwords.map { login ->
                val (origin, username, password) = listOf("origin", "username", "password").map { login.string(it) }
                SealedLogin(name, origin, username, password, inputs.keys(name).sealPassword(password, origin, username))
            }
        }
        val localStates = inputs.json.objects("localStates").map { state ->
            val sealed = inputs.keys(state.string("entropy")).seal(inputs.payload(state.string("payload")), "local", state.string("fileId"), hex(state.string("nonce")))
            SealedLocalState(state.string("entropy"), state.string("fileId"), state.string("payload"), base64String(sealed))
        }
        val files = inputs.json.objects("vaultFiles").map { file ->
            val keys = inputs.keys(file.string("entropy"))
            val vault = SyncVault(storage, keys)
            vault.createChain()
            vault.write(file.string("scope"), inputs.payload(file.string("payload")), file.string("id"), hex(file.string("nonce")))
            Entry(file.string("entropy"), file.string("scope"), file.string("payload"), file.string("id"), vaultPath(keys, file.string("scope"), "${file.string("id")}.nns"))
        }
        val damaged = inputs.json.objects("damaged").map { file ->
            val keys = inputs.keys(file.string("entropy"))
            val sealed = keys.seal(inputs.payload(file.string("payload")), keys.scopeTag(file.string("scope")), file.string("id"), hex(file.string("nonce")))
            val flip = file.string("flipByte").toInt()
            sealed[flip] = (sealed[flip].toInt() xor 1).toByte()
            val path = vaultPath(keys, file.string("scope"), "${file.string("id")}.nns")
            File(root, path).apply { parentFile.mkdirs() }.writeBytes(sealed)
            Entry(file.string("entropy"), file.string("scope"), file.string("payload"), file.string("id"), path)
        }
        val pending = inputs.json.objects("pending").map { file ->
            val path = vaultPath(inputs.keys(file.string("entropy")), file.string("scope"), ".${file.string("id")}.nns.icloud")
            File(root, path).apply { parentFile.mkdirs() }.writeBytes(ByteArray(0))
            Entry(file.string("entropy"), file.string("scope"), null, file.string("id"), path)
        }
        return Built(wordlistDigest(), chains, passwords, localStates, files, damaged, pending)
    }

    fun writeRandomSet(inputs: Inputs, writer: String, folder: File) {
        folder.deleteRecursively()
        val entropy = RecoveryPhrase.generateEntropy()
        val keys = SyncKeys(entropy)
        val vault = SyncVault(FolderStorage(File(folder, "vault")), keys)
        vault.createChain()
        val files = inputs.scopes.flatMap { scope ->
            vaultPayloads.map { name ->
                val id = vault.write(scope, inputs.payload(name))
                buildJsonObject {
                    put("id", id)
                    put("path", vaultPath(keys, scope, "$id.nns"))
                    put("payload", name)
                    put("scope", scope)
                }
            }
        }
        val login = inputs.passwords[1]
        val (origin, username, password) = listOf("origin", "username", "password").map { login.string(it) }
        val manifest = buildJsonObject {
            put("chainTag", keys.chainTag)
            put("entropy", hexString(entropy))
            put("files", buildJsonArray { files.forEach { add(it) } })
            put("localState", buildJsonObject {
                put("entropy", "random")
                put("fileId", "state")
                put("payload", "local-state")
                put("sealed", base64String(keys.seal(inputs.payload("local-state"), "local", "state")))
            })
            put("password", login)
            put("phrase", RecoveryPhrase.words(entropy).joinToString(" "))
            put("scopeTags", buildJsonObject { inputs.scopes.forEach { put(it, keys.scopeTag(it)) } })
            put("sealedPassword", keys.sealPassword(password, origin, username))
            put("writer", writer)
        }
        File(folder, "manifest.json").writeText(Json { prettyPrint = true }.encodeToString(JsonElement.serializer(), manifest) + "\n")
    }
}
