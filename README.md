# Goli — OCR (استخراج متن از عکس)

اپلیکیشن اندرویدِ آفلاین برای استخراج متن فارسی و انگلیسی از روی عکس، با استفاده از موتور
[Tesseract](https://github.com/tesseract-ocr/tesseract) (از طریق کتابخانه
[Tesseract4Android](https://github.com/adaptech-cz/Tesseract4Android)).

## قابلیت‌ها

- انتخاب عکس از گالری یا گرفتن عکس با دوربین
- انتخاب زبان متن: فارسی، انگلیسی، یا هر دو
- استخراج و نمایش متن، با قابلیت کپی (انتخاب متن)
- کاملاً رایگان و بدون نیاز به کلید API

## نحوه‌ی کار دیتای زبان (تِرین‌دیتا)

فایل‌های تِرین‌دیتای Tesseract (`fas.traineddata`, `eng.traineddata`) در APK باندل نشده‌اند
(برای کوچک ماندن حجم اپ). در اولین اجرای هر زبان، اپ آن‌ها را یک‌بار از مخزن رسمی
`tessdata_fast` دانلود و در حافظه‌ی داخلی برنامه ذخیره می‌کند. از آن پس تشخیص متن کاملاً
آفلاین انجام می‌شود و نیازی به اینترنت نیست.

اگر می‌خواهید اپ از همان ابتدا و بدون هیچ اتصال اینترنتی کار کند، فایل‌های
`fas.traineddata` و `eng.traineddata` را در `app/src/main/assets/tessdata/` قرار دهید و
`TessDataManager` را طوری تغییر دهید که ابتدا assets را کپی کند (به‌جای دانلود).

## ساخت و اجرا

1. پروژه را در Android Studio (Koala یا جدیدتر) باز کنید.
2. صبر کنید Gradle sync تمام شود (نیاز به اینترنت برای دانلود وابستگی‌ها دارد).
3. روی یک دستگاه/شبیه‌ساز با Android 7.0 (API 24) یا بالاتر اجرا (Run) کنید.

از خط فرمان هم می‌توانید بسازید:

```bash
./gradlew assembleDebug
```

> این پروژه در محیطی بدون Android SDK نوشته شده، پس build واقعی اینجا اجرا نشده؛
> حتماً یک‌بار در Android Studio باز و Sync/Run کنید.

## ساختار پروژه

```
app/src/main/java/com/goli/ocrscanner/
├── MainActivity.kt      رابط کاربری (Jetpack Compose)
├── OcrEngine.kt          پوسته‌ی Tesseract4Android برای تشخیص متن
└── TessDataManager.kt    دانلود/کش داده‌های زبان
```
