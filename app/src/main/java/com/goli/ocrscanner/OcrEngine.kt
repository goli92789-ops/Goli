package com.goli.ocrscanner

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import com.googlecode.tesseract.android.TessBaseAPI
import kotlin.math.max
import kotlin.math.roundToInt

/** Thin wrapper around Tesseract4Android for one-shot text recognition. */
class OcrEngine(private val context: Context) {

    fun recognize(bitmap: Bitmap, langCode: String): String {
        val tess = TessBaseAPI()
        try {
            val dataParentDir = TessDataManager.tesseractRootDir(context).absolutePath
            val initialized = tess.init(dataParentDir, langCode)
            if (!initialized) {
                return ""
            }
            // Keeps columns/table cells from merging into one run of text.
            tess.setVariable("preserve_interword_spaces", "1")

            val prepared = preprocess(bitmap)
            tess.setImage(prepared)
            return tess.getUTF8Text().orEmpty()
        } finally {
            tess.recycle()
        }
    }

    /**
     * Photographed/screenshotted forms recognize far better after upscaling (small text/digits
     * need more pixels) and converting to high-contrast grayscale (removes color noise that
     * confuses the recognizer, especially on table borders).
     */
    private fun preprocess(source: Bitmap): Bitmap {
        val minDimension = 1600
        val longestSide = max(source.width, source.height)
        val scaled = if (longestSide < minDimension) {
            val scale = minDimension.toFloat() / longestSide
            Bitmap.createScaledBitmap(
                source,
                (source.width * scale).roundToInt(),
                (source.height * scale).roundToInt(),
                true
            )
        } else {
            source
        }

        val output = Bitmap.createBitmap(scaled.width, scaled.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(output)
        val contrast = 1.6f
        val brightness = -20f
        val colorMatrix = ColorMatrix(
            floatArrayOf(
                0.299f * contrast, 0.587f * contrast, 0.114f * contrast, 0f, brightness,
                0.299f * contrast, 0.587f * contrast, 0.114f * contrast, 0f, brightness,
                0.299f * contrast, 0.587f * contrast, 0.114f * contrast, 0f, brightness,
                0f, 0f, 0f, 1f, 0f
            )
        )
        val paint = Paint().apply { colorFilter = ColorMatrixColorFilter(colorMatrix) }
        canvas.drawBitmap(scaled, 0f, 0f, paint)
        return output
    }
}
