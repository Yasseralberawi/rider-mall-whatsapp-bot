// server.js (ESM) — Rider Mall WhatsApp Bot
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import { MongoClient } from 'mongodb';

/* ========= إعدادات ========= */
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'dev-token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const FALLBACK_PHONE_ID = process.env.WHATSAPP_PHONE_ID; // احتياطي عند غياب phone_number_id من الWebhook
const MONGODB_URI = process.env.MONGODB_URI; // يجب أن يحوي مستخدم/كلمة مرور صحيحة
const DB_NAME = 'rider_mall';
const COLLECTION = 'servicerequests';

/* ========= اتصال Mongo ========= */
let mongoClient;
async function getCollection() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB');
  }
  return mongoClient.db(DB_NAME).collection(COLLECTION);
}

/* ========= تطبيق Express ========= */
const app = express();
app.use(express.json());
app.use(morgan('dev')); // يطبع كل الطلبات في اللوجز

// فحص سريع
app.get('/', (_req, res) => {
  console.log('GET / hit ✅');
  res.status(200).send('OK');
});

// Verify Webhook (GET)
app.get('/webhook', (req, res) => {
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
app.post('/webhook', async (req, res) => {
  console.log('Incoming webhook:', JSON.stringify(req.body));
  res.sendStatus(200); // مهم: رجّع 200 فورًا

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const phoneNumberId = value?.metadata?.phone_number_id || FALLBACK_PHONE_ID;
    const messages = value?.messages;

    if (!messages || !messages[0] || !phoneNumberId) return;

    const msg = messages[0];
    const from = msg.from;                 // رقم المرسل
    const type = msg.type;

    if (type === 'interactive') {
      // أزرار منيو أو لائحة
      const button_reply = msg.interactive?.button_reply;
      const list_reply = msg.interactive?.list_reply;
      const selectionId = button_reply?.id || list_reply?.id || '';
      await handleSelection(phoneNumberId, from, selectionId);
      return;
    }

    // نص عادي
    let text = '';
    if (type === 'text') text = msg.text?.body || '';
    text = normalize(text);

    // كلمات تشغيل المنيو
    if (['hi','مرحبا','menu','start','ابدأ','ابدا','help','قائمة','منيو'].includes(text)) {
      await sendMainMenu(phoneNumberId, from);
      return;
    }

    // اختصارات مباشرة للخدمات
    const matched = matchService(text);
    if (matched) {
      await saveServiceRequest(from, matched);
      await sendText(phoneNumberId, from, `تم استلام طلبك لخدمة: ${matched.label} ✅\nسيتواصل معك فريق Rider Mall قريبًا.`);
      return;
    }

    // إن لم يُفهم النص، أرسل المنيو
    await sendText(phoneNumberId, from, 'أهلا بك في Rider Mall 👋\nاختر من القائمة التالية:');
    await sendMainMenu(phoneNumberId, from);
  } catch (e) {
    console.error('Handler error:', e);
  }
});

/* ========= المنطق المساعد ========= */

function normalize(s='') {
  return s.trim().toLowerCase()
    .replace(/[آأإ]/g,'ا')
    .replace(/[ة]/g,'ه')
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g,'');
}

const SERVICES = [
  { id: 'SRV_INSURANCE',   label: 'تأمين المركبة' , keywords: ['تامين','تأمين','insurance'] },
  { id: 'SRV_REGISTRATION',label: 'تجديد التسجيل', keywords: ['تجديد','تسجيل','استماره','registration'] },
  { id: 'SRV_ROADSIDE',    label: 'مساعدة طريق',   keywords: ['مساعده','طريق','سطحه','roadside'] },
  { id: 'SRV_SHOP',        label: 'متجر Rider Mall', keywords: ['shop','متجر','اكسسوارات'] },
  { id: 'SRV_CONTACT',     label: 'التواصل مع فريق الدعم', keywords: ['تواصل','support','help','اتصال'] },
];

function matchService(text) {
  for (const s of SERVICES) {
    if (s.keywords.some(k => text.includes(k))) return s;
  }
  return null;
}

async function handleSelection(phoneNumberId, to, selectionId) {
  const service = SERVICES.find(s => s.id === selectionId);
  if (!service) {
    await sendText(phoneNumberId, to, 'خيار غير معروف. اختر من القائمة التالية:');
    await sendMainMenu(phoneNumberId, to);
    return;
  }
  // حفظ الطلب
  await saveServiceRequest(to, service);
  // رد تأكيد
  if (service.id === 'SRV_SHOP') {
    await sendText(phoneNumberId, to, 'تفضل متجر Rider Mall 🛒\nhttps://ridermall.qa/shop');
  } else if (service.id === 'SRV_CONTACT') {
    await sendText(phoneNumberId, to, 'تم تحويلك للدعم 📞\nسنتواصل معك قريبًا.');
  } else {
    await sendText(phoneNumberId, to, `تم استلام طلبك لخدمة: ${service.label} ✅\nسيتواصل معك فريق Rider Mall قريبًا.`);
  }
}

async function saveServiceRequest(waNumber, service) {
  try {
    const col = await getCollection();
    const doc = {
      waNumber,
      serviceId: service.id,
      serviceLabel: service.label,
      status: 'new',
      createdAt: new Date()
    };
    await col.insertOne(doc);
    console.log('💾 Saved service request:', doc);
  } catch (e) {
    console.error('Mongo save error:', e);
  }
}

/* ========= رسائل واتساب ========= */

async function sendText(phoneNumberId, to, body) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function sendMainMenu(phoneNumberId, to) {
  // Buttons menu (سريعة وبسيطة)
  const buttons = [
    { type: 'reply', reply: { id: 'SRV_INSURANCE',   title: 'تأمين' } },
    { type: 'reply', reply: { id: 'SRV_REGISTRATION',title: 'تجديد' } },
    { type: 'reply', reply: { id: 'SRV_ROADSIDE',    title: 'مساعدة' } },
  ];

  await axios.post(
    `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'اختر خدمة من Rider Mall 👇' },
        action: { buttons }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );

  // زر إضافي بإرسال رابط المتجر/الدعم كنص لاحقًا:
  await sendText(phoneNumberId, to, 'تقدر تكتب: متجر / تواصل لخيارات إضافية.');
}

/* ========= تشغيل السيرفر ========= */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
