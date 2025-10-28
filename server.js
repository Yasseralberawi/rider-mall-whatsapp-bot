// server.js (ESM) — Rider Mall WhatsApp Bot: Services Flow + Diagnostics (v24.0)

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

/* ------------------ ENV & DIAGNOSTICS ------------------ */
function cleanToken(raw = '') {
  return (raw || '').trim().replace(/^[\"']|[\"']$/g, '');
}

const VERIFY_TOKEN = (process.env.VERIFY_TOKEN || 'rider-mall-verify').trim();
const PHONE_ID = (process.env.WHATSAPP_PHONE_ID || '').trim();
process.env.WHATSAPP_TOKEN = cleanToken(process.env.WHATSAPP_TOKEN);
const TOKEN = process.env.WHATSAPP_TOKEN || '';

const GRAPH_VERSION = 'v24.0';
const GRAPH_URL = PHONE_ID
  ? `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/messages`
  : `https://graph.facebook.com/${GRAPH_VERSION}/messages`;

const tokenHead = TOKEN.slice(0, 4);
const tokenTail = TOKEN.slice(-4);
console.log('DIAG: TOKEN length:', TOKEN.length, 'head:', tokenHead, 'tail:', tokenTail);
console.log('DIAG: PHONE_ID present?', Boolean(PHONE_ID), 'valueLen:', PHONE_ID.length);
console.log('DIAG: GRAPH_URL:', GRAPH_URL);
console.log('DIAG: VERIFY_TOKEN length:', VERIFY_TOKEN.length);

/* ------------------ HELPERS ------------------ */
async function sendWhatsApp(payload) {
  if (!TOKEN || TOKEN.length < 50) {
    console.error('ENV ERROR: WHATSAPP_TOKEN يبدو غير صالح (قصير/فارغ).');
    return;
  }
  if (!PHONE_ID || !/^\d{6,}$/.test(PHONE_ID)) {
    console.error('ENV ERROR: WHATSAPP_PHONE_ID مفقود أو ليس أرقامًا صحيحة.');
    return;
  }

  try {
    const { data } = await axios.post(GRAPH_URL, payload, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    return data;
  } catch (err) {
    const resp = err?.response?.data || err.message;
    console.error('WhatsApp API Error:', JSON.stringify(resp, null, 2));
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
    case 'SERVICE_INSURANCE': return 'خدمات التأمين';
    case 'SERVICE_REGISTRATION': return 'خدمات التسجيل';
    case 'SERVICE_TRANSPORT':   return 'خدمات النقل';
    case 'SERVICE_MAINTENANCE': return 'خدمات الصيانة';
    default: return null;
  }
}

function sendServiceConfirmation(to, serviceTitle) {
  const msg = `تم تأكيد خدمة (${serviceTitle})، سيقوم فريق رايدر مول بالتواصل معك.\nسعدنا بخدمتك.`;
  return sendText(to, msg);
}

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

/* ------------------ WEBHOOKS ------------------ */
// Verify (GET)
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

// Receiver (POST)
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (!messages || messages.length === 0) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;

    console.log('Incoming message:', JSON.stringify(msg, null, 2));

    if (type === 'text') {
      const body = msg.text?.body || '';
      await sendWelcomeWithButton(from);
      return res.sendStatus(200);
    }

    if (type === 'interactive') {
      const interactive = msg.interactive;

      if (interactive?.type === 'button_reply') {
        const btnId = interactive.button_reply?.id;
        if (btnId === 'SHOW_SERVICES') {
          await sendServiceList(from);
          return res.sendStatus(200);
        }
      }

      if (interactive?.type === 'list_reply') {
        const rowId = interactive.list_reply?.id;
        const chosenTitle = interactive.list_reply?.title || serviceIdToTitle(rowId);
        if (rowId && chosenTitle) {
          await sendServiceConfirmation(from, chosenTitle);
          return res.sendStatus(200);
        }
      }
    }

    await sendWelcomeWithButton(from);
    return res.sendStatus(200);
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.sendStatus(200);
  }
});

/* ------------------ HEALTH & DEBUG ------------------ */
app.get('/', (_req, res) => res.send('Rider Mall WhatsApp bot is running.'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/debug', (_req, res) => {
  res.json({
    token_length: TOKEN.length,
    token_head: tokenHead,
    token_tail: tokenTail,
    phone_id_present: Boolean(PHONE_ID),
    phone_id_length: PHONE_ID.length,
    graph_url: GRAPH_URL,
    verify_token_length: VERIFY_TOKEN.length,
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
