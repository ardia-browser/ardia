package com.ardia.phone

import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore

internal object DownloadedFiles {
    val folder: String = Environment.DIRECTORY_DOWNLOADS + "/"

    data class Row(val id: Long, val name: String, val size: Long, val modifiedSeconds: Long, val mime: String?, val relativePath: String?, val pending: Boolean, val owner: String?)

    private val archiveTypes = setOf(
        "application/zip", "application/x-zip-compressed", "application/gzip", "application/x-gzip", "application/x-tar", "application/x-7z-compressed",
        "application/x-rar-compressed", "application/vnd.rar", "application/x-bzip2", "application/x-xz",
    )
    private val archiveEndings = setOf("zip", "gz", "tgz", "tar", "7z", "rar", "bz2", "xz")
    private val imageEndings = setOf("jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg", "avif")
    private val videoEndings = setOf("mp4", "m4v", "mov", "webm", "mkv", "3gp", "avi")
    private val audioEndings = setOf("mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac")
    private val columns = arrayOf(
        MediaStore.MediaColumns._ID,
        MediaStore.MediaColumns.DISPLAY_NAME,
        MediaStore.MediaColumns.SIZE,
        MediaStore.MediaColumns.DATE_MODIFIED,
        MediaStore.MediaColumns.MIME_TYPE,
        MediaStore.MediaColumns.RELATIVE_PATH,
        MediaStore.MediaColumns.IS_PENDING,
        MediaStore.MediaColumns.OWNER_PACKAGE_NAME,
    )

    fun kind(mime: String?, name: String): String {
        val type = mime?.lowercase().orEmpty()
        val ending = name.substringAfterLast('.', "").lowercase()
        return when {
            type.startsWith("image/") || (type.isEmpty() && ending in imageEndings) -> "image"
            type.startsWith("video/") || (type.isEmpty() && ending in videoEndings) -> "video"
            type.startsWith("audio/") || (type.isEmpty() && ending in audioEndings) -> "audio"
            type == "application/pdf" || ending == "pdf" -> "pdf"
            type in archiveTypes || ending in archiveEndings -> "archive"
            else -> "document"
        }
    }

    fun isListed(row: Row, ownPackage: String): Boolean =
        row.relativePath == folder && !row.pending && (row.owner == null || row.owner == ownPackage)

    fun collection(): Uri = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    fun inCollection(uri: Uri, collection: Uri): Boolean {
        if (uri.scheme != "content" || uri.authority != collection.authority) return false
        val id = runCatching { ContentUris.parseId(uri) }.getOrNull()?.takeIf { it >= 0 } ?: return false
        return ContentUris.withAppendedId(collection, id) == uri
    }

    fun payload(row: Row, collection: Uri): Map<String, Any> = mapOf(
        "name" to row.name,
        "uri" to ContentUris.withAppendedId(collection, row.id).toString(),
        "size" to row.size.toDouble(),
        "modified" to (row.modifiedSeconds * 1000).toDouble(),
        "kind" to kind(row.mime, row.name),
    )

    fun list(context: Context): List<Map<String, Any>> {
        val collection = collection()
        return rows(context, collection, "${MediaStore.MediaColumns.RELATIVE_PATH} = ?", arrayOf(folder))
            .filter { isListed(it, context.packageName) }
            .sortedByDescending { it.modifiedSeconds }
            .map { payload(it, collection) }
    }

    fun file(context: Context, uri: String): Pair<Uri, Row>? {
        val collection = collection()
        val parsed = runCatching { Uri.parse(uri) }.getOrNull() ?: return null
        if (!inCollection(parsed, collection)) return null
        val row = rows(context, parsed, null, null).firstOrNull() ?: return null
        return if (isListed(row, context.packageName)) parsed to row else null
    }

    fun delete(context: Context, uri: String): Boolean {
        val (found, _) = file(context, uri) ?: return false
        return runCatching { context.contentResolver.delete(found, null, null) > 0 }.getOrDefault(false)
    }

    fun deleteAll(context: Context): Int = list(context).count { delete(context, it["uri"] as String) }

    fun preview(context: Context, uri: String): Boolean {
        val (found, row) = file(context, uri) ?: return false
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(found, row.mime ?: context.contentResolver.getType(found))
        return start(context, intent)
    }

    fun share(context: Context, uri: String): Boolean {
        val (found, row) = file(context, uri) ?: return false
        val send = Intent(Intent.ACTION_SEND)
            .setType(row.mime ?: context.contentResolver.getType(found) ?: "application/octet-stream")
            .putExtra(Intent.EXTRA_STREAM, found)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return start(context, Intent.createChooser(send, row.name))
    }

    private fun start(context: Context, intent: Intent): Boolean {
        val activity = PhonePages.hostActivity()
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            (activity ?: context).startActivity(intent)
            true
        } catch (missing: ActivityNotFoundException) {
            false
        } catch (refused: SecurityException) {
            false
        }
    }

    private fun rows(context: Context, from: Uri, selection: String?, arguments: Array<String>?): List<Row> = runCatching {
        context.contentResolver.query(from, columns, selection, arguments, null)?.use { cursor ->
            val id = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val name = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val size = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val modified = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
            val mime = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
            val path = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.RELATIVE_PATH)
            val pending = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.IS_PENDING)
            val owner = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.OWNER_PACKAGE_NAME)
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        Row(
                            id = cursor.getLong(id),
                            name = cursor.getString(name).orEmpty(),
                            size = cursor.getLong(size),
                            modifiedSeconds = cursor.getLong(modified),
                            mime = cursor.getString(mime),
                            relativePath = cursor.getString(path),
                            pending = cursor.getInt(pending) != 0,
                            owner = cursor.getString(owner),
                        ),
                    )
                }
            }
        }.orEmpty()
    }.getOrDefault(emptyList())
}
