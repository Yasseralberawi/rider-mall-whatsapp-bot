// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));

// ==== متغيرات البيئة ====
const {
  PORT = 5000,
  VERIFY_TOKEN = "CHANGE_ME",
  WHATSAPP_TOKEN = "",
  PHONE_NUMBER_ID = "",
} = process.env;

// لاحظ استخدام v24.0 لتتوافق مع إعداداتك في Meta
const WA_API = PHONE_NUMBER_ID
  ? `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`
  : "";

// صحّة السيرفر
app.get("/", (_req, res) => {
  res.send("✅ Rider Mall WhatsApp Bot server is running.");
});

// دالة إرسال نص عبر WhatsApp Cloud API
async function sendText(to, text) {
  if (!WA_API || !WHATSAPP_TOKEN) {
    console.warn("WhatsApp credentials missing. Skipping send.");
    return;
  }
  try {
    await axios.post(
      WA_API,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    const payload = err.response?.data || err.message;
    console.error("sendText error:", payload);
  }
}

// 1) تحقق الويبهوك من Meta (GET) — يتم مرة واحدة عند الربط
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) استقبال رسائل واتساب (POST)
app.post("/webhook", async (req, res) => {
  try {
    // بنية حدث واتساب
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // إشعارات الحالة (read/delivered/status) نتجاهلها
    if (value?.statuses?.length) {
      return res.sendStatus(200);
    }

    const message = value?.messages?.[0];
    const from = message?.from; // رقم المرسل بصيغة E.164 بدون +
    const type = message?.type;

    if (from && type === "text") {
      const text = message.text?.body?.trim() || "";

      // ردود بسيطة — طوّرها كما تشاء
      if (/^hi\b|^hello\b/i.test(text)) {
        await sendText(
          from,
          "Hello 👋 This is Rider Mall bot.\nاكتب: تسجيل / تأمين / فاحص / مساعدة."
        );
      } else if (/^(تسجيل|تاجيل|ترخيص)$/i.test(text)) {
        await sendText(from, "📄 خدمة التسجيل: أرسل رقم المركبة والاسم الثلاثي.");
      } else if (/^(تأمين|تامين)$/i.test(text)) {
        await sendText(from, "🛡️ خدمة التأمين: أرسل نوع التأمين والمدة المطلوبة.");
      } else if (/^(فاحص|فحص)$/i.test(text)) {
        await sendText(from, "🔍 خدمة الفحص: أرسل الموقع والوقت المناسب.");
      } else if (/^(مساعدة|ونش|طوارئ)$/i.test(text)) {
        await sendText(from, "🆘 مساعدة الطريق: أرسل موقعك الحالي ورقم التواصل.");
      } else {
        await sendText(
          from,
          "أهلًا 👋 معك Rider Mall.\nاكتب: تسجيل / تأمين / فاحص / مساعدة."
        );
      }
    }
  } catch (e) {
    console.error("Webhook handler error:", e.response?.data || e.message);
  }

  // دائمًا 200 حتى لا تعيد Meta الطلب
  res.sendStatus(200);
});

// بدء السيرفر
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
