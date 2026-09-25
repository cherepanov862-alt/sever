package com.severmax.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.telephony.SmsManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Пульт для предпускового подогревателя Севермакс 5000 4-mini.
 *
 * Интерфейс — assets/www (index.html, app.js, cars.js), показывается в WebView.
 * Эта активность даёт интерфейсу то, что умеет только Android:
 *  - отправку SMS с подтверждением «отправлено / ошибка» (window.onSmsStatus);
 *  - выбор фото из галереи для <input type="file">;
 *  - копирование в буфер обмена;
 *  - приём ответов подогревателя (через SmsReceiver и SmsInbox → window.pullInbox).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var backCallback: OnBackPressedCallback

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pendingSms = ArrayList<Array<String>>()   // [номер, текст, id]
    private var permissionRequestActive = false
    private var sentReceiver: BroadcastReceiver? = null

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        val cb = fileCallback
        fileCallback = null
        if (uri != null) cb?.onReceiveValue(arrayOf(uri)) else cb?.onReceiveValue(null)
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
            permissionRequestActive = false
            val canSend = hasPermission(Manifest.permission.SEND_SMS)
            val queue = ArrayList(pendingSms)
            pendingSms.clear()
            for (item in queue) {
                if (canSend) doSendSms(item[0], item[1], item[2])
                else reportStatus(item[2], false, "нет разрешения на отправку SMS — включите его в настройках приложения")
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        webView.setBackgroundColor(0xFF07090D.toInt())
        setContentView(webView)

        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowContentAccess = true

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.scheme == "file") return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                } catch (e: Exception) {
                    // нет приложения для ссылки — просто игнорируем
                }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    pickImage.launch("image/*")
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        webView.addJavascriptInterface(Bridge(), "Android")
        webView.loadUrl("file:///android_asset/www/index.html")

        registerSentReceiver()

        backCallback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("(window.handleBack && window.handleBack()) ? 1 : 0") { result ->
                    if (result != "1") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)

        askPermissionsIfNeeded()
    }

    override fun onResume() {
        super.onResume()
        backCallback.isEnabled = true
        SmsInbox.listener = { runOnUiThread { pullInbox() } }
        pullInbox()
    }

    override fun onPause() {
        SmsInbox.listener = null
        super.onPause()
    }

    override fun onDestroy() {
        sentReceiver?.let {
            try {
                unregisterReceiver(it)
            } catch (e: Exception) {
                // уже отписан
            }
        }
        sentReceiver = null
        super.onDestroy()
    }

    /** Просим интерфейс забрать новые ответы подогревателя. */
    private fun pullInbox() {
        webView.evaluateJavascript("window.pullInbox && window.pullInbox()", null)
    }

    // ---------------- Разрешения ----------------

    private fun hasPermission(p: String): Boolean =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun askPermissionsIfNeeded() {
        val need = listOf(Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS)
            .filter { !hasPermission(it) }
        if (need.isNotEmpty()) {
            permissionRequestActive = true
            permissionLauncher.launch(need.toTypedArray())
        }
    }

    // ---------------- Отправка SMS ----------------

    private fun requestSend(number: String, text: String, id: String) {
        if (number.isBlank()) {
            reportStatus(id, false, "не указан номер SIM подогревателя")
            return
        }
        if (hasPermission(Manifest.permission.SEND_SMS)) {
            doSendSms(number, text, id)
            return
        }
        pendingSms.add(arrayOf(number, text, id))
        if (!permissionRequestActive) {
            permissionRequestActive = true
            permissionLauncher.launch(arrayOf(Manifest.permission.SEND_SMS))
        }
    }

    @Suppress("DEPRECATION")
    private fun smsManager(): SmsManager =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) getSystemService(SmsManager::class.java) ?: SmsManager.getDefault()
        else SmsManager.getDefault()

    private fun doSendSms(number: String, text: String, id: String) {
        try {
            val intent = Intent(ACTION_SMS_SENT).setPackage(packageName).putExtra(EXTRA_ID, id)
            val sentPi = PendingIntent.getBroadcast(
                this, id.hashCode(), intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            smsManager().sendTextMessage(number, null, text, sentPi, null)
        } catch (e: Exception) {
            reportStatus(id, false, e.message ?: "ошибка отправки")
        }
    }

    private fun registerSentReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val id = intent?.getStringExtra(EXTRA_ID) ?: return
                val code = resultCode
                val message = when (code) {
                    Activity.RESULT_OK -> "отправлено"
                    SmsManager.RESULT_ERROR_NO_SERVICE -> "нет сети"
                    SmsManager.RESULT_ERROR_RADIO_OFF -> "включён режим полёта"
                    SmsManager.RESULT_ERROR_NULL_PDU -> "ошибка формирования SMS"
                    SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "оператор отклонил SMS (проверьте баланс)"
                    else -> "ошибка отправки (код $code)"
                }
                reportStatus(id, code == Activity.RESULT_OK, message)
            }
        }
        sentReceiver = receiver
        ContextCompat.registerReceiver(
            this, receiver, IntentFilter(ACTION_SMS_SENT), ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    private fun reportStatus(id: String, ok: Boolean, message: String) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.onSmsStatus && window.onSmsStatus(${JSONObject.quote(id)}, $ok, ${JSONObject.quote(message)})",
                null
            )
        }
    }

    // ---------------- Мост для JavaScript ----------------

    inner class Bridge {
        @JavascriptInterface
        fun sendSms(number: String, text: String, id: String) {
            runOnUiThread { requestSend(number, text, id) }
        }

        @JavascriptInterface
        fun copyText(text: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Севермакс", text))
            }
        }

        @JavascriptInterface
        fun setHeaterNumber(number: String) {
            SmsInbox.setHeaterNumber(this@MainActivity, number)
        }

        @JavascriptInterface
        fun takeInbox(): String = SmsInbox.take(this@MainActivity)

        @JavascriptInterface
        fun appVersion(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun openAppSettings() {
            runOnUiThread {
                try {
                    startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
                    )
                } catch (e: Exception) {
                    // ничего
                }
            }
        }
    }

    companion object {
        private const val ACTION_SMS_SENT = "com.severmax.app.SMS_SENT"
        private const val EXTRA_ID = "id"
    }
}
