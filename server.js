import express from "express";
import crypto from "crypto";

// ==== ENV ====
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ==== HELPERS ====
const app = express();
app.use(express.json());

const graphBase = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

async function sendRequest(body) {
  const res = await fetch(graphBase, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("webhook error:", JSON.stringify(data, null, 2));
  }
  return data;
}

function isArabic(txt = "") {
  return /[\u0600-\u06FF]/.test(txt);
}

function normalize(text = "") {
  return text.trim().toLowerCase();
}

// ==== SENDERS ====
async function sendText(to, text) {
  return sendRequest({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  });
}

async function sendMenu(to, lang = "en") {
  // Interactive buttons (لا تحتاج قالب وتشتغل داخل نافذة 24 ساعة)
  const title = lang === "ar" ? "قائمة رايدر مول" : "Rider Mall Menu";
  const body  = lang === "ar"
    ? "اختر خيارًا:"
    : "Choose an option:";

  return sendRequest({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: title },
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "BTN_SERVICES", title: lang === "ar" ? "الخدمات" : "Services" } },
          { type: "reply", reply: { id: "BTN_SHOP",     title: lang === "ar" ? "المتجر" : "Shop" } },
          { type: "reply", reply: { id: "BTN_CONTACT",  title: lang === "ar" ? "تواصل" : "Contact" } }
        ]
      }
    }
  });
}

async function sendServices(to, lang = "en") {
  const text = lang === "ar"
    ? `خدمات رايدر مول:
• تسجيل المركبات
• التأمين
• سطحة ونقل
• صيانة/إكسسوارات

اكتب: 
- "حجز" أو "booking" للحجز
- "قائمة" لعرض القائمة`
    : `Rider Mall Services:
• Vehicle registration
• Insurance
• Recovery/Transport
• Maintenance & accessories

Type:
- "booking" or "حجز" to book
- "menu" to see the menu`;
  return sendText(to, text);
}

async function sendShop(to, lang = "en") {
  const text = lang === "ar"
    ? `المتجر (Amazon Affiliates):
• خوذات • قفازات • إكسسوارات
نزّل منتجاتك وسأعطيك الرابط المختصر.

اكتب "قائمة" للقائمة.`
    : `Shop (Amazon Affiliates):
• Helmets • Gloves • Accessories
Share a product name and I'll reply with a short link.

Type "menu" to see the menu.`;
  return sendText(to, text);
}

async function sendContact(to, lang = "en") {
  const text = lang === "ar"
    ? `تواصل معنا:
• واتساب: +974 7729 9005
• الموقع: ridermall.qa (قريباً)

اكتب "قائمة" لعرض القائمة.`
    : `Contact us:
• WhatsApp: +974 7729 9005
• Website: ridermall.qa (soon)

Type "menu" to see the menu.`;
  return sendText(to, text);
}

async function sendBooking(to, lang = "en") {
  // List message (interactive list)
  const title = lang === "ar" ? "حجز خدمة" : "Book a service";
  const body  = lang === "ar" ? "اختر الخدمة للحجز:" : "Choose a service to book:";
  const collTitle = lang === "ar" ? "الخدمات المتاحة" : "Available services";

  return sendRequest({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: title },
      body: { text: body },
      action: {
        button: lang === "ar" ? "اختيار" : "Select",
        sections: [
          {
            title: collTitle,
            rows: [
              { id: "BOOK_REG",  title: lang === "ar" ? "تسجيل المركبات" : "Vehicle registration" },
              { id: "BOOK_INS",  title: lang === "ar" ? "التأمين"       : "Insurance" },
              { id: "BOOK_TOW",  title: lang === "ar" ? "سطحة/نقل"      : "Recovery/Transport" },
              { id: "BOOK_MAINT",title: lang === "ar" ? "صيانة/إكسسوارات" : "Maintenance/Accessories" }
            ]
          }
        ]
      }
    }
  });
}

// ==== ROUTES ====
// Health
app.get("/", (_req, res) => res.status(200).send("OK"));

// Verify webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive messages
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    const from = msg?.from; // رقم المرسل (بدون +)
    let lang = "en";

    if (msg) {
      // Text message
      if (msg.type === "text") {
        const userText = msg.text?.body || "";
        console.log("Incoming message:", { from, text: userText });

        lang = isArabic(userText) ? "ar" : "en";
        const t = normalize(userText);

        // Keywords
        if (["menu", "help", "start", "قائمة", "ابدأ", "مساعدة"].includes(t)) {
          await sendMenu(from, lang);
        } else if (["services", "service", "خدمات", "الخدمات"].includes(t)) {
          await sendServices(from, lang);
        } else if (["shop", "store", "المتجر", "شراء"].includes(t)) {
          await sendShop(from, lang);
        } else if (["contact", "support", "تواصل", "اتصال"].includes(t)) {
          await sendContact(from, lang);
        } else if (["booking", "book", "حجز"].includes(t)) {
          await sendBooking(from, lang);
        } else if (["hi", "hello", "مرحبا", "سلام"].includes(t)) {
          await sendText(from, lang === "ar"
            ? "أهلاً! اكتب \"قائمة\" لعرض الأزرار."
            : "Hello! Type \"menu\" to see options.");
        } else {
          // Fallback
          await sendText(from, lang === "ar"
            ? `ما فهمت رسالتك. اكتب "قائمة" لعرض الأزرار.`
            : `I didn't catch that. Type "menu" to see options.`);
        }
      }

      // Button replies
      if (msg.type === "interactive" && msg.interactive?.button_reply) {
        const id = msg.interactive.button_reply.id;
        lang = "en"; // الرسائل التفاعلية غالباً بالإنجليزي، نقدر نعدل حسب آخر رسالة

        if (id === "BTN_SERVICES")      await sendServices(from, lang);
        else if (id === "BTN_SHOP")     await sendShop(from, lang);
        else if (id === "BTN_CONTACT")  await sendContact(from, lang);
        else                            await sendMenu(from, lang);
      }

      // List selections
      if (msg.type === "interactive" && msg.interactive?.list_reply) {
        const id = msg.interactive.list_reply.id;
        lang = "en";
        const confirm = (title) => lang === "ar"
          ? `تم استلام طلب حجز: ${title}. سنعاود الاتصال بك قريبًا.`
          : `Booking received: ${title}. We'll contact you shortly.`;

        switch (id) {
          case "BOOK_REG":   await sendText(from, confirm(lang === "ar" ? "تسجيل المركبات" : "Vehicle registration")); break;
          case "BOOK_INS":   await sendText(from, confirm(lang === "ar" ? "التأمين" : "Insurance")); break;
          case "BOOK_TOW":   await sendText(from, confirm(lang === "ar" ? "سطحة/نقل" : "Recovery/Transport")); break;
          case "BOOK_MAINT": await sendText(from, confirm(lang === "ar" ? "صيانة/إكسسوارات" : "Maintenance/Accessories")); break;
          default:           await sendMenu(from, lang);
        }
      }
    }
  } catch (err) {
    console.error("handler error:", err);
  }
  res.sendStatus(200);
});

// ==== START ====
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
