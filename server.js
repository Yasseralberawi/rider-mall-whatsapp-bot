// server.js  (ESM)
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';

const app = express();
app.use(express.json());
app.use(morgan('dev')); // يطبع كل الطلبات في اللوجز

// فحص سريع — لازم يرجّع OK وتظهر سطور في اللوجز
app.get('/', (_req, res) => {
  console.log('GET / hit ✅');
  res.status(200).send('OK');
});

// تحقق الويبهوك (GET) — استخدم نفس VERIFY_TOKEN الموجود في Meta
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN =
    process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'dev-token';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified ✅');
    return res.status(200).send(challenge);
  }
  console.log('Webhook verify failed ❌');
  return res.sendStatus(403);
});

// استقبال رسائل واتساب (POST)
app.post('/webhook', (req, res) => {
  console.log('Incoming webhook:', JSON.stringify(req.body));
  // مهم جدًا: رجّع 200 فورًا
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;
    const phoneNumberId = changes?.value?.metadata?.phone_number_id;

    if (messages && messages[0]?.type === 'text') {
      const from = messages[0].from;
      const text = messages[0].text?.body || '';
      sendWhatsAppMessage(phoneNumberId, from, `Echo: ${text}`).catch(e =>
        console.error('Send msg error:', e?.response?.data || e.message)
      );
    }
  } catch (e) {
    console.error('Handler error:', e);
  }
});

async function sendWhatsAppMessage(phoneNumberId, to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token || !phoneNumberId) {
    console.error('Missing token or phoneNumberId');
    return;
  }
  await axios.post(
    `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, text: { body } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

// تشغيل السيرفر على بورت Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
