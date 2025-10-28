// server.js  (ESM version)
// Rider Mall - WhatsApp Bot (Services focus)
// Requires: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, VERIFY_TOKEN

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import 'dotenv/config';

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));

// ====== ENV / Graph API Setup ======
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID; // e.g. "1234567890"
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'rider-mall-verify';
const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`;

// ====== Helpers ======
async function sendWhatsApp(payload) {
  try {
    const { data } = await axios.post(GRAPH_URL, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    return data;
  } catch (err) {
    console.error('WhatsApp API Error:', err?.response?.data || err.message);
  }
}

function sendText(to, text) {
  return sendWhatsApp({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

function sendWelcomeWithButton(to) {
  const welcome =
    'أهلاً وسهلاً بكم في رايدر مول - المنصة الشاملة لخدمات الدراجات في قطر.\nالرجاء اختيار الخدمة من القائمة.';
  return sendWhatsApp({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: welcome },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: 'SHOW_SERVICES', title: 'عرض القائمة' },
          },
        ],
      },
    },
  });
}

function sendServiceList(to) {
  return sendWhatsApp({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'خدمات رايدر مول' },
      body: { text: 'اختر الخدمة المطلوبة:' },
      footer: { text: 'Rider Mall' },
      action: {
        button: 'اختر خدمة',
        sections: [
          {
            title: 'الخدمات',
            rows: [
              { id: 'SERVICE_INSURANCE', title: 'خدمات التأمين' },
              { id: 'SERVICE_REGISTRATION', title: 'خدمات التسجيل' },
              { id: 'SERVICE_TRANSPORT', title: 'خدمات النقل' },
              { id: 'SERVICE_MAINTENANCE', title: 'خدمات الصيانة' },
            ],
          },
        ],
      },
    },
  });
}

function serviceIdToTitle(id) {
  switch (id) {
    case 'SERVICE_INSURANCE':
      return 'خدمات التأمين';
    case 'SERVICE_REGISTRATION':
      return 'خدمات التسجيل';
    case 'SERVICE_TRANSPORT':
      return 'خدمات النقل';
    case 'SERVICE_MAINTENANCE':
      return 'خدمات الصيانة';
    default:
      return null;
  }
}

function sendServiceConfirmation(to, serviceTitle) {
  const msg = `تم تأكيد خدمة (${serviceTitle})، سيقوم فريق رايدر مول بالتواصل معك.\nسعدنا بخدمتك.`;
  return sendText(to, msg);
}

// Simple Arabic greetings matcher
function isGreeting(text = '') {
  const t = text.trim().toLowerCase();
  return (
    t.includes('مرحبا') ||
    t.includes('السلام عليكم') ||
    t.includes('سلام عليكم') ||
    t === 'السلام' ||
    t === 'سلام'
  );
}

// ====== Webhook Verify (GET) ======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== Webhook Receiver (POST) ======
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (!messages || messages.length === 0) {
      return res.sendStatus(200);
    }

    const msg = messages[0];
    const from = msg.from; // customer phone
    const type = msg.type;

    console.log('Incoming message:', JSON.stringify(msg, null, 2));

    // 1) If text greeting -> welcome + button
    if (type === 'text') {
      const body = msg.text?.body || '';
      if (isGreeting(body)) {
        await sendWelcomeWithButton(from);
        return res.sendStatus(200);
      } else {
        // Optional: fallback — also show button if you prefer
        await sendWelcomeWithButton(from);
        return res.sendStatus(200);
      }
    }

    // 2) Interactive replies
    if (type === 'interactive') {
      const interactive = msg.interactive;

      // 2.a) Button reply (SHOW_SERVICES)
      if (interactive?.type === 'button_reply') {
        const btnId = interactive.button_reply?.id;
        if (btnId === 'SHOW_SERVICES') {
          await sendServiceList(from);
          return res.sendStatus(200);
        }
      }

      // 2.b) List reply (SERVICE_*)
      if (interactive?.type === 'list_reply') {
        const rowId = interactive.list_reply?.id;
        const chosenTitle =
          interactive.list_reply?.title || serviceIdToTitle(rowId);

        if (rowId && chosenTitle) {
          await sendServiceConfirmation(from, chosenTitle);
          return res.sendStatus(200);
        }
      }
    }

    // Default fallback: show welcome + button
    await sendWelcomeWithButton(from);
    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.sendStatus(200);
  }
});

// Health check
app.get('/', (_req, res) => res.send('Rider Mall WhatsApp bot is running.'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
