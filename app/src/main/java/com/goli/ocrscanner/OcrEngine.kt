package com.goli.ocrscanner

import android.content.Context
import android.graphics.Bitmap
import cz.adaptech.tesseract4android.TessBaseAPI

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
            tess.setImage(bitmap)
            return tess.utF8Text.orEmpty()
        } finally {
            tess.recycle()
        }
    }
}
