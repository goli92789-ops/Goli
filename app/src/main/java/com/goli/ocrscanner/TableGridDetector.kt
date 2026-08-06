package com.goli.ocrscanner

import android.graphics.Bitmap

/**
 * Detects a ruled table grid (printed border lines, like a payslip or invoice) by scanning for
 * rows/columns of pixels that are almost entirely dark across the content area -- real text is
 * sparse and broken, while a ruling line is a long unbroken dark run. This is a lightweight
 * stand-in for a proper table-layout model: good enough for bordered forms, but it will find
 * nothing on plain paragraphs or borderless tables, which is by design (callers should fall back
 * to normal OCR in that case).
 */
object TableGridDetector {

    data class Grid(val rowBounds: List<Int>, val colBounds: List<Int>)

    private const val DARK_LUMA_THRESHOLD = 140
    private const val LINE_COVERAGE_RATIO = 0.55f
    private const val MERGE_GAP_PX = 4
    private const val MAX_LINES_PER_AXIS = 40

    fun detect(bitmap: Bitmap): Grid? {
        val width = bitmap.width
        val height = bitmap.height
        if (width < 20 || height < 20) return null

        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        var minX = width
        var maxX = -1
        var minY = height
        var maxY = -1
        for (y in 0 until height) {
            val rowOffset = y * width
            for (x in 0 until width) {
                if (isDark(pixels[rowOffset + x])) {
                    if (x < minX) minX = x
                    if (x > maxX) maxX = x
                    if (y < minY) minY = y
                    if (y > maxY) maxY = y
                }
            }
        }
        if (minX >= maxX || minY >= maxY) return null

        val contentWidth = maxX - minX + 1
        val contentHeight = maxY - minY + 1
        if (contentWidth < 20 || contentHeight < 20) return null

        val horizontalLines = mutableListOf<Int>()
        for (y in minY..maxY) {
            val rowOffset = y * width
            var dark = 0
            for (x in minX..maxX) {
                if (isDark(pixels[rowOffset + x])) dark++
            }
            if (dark.toFloat() / contentWidth >= LINE_COVERAGE_RATIO) {
                horizontalLines.add(y)
            }
        }

        val verticalLines = mutableListOf<Int>()
        for (x in minX..maxX) {
            var dark = 0
            for (y in minY..maxY) {
                if (isDark(pixels[y * width + x])) dark++
            }
            if (dark.toFloat() / contentHeight >= LINE_COVERAGE_RATIO) {
                verticalLines.add(x)
            }
        }

        val rowBounds = mergeAdjacent(horizontalLines)
        val colBounds = mergeAdjacent(verticalLines)

        // Fewer than 3 lines means at most one cell in that direction -- not a real grid.
        // A very large number of "lines" means the coverage threshold caught noise/texture
        // rather than ruling lines.
        if (rowBounds.size < 3 || colBounds.size < 3) return null
        if (rowBounds.size > MAX_LINES_PER_AXIS || colBounds.size > MAX_LINES_PER_AXIS) return null

        return Grid(rowBounds, colBounds)
    }

    private fun isDark(pixel: Int): Boolean {
        val r = (pixel shr 16) and 0xFF
        val g = (pixel shr 8) and 0xFF
        val b = pixel and 0xFF
        val luma = (r * 299 + g * 587 + b * 114) / 1000
        return luma < DARK_LUMA_THRESHOLD
    }

    /** Collapses runs of consecutive/near-consecutive dark rows or columns (a line has thickness) into a single position at their midpoint. */
    private fun mergeAdjacent(positions: List<Int>): List<Int> {
        if (positions.isEmpty()) return emptyList()
        val merged = mutableListOf<Int>()
        var clusterStart = positions[0]
        var clusterEnd = positions[0]
        for (pos in positions.drop(1)) {
            if (pos - clusterEnd <= MERGE_GAP_PX) {
                clusterEnd = pos
            } else {
                merged.add((clusterStart + clusterEnd) / 2)
                clusterStart = pos
                clusterEnd = pos
            }
        }
        merged.add((clusterStart + clusterEnd) / 2)
        return merged
    }
}
