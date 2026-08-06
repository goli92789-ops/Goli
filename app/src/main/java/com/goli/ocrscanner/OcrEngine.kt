package com.goli.ocrscanner

import android.content.Context
import android.graphics.Bitmap
import com.googlecode.tesseract.android.TessBaseAPI

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
            return tess.getUTF8Text().orEmpty()
        } finally {
            tess.recycle()
        }
    }
}
