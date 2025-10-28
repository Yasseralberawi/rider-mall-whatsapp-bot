// server.js (تشخيص مبسط)
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// اقرأ المتغيّرات
const TOKEN   = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;

// اطبع حالة المتغيّرات عند الإقلاع
console.log("[ENV CHECK]", {
  hasToken: !!TOKEN,
  tokenLen: TOKEN ? TOKEN.length : 0,
  hasPhoneId: !!PHONEID,
  phoneId: PHONEID || null,
});

// health بسيط
app.get("/", (_req, res) => res.status(200).send("OK"));

app.get("/debug/env", (_req, res) => {
  res.json({
    hasToken: !!TOKEN,
    tokenLen: TOKEN ? TOKEN.length : 0,
    hasPhoneId: !!PHONEID,
    phoneId: PHONEID || null,
  });
});

// verify webhook
app.get("/webhook", (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN || "rider-mall-verify-2025";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// receive & reply
app.post("/webhook", async (req, res) => {
  try {
    // مهم: ردّ 200 بسرعة
    res.sendStatus(200);

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const from = message?.from;
    const text = message?.text?.body;

    if (!from || !text) return;

    if (!TOKEN || !PHONEID) {
      console.log("WhatsApp credentials missing. Skipping send.");
      return;
    }

    const reply = `Echo: ${text}`;
    const url = `https://graph.facebook.com/v24.0/${PHONEID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: from, // مع الرمز الدولي كما يصل من واتساب
      type: "text",
      text: { body: reply }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    console.log("[WA SEND]", r.status, JSON.stringify(data));
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
