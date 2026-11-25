package com.ardia.phone

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract

object FolderNames {
    fun of(resolver: ContentResolver, tree: String): String {
        val fallback = fromId(tree)
        return runCatching {
            val uri = Uri.parse(tree)
            val document = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
            resolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: fallback
    }

    fun fromId(tree: String): String {
        val id = runCatching { DocumentsContract.getTreeDocumentId(Uri.parse(tree)) }.getOrNull() ?: Uri.decode(tree.substringAfterLast('/'))
        return id.substringAfterLast(':').substringAfterLast('/').ifBlank { id }
    }
}
