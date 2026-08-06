package com.goli.ocrscanner

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Rect
import com.googlecode.tesseract.android.TessBaseAPI
import com.googlecode.tesseract.android.TessBaseAPI.PageIteratorLevel.RIL_WORD
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Thin wrapper around Tesseract4Android for one-shot text recognition. */
class OcrEngine(private val context: Context) {

    private data class Word(val text: String, val box: Rect)

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

            // For ruled tables/forms, OCR-ing each detected cell separately beats trusting
            // Tesseract (or even geometry-based reordering) on the whole page at once.
            val grid = TableGridDetector.detect(prepared)
            if (grid != null) {
                val tableText = recognizeGrid(tess, prepared, grid)
                if (tableText.isNotBlank()) return tableText
            }

            tess.setImage(prepared)

            // Triggers native recognition; Tesseract's own paragraph/block ordering
            // (used to build this flat string) tends to scramble multi-column tables,
            // so it's kept only as a fallback.
            val flatText = tess.getUTF8Text().orEmpty()

            val words = collectWords(tess)
            return if (words.isNotEmpty()) reconstructByPosition(words) else flatText
        } finally {
            tess.recycle()
        }
    }

    /** Crops out every cell of the detected grid and OCRs it independently, then reassembles a
     *  tab-separated table so columns line up regardless of how much text each cell holds. */
    private fun recognizeGrid(tess: TessBaseAPI, bitmap: Bitmap, grid: TableGridDetector.Grid): String {
        val rowBounds = grid.rowBounds
        val colBounds = grid.colBounds
        val cellCount = (rowBounds.size - 1) * (colBounds.size - 1)
        if (cellCount <= 0 || cellCount > 400) return ""

        val inset = 3
        val rows = mutableListOf<List<String>>()
        for (i in 0 until rowBounds.size - 1) {
            val rowCells = mutableListOf<String>()
            for (j in 0 until colBounds.size - 1) {
                val left = (colBounds[j] + inset).coerceIn(0, bitmap.width)
                val top = (rowBounds[i] + inset).coerceIn(0, bitmap.height)
                val right = (colBounds[j + 1] - inset).coerceIn(left, bitmap.width)
                val bottom = (rowBounds[i + 1] - inset).coerceIn(top, bitmap.height)
                val cellWidth = right - left
                val cellHeight = bottom - top

                val text = if (cellWidth > 4 && cellHeight > 4) {
                    val cell = Bitmap.createBitmap(bitmap, left, top, cellWidth, cellHeight)
                    tess.setImage(cell)
                    tess.getUTF8Text().orEmpty().trim().replace("\n", " ")
                } else {
                    ""
                }
                rowCells.add(text)
            }
            rows.add(rowCells)
        }

        return rows.joinToString("\n") { it.joinToString("\t") }
    }

    /** Reads every recognized word with its bounding box, bypassing Tesseract's own reading order. */
    private fun collectWords(tess: TessBaseAPI): List<Word> {
        val iterator = tess.getResultIterator() ?: return emptyList()
        val words = mutableListOf<Word>()
        do {
            val text = iterator.getUTF8Text(RIL_WORD)
            if (!text.isNullOrBlank()) {
                words.add(Word(text.trim(), iterator.getBoundingRect(RIL_WORD)))
            }
        } while (iterator.next(RIL_WORD))
        return words
    }

    /**
     * Rebuilds the page as text rows using each word's geometry instead of Tesseract's
     * block/paragraph analysis: words are grouped into rows by vertical overlap, then within
     * each row ordered right-to-left (matching Persian reading direction). A wide horizontal
     * gap between two words on the same row is treated as a column boundary and gets extra
     * spacing, so separate table columns that land on the same row don't run together.
     */
    private fun reconstructByPosition(words: List<Word>): String {
        val rows = mutableListOf<MutableList<Word>>()
        for (word in words.sortedBy { it.box.top }) {
            val row = rows.lastOrNull { r ->
                val rowTop = r.minOf { it.box.top }
                val rowBottom = r.maxOf { it.box.bottom }
                val overlap = min(rowBottom, word.box.bottom) - max(rowTop, word.box.top)
                overlap > word.box.height() * 0.4
            }
            if (row != null) row.add(word) else rows.add(mutableListOf(word))
        }
        rows.sortBy { row -> row.sumOf { it.box.top } / row.size }

        val avgWordHeight = words.map { it.box.height() }.average().takeIf { it > 0.0 } ?: 20.0
        val columnGapThreshold = avgWordHeight * 2.5

        return rows.joinToString("\n") { row ->
            val rightToLeft = row.sortedByDescending { it.box.right }
            buildString {
                var previous: Word? = null
                for (word in rightToLeft) {
                    previous?.let { prev ->
                        val gap = prev.box.left - word.box.right
                        append(if (gap > columnGapThreshold) "    " else " ")
                    }
                    append(word.text)
                    previous = word
                }
            }
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
