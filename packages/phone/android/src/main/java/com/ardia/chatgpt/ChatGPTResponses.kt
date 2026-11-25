package com.ardia.chatgpt

import org.json.JSONArray
import org.json.JSONObject

data class ChatGPTModel(val slug: String, val displayName: String, val efforts: List<String> = emptyList(), val defaultEffort: String? = null) {
    fun toJson(): JSONObject = JSONObject().put("slug", slug).put("displayName", displayName).put("efforts", JSONArray(efforts)).put("defaultEffort", defaultEffort ?: JSONObject.NULL)

    companion object {
        fun fromJson(value: JSONObject): ChatGPTModel = ChatGPTModel(
            value.getString("slug"), value.getString("displayName"),
            value.optJSONArray("efforts")?.let { array -> List(array.length()) { array.getString(it) } }.orEmpty(),
            value.optNullable("defaultEffort"),
        )

        fun isEffort(value: String): Boolean = value.isNotEmpty() && value.length <= 20 && value.all { it.code < 128 && (it.isLowerCase() || it == '_') }

        fun catalog(body: String): List<ChatGPTModel> {
            val value = runCatching { JSONObject(body) }.getOrNull() ?: throw ChatGPTFailure.Rejected(null)
            value.optJSONArray("models")?.let { models ->
                return List(models.length()) { models.optJSONObject(it) }.filterNotNull().mapNotNull { model ->
                    if (model.opt("visibility") as? String != "list") return@mapNotNull null
                    val slug = (model.opt("slug") as? String)?.trim().orEmpty()
                    if (slug.isEmpty() || slug.length > 200) return@mapNotNull null
                    val name = (model.opt("display_name") as? String)?.trim().orEmpty()
                    val levels = model.optJSONArray("supported_reasoning_levels")?.let { array -> List(array.length()) { array.optJSONObject(it)?.opt("effort") as? String } }.orEmpty().filterNotNull().filter(::isEffort)
                    val efforts = levels.distinct().take(8)
                    val usual = (model.opt("default_reasoning_level") as? String)?.takeIf { it in efforts }
                    ChatGPTModel(slug, if (name.isEmpty()) slug else name.take(200), efforts, usual)
                }
            }
            value.optJSONArray("data")?.let { models ->
                return List(models.length()) { models.optJSONObject(it) }.filterNotNull().mapNotNull { model ->
                    val id = model.opt("id") as? String
                    if (id.isNullOrEmpty()) null else ChatGPTModel(id, id)
                }
            }
            throw ChatGPTFailure.Rejected(null)
        }
    }
}

data class ChatGPTConnection(
    val clientId: String,
    val identity: ChatGPTIdentity,
    val tokens: ChatGPTTokens,
    val endpoints: ChatGPTEndpoints,
    val models: List<ChatGPTModel> = emptyList(),
    val chosenModel: String? = null,
    val chosenEffort: String? = null,
    val pendingTokens: ChatGPTTokens? = null,
) {
    val model: ChatGPTModel? get() = models.firstOrNull { it.slug == chosenModel } ?: models.firstOrNull()

    val effort: String? get() = chosenEffort?.takeIf { model?.efforts?.contains(it) == true }

    fun confirmed(identity: ChatGPTIdentity): ChatGPTConnection {
        if (identity.subject != this.identity.subject) throw ChatGPTFailure.AccountMismatch
        return copy(identity = identity)
    }

    fun toJson(): String = JSONObject()
        .put("clientId", clientId).put("identity", identity.toJson()).put("tokens", tokens.toJson()).put("endpoints", endpoints.toJson())
        .put("models", JSONArray(models.map { it.toJson() })).put("chosenModel", chosenModel ?: JSONObject.NULL).put("chosenEffort", chosenEffort ?: JSONObject.NULL)
        .put("pendingTokens", pendingTokens?.toJson() ?: JSONObject.NULL)
        .toString()

    companion object {
        fun fromJson(text: String): ChatGPTConnection? = runCatching {
            val value = JSONObject(text)
            ChatGPTConnection(
                value.getString("clientId"), ChatGPTIdentity.fromJson(value.getJSONObject("identity")), ChatGPTTokens.fromJson(value.getJSONObject("tokens")),
                ChatGPTEndpoints.fromJson(value.getJSONObject("endpoints")),
                value.optJSONArray("models")?.let { array -> List(array.length()) { ChatGPTModel.fromJson(array.getJSONObject(it)) } }.orEmpty(),
                value.optNullable("chosenModel"), value.optNullable("chosenEffort"),
                value.optJSONObject("pendingTokens")?.let(ChatGPTTokens::fromJson),
            )
        }.getOrNull()
    }
}

object ChatGPTResponses {
    fun body(model: String, instructions: String, prompt: String, effort: String? = null): String {
        val value = JSONObject()
            .put("model", model)
            .put("instructions", instructions)
            .put("input", JSONArray().put(JSONObject().put("role", "user").put("content", prompt)))
            .put("store", false)
            .put("stream", true)
        if (effort != null) value.put("reasoning", JSONObject().put("effort", effort))
        return value.toString()
    }

    sealed class Event {
        data class Delta(val text: String) : Event()
        data object Completed : Event()
        data class Failed(val failure: ChatGPTFailure) : Event()
        data object Incomplete : Event()
        data object Ignored : Event()
    }

    fun event(payload: String, status: Int?): Event {
        val value = runCatching { JSONObject(payload) }.getOrNull() ?: return Event.Ignored
        return when (value.opt("type") as? String) {
            "response.output_text.delta" -> (value.opt("delta") as? String)?.let { Event.Delta(it) } ?: Event.Ignored
            "response.completed" -> Event.Completed
            "response.incomplete" -> Event.Incomplete
            "response.failed", "error" -> Event.Failed(ChatGPTFailure.api(payload, status))
            else -> Event.Ignored
        }
    }
}

class ServerSentEvents {
    private val data = mutableListOf<String>()

    fun feed(line: String): String? {
        if (line.isEmpty()) {
            val joined = if (data.isEmpty()) null else data.joinToString("\n")
            data.clear()
            return joined
        }
        if (line.startsWith(":") || !line.startsWith("data:")) return null
        data += line.removePrefix("data:").removePrefix(" ")
        val joined = data.joinToString("\n")
        if (joined != "[DONE]" && runCatching { org.json.JSONTokener(joined).nextValue() }.isFailure) return null
        data.clear()
        return joined
    }

    fun finish(): String? = feed("")
}
