package com.goli.ocrscanner

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads and caches Tesseract trained-data files on first use.
 * Once a language file is present under filesDir, recognition works fully offline.
 */
object TessDataManager {

    private const val TRAINED_DATA_BASE_URL =
        "https://github.com/tesseract-ocr/tessdata_fast/raw/main/"

    fun tesseractRootDir(context: Context): File =
        File(context.filesDir, "tesseract")

    fun tessDataDir(context: Context): File =
        File(tesseractRootDir(context), "tessdata").apply { mkdirs() }

    fun isLanguageReady(context: Context, lang: String): Boolean =
        File(tessDataDir(context), "$lang.traineddata").exists()

    /** Downloads any missing languages. Must be called from a background thread. */
    fun ensureLanguages(
        context: Context,
        langs: List<String>,
        onProgress: (lang: String, percent: Int) -> Unit
    ) {
        for (lang in langs) {
            if (!isLanguageReady(context, lang)) {
                downloadLanguage(context, lang, onProgress)
            }
        }
    }

    private fun downloadLanguage(
        context: Context,
        lang: String,
        onProgress: (lang: String, percent: Int) -> Unit
    ) {
        val url = URL("$TRAINED_DATA_BASE_URL$lang.traineddata")
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 15_000
        try {
            connection.connect()
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw java.io.IOException("HTTP ${connection.responseCode} برای زبان $lang")
            }
            val total = connection.contentLengthLong
            val dir = tessDataDir(context)
            val tmp = File(dir, "$lang.traineddata.part")
            val dest = File(dir, "$lang.traineddata")

            connection.inputStream.use { input ->
                tmp.outputStream().use { output ->
                    val buffer = ByteArray(16 * 1024)
                    var downloaded = 0L
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloaded += read
                        val percent = if (total > 0) ((downloaded * 100) / total).toInt() else -1
                        onProgress(lang, percent)
                    }
                }
            }

            if (!tmp.renameTo(dest)) {
                tmp.delete()
                throw java.io.IOException("ذخیره‌سازی داده زبان $lang ناموفق بود")
            }
        } finally {
            connection.disconnect()
        }
    }
}
