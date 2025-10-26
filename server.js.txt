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

// ==== بيئة التشغيل ====
const {
  PORT = 5000,
  VERIFY_TOKEN = "CHANGE_ME",
  WHATSAPP_TOKEN = "",
  PHONE_NUMBER_ID = "",
} = process.env;

const WA_API = PHONE_NUMBER_ID
  ? `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`
  : "";

// رسالة اختبار صحّة السيرفر
app.get("/", (_req, res) => {
  res.send("✅ Rider Mall WhatsApp Bot server is running.");
});

// دالة إرسال نص عبر واتساب Cloud API
async function sendText(to, text) {
  if (!WA_API || !WHATSAPP_TOKEN) {
    console.warn("WhatsApp credentials missing. Skipping send.");
    return;
  }
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
}

// 1) تحقق الويبهوك (GET) — لمرة واحدة عند الربط من ميتا
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
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    const from = message?.from; // رقم المرسل بصيغة E.164 بدون +
    const text = message?.text?.body?.trim();

    if (from && text) {
      // رد ترحيبي بسيط كبداية (نطوّره لاحقًا)
      await sendText(
        from,
        "أهلًا 👋 معك Rider Mall.\nاكتب: تسجيل / تأمين / فاحص / مساعدة."
      );
    }
  } catch (e) {
    console.error("Webhook error:", e.response?.data || e.message);
  }
  // دائمًا نرجّع 200 عشان ميتا ما تعيد الطلب
  res.sendStatus(200);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
