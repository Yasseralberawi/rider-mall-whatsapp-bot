import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import axios from "axios";

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // rider-mall-verify-2025
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // 855895520937481
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN; // من Quickstart
// WABA_ID اختياري في هذا الكود

// ====== APP ======
const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));

// Health check
app.get("/", (_req, res) => res.status(200).send("OK"));

// Verify webhook (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive messages (POST)
app.post("/webhook", async (req, res) => {
  try {
    // WhatsApp sends an array of entry/changes
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    const from = message?.from; // رقم المرسل بصيغة دولية
    const text = message?.text?.body; // محتوى النص

    if (from && text) {
      console.log("Incoming message:", { from, text });

      if (!WHATSAPP_ACCESS_TOKEN || !PHONE_NUMBER_ID) {
        console.log("WhatsApp credentials missing. Skipping send.");
      } else {
        // رد بسيط (echo)
        await axios.post(
          `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: `Echo: ${text}` }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    // WhatsApp expects 200 even لو ما رددنا
    res.sendStatus(200);
  } catch (err) {
    console.error(
      "webhook error:",
      err?.response?.data || err?.message || err
    );
    // دائمًا رجّع 200
    res.sendStatus(200);
  }
});

// ====== START ======
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
