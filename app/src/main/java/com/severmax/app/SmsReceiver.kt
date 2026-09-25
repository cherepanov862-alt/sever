package com.severmax.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject

/**
 * Ловит входящие SMS, даже когда приложение закрыто.
 * Сохраняет только сообщения с номера подогревателя — личная переписка не читается и не хранится.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val heater = SmsInbox.heaterNumber(context)
        if (heater.isBlank()) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // Длинное SMS приходит частями — склеиваем по отправителю
        val bySender = LinkedHashMap<String, StringBuilder>()
        for (m in messages) {
            if (m == null) continue
            val sender = m.originatingAddress ?: continue
            bySender.getOrPut(sender) { StringBuilder() }.append(m.messageBody ?: "")
        }
        val now = System.currentTimeMillis()
        for ((sender, body) in bySender) {
            if (SmsInbox.sameNumber(sender, heater)) {
                SmsInbox.add(context, body.toString(), now)
            }
        }
    }
}

/** Небольшое хранилище ответов подогревателя, пока их не заберёт интерфейс. */
object SmsInbox {
    private const val PREFS = "severmax"
    private const val KEY_NUMBER = "heater_number"
    private const val KEY_INBOX = "inbox"
    private val lock = Any()

    @Volatile
    var listener: (() -> Unit)? = null

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun setHeaterNumber(ctx: Context, number: String) {
        prefs(ctx).edit().putString(KEY_NUMBER, number.trim()).apply()
    }

    fun heaterNumber(ctx: Context): String = prefs(ctx).getString(KEY_NUMBER, "") ?: ""

    /** +7 913…, 8 913… и 913… — один и тот же номер. */
    fun sameNumber(a: String, b: String): Boolean {
        val x = lastDigits(a)
        val y = lastDigits(b)
        return x.length >= 6 && x == y
    }

    private fun lastDigits(s: String): String {
        val d = s.filter { it.isDigit() }
        return if (d.length > 10) d.substring(d.length - 10) else d
    }

    fun add(ctx: Context, body: String, ts: Long) {
        synchronized(lock) {
            val p = prefs(ctx)
            val arr = try {
                JSONArray(p.getString(KEY_INBOX, "[]") ?: "[]")
            } catch (e: Exception) {
                JSONArray()
            }
            val item = JSONObject()
            item.put("body", body)
            item.put("ts", ts)
            arr.put(item)
            val keep = JSONArray()
            val from = if (arr.length() > 100) arr.length() - 100 else 0
            for (i in from until arr.length()) keep.put(arr.get(i))
            p.edit().putString(KEY_INBOX, keep.toString()).commit()
        }
        listener?.invoke()
    }

    fun take(ctx: Context): String {
        synchronized(lock) {
            val p = prefs(ctx)
            val s = p.getString(KEY_INBOX, "[]") ?: "[]"
            p.edit().putString(KEY_INBOX, "[]").commit()
            return s
        }
    }
}
