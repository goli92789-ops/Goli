package com.goli.ocrscanner

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    OcrScreen()
                }
            }
        }
    }
}

private enum class OcrLang(val code: String, val label: String) {
    FA("fas", "فارسی"),
    EN("eng", "انگلیسی"),
    FA_EN("fas+eng", "فارسی + انگلیسی")
}

@Composable
private fun OcrScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var resultText by remember { mutableStateOf("") }
    var isBusy by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf("") }
    var selectedLang by remember { mutableStateOf(OcrLang.FA_EN) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }

    val galleryLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            bitmap = loadBitmap(context, it)
            resultText = ""
            statusMessage = ""
        }
    }

    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        if (success) {
            pendingCameraUri?.let {
                bitmap = loadBitmap(context, it)
                resultText = ""
                statusMessage = ""
            }
        }
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            val uri = createCameraImageUri(context)
            pendingCameraUri = uri
            cameraLauncher.launch(uri)
        } else {
            statusMessage = "دسترسی به دوربین رد شد"
        }
    }

    fun startCamera() {
        val hasPermission = context.checkSelfPermission(Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (hasPermission) {
            val uri = createCameraImageUri(context)
            pendingCameraUri = uri
            cameraLauncher.launch(uri)
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    fun runOcr() {
        val currentBitmap = bitmap ?: return
        val langsNeeded = selectedLang.code.split("+")
        scope.launch {
            isBusy = true
            resultText = ""
            try {
                statusMessage = "در حال آماده‌سازی داده زبان..."
                withContext(Dispatchers.IO) {
                    TessDataManager.ensureLanguages(context, langsNeeded) { lang, percent ->
                        statusMessage = if (percent >= 0) {
                            "در حال دانلود داده زبان $lang: $percent%"
                        } else {
                            "در حال دانلود داده زبان $lang..."
                        }
                    }
                }
                statusMessage = "در حال استخراج متن..."
                val text = withContext(Dispatchers.Default) {
                    OcrEngine(context).recognize(currentBitmap, selectedLang.code)
                }
                resultText = text.ifBlank { "متنی در عکس پیدا نشد." }
                statusMessage = ""
            } catch (e: Exception) {
                statusMessage = "خطا: ${e.message ?: "نامشخص"}"
            } finally {
                isBusy = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("استخراج متن از عکس", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(16.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { galleryLauncher.launch("image/*") }) {
                Text("انتخاب از گالری")
            }
            Button(onClick = { startCamera() }) {
                Text("گرفتن عکس")
            }
        }

        Spacer(Modifier.height(16.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OcrLang.entries.forEach { lang ->
                FilterChip(
                    selected = selectedLang == lang,
                    onClick = { selectedLang = lang },
                    label = { Text(lang.label) }
                )
            }
        }

        bitmap?.let { bmp ->
            Spacer(Modifier.height(16.dp))
            Image(
                bitmap = bmp.asImageBitmap(),
                contentDescription = null,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 300.dp)
            )
            Spacer(Modifier.height(16.dp))
            Button(onClick = { runOcr() }, enabled = !isBusy) {
                Text("استخراج متن")
            }
        }

        if (isBusy) {
            Spacer(Modifier.height(16.dp))
            CircularProgressIndicator()
            Spacer(Modifier.height(8.dp))
            Text(statusMessage)
        } else if (statusMessage.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            Text(statusMessage, color = MaterialTheme.colorScheme.error)
        }

        if (resultText.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            SelectionContainer {
                Text(resultText, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}

private fun loadBitmap(context: Context, uri: Uri): Bitmap? =
    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }

private fun createCameraImageUri(context: Context): Uri {
    val imagesDir = File(context.cacheDir, "images").apply { mkdirs() }
    val file = File(imagesDir, "camera_${System.currentTimeMillis()}.jpg")
    return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
}
