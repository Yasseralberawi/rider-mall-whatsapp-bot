// server.js (ESM) — Rider Mall WhatsApp Bot: خطوة 4 (Fix list + fallback buttons)
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import { MongoClient } from 'mongodb';

/* ========= الإعدادات ========= */
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'dev-token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const FALLBACK_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'rider_mall';
const COLLECTION = 'servicerequests';
const API_VERSION = 'v24.0'; // تحديث نسخة الـ Graph API

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

/* ========= جلسات مبسطة في الذاكرة ========= */
const sessions = new Map(); // key: waNumber, value: { state, context:{} }
function setState(wa, state, context = {}) {
  sessions.set(wa, { state, context: { ...(sessions.get(wa)?.context || {}), ...context } });
}
function getState(wa) {
  return sessions.get(wa) || { state: 'IDLE', context: {} };
}

/* ========= تطبيق Express ========= */
const app = express();
app.use(express.json());
app.use(morgan('dev'));

// فحص سريع
app.get('/', (_req, res) => res.status(200).send('OK'));

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
    const from = msg.from; // رقم المرسل (WhatsApp)
    const type = msg.type;

    if (type === 'interactive') {
      const btn = msg.interactive?.button_reply;
      const lst = msg.interactive?.list_reply;
      const selectionId = btn?.id || lst?.id || '';
      await handleSelection(phoneNumberId, from, selectionId);
      return;
    }

    // نص عادي
    let text = '';
    if (type === 'text') text = msg.text?.body || '';
    text = normalize(text);

    // كلمات الترحيب وبدء المحادثة
    const greetings = ['مرحبا','السلام عليكم','السلام','هاي','hi','hello','start','ابدا','ابدأ','قائمة','menu','help'];
    if (greetings.some(g => text.includes(g))) {
      await sendWelcomeAndServicesButton(phoneNumberId, from);
      setState(from, 'AWAIT_SERVICES_BUTTON');
      return;
    }

    // أي نص غير مفهوم -> إعادة إرسال الترحيب + زر الخدمات
    await sendText(phoneNumberId, from, 'أهلا بك في Rider Mall 👋');
    await sendWelcomeAndServicesButton(phoneNumberId, from);
    setState(from, 'AWAIT_SERVICES_BUTTON');
  } catch (e) {
    console.error('Handler error:', e);
  }
});

/* ========= المنطق ========= */
function normalize(s='') {
  return s.trim().toLowerCase()
    .replace(/[آأإ]/g,'ا')
    .replace(/[ة]/g,'ه')
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g,'');
}

// التعامل مع اختيارات الأزرار والقوائم
async function handleSelection(phoneNumberId, wa, id) {
  const { state } = getState(wa);

  // 1) زر "عرض الخدمات" -> نرسل قائمة الخدمات (مع fallback)
  if (id === 'BTN_SHOW_SERVICES') {
    await sendServicesList(phoneNumberId, wa);
    setState(wa, 'AWAIT_SERVICE_PICK');
    return;
  }

  // 2) اختيار خدمة من القائمة
  if (id === 'SRV_INSURANCE' || id === 'SRV_REGISTRATION' || id === 'SRV_ROADSIDE' || id === 'SRV_MAINTENANCE') {
    if (id === 'SRV_INSURANCE') {
      await sendInsuranceOptions(phoneNumberId, wa); // يرسل زرين: شامل / ضد الغير
      setState(wa, 'AWAIT_INSURANCE_TYPE');
    } else if (id === 'SRV_REGISTRATION') {
      await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة تجديد الترخيص وفاحص. (سيتم تفعيل الخطوات التفصيلية في الخطوة القادمة) ✅');
      setState(wa, 'SRV_REGISTRATION_INFO');
    } else if (id === 'SRV_ROADSIDE') {
      await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة المساعدة على الطريق. (سيتم تفعيل السيناريو التفصيلي لاحقًا) ✅');
      setState(wa, 'SRV_ROADSIDE_INFO');
    } else if (id === 'SRV_MAINTENANCE') {
      await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة الصيانة. (سيتم تفعيل السيناريو التفصيلي لاحقًا) ✅');
      setState(wa, 'SRV_MAINTENANCE_INFO');
    }
    return;
  }

  // 3) خيارات التأمين
  if (id === 'INS_COMP') {
    await sendText(phoneNumberId, wa, 'تم اختيار: تأمين شامل. الرجاء الانتظار، سنطلب قيمة الدراجة في الخطوة القادمة ✅');
    setState(wa, 'INS_COMP_WAIT_VALUE'); // سنفعّل استقبال القيمة لاحقًا
    return;
  }
  if (id === 'INS_TPL') {
    await sendText(phoneNumberId, wa, 'شكراً لاختيارك التأمين ضد الغير بتكلفة 400 ريال قطري ✅');
    await saveServiceRequest(wa, { id: 'SRV_INSURANCE_TPL', label: 'تأمين ضد الغير' });
    setState(wa, 'DONE');
    return;
  }

  // غير معروف -> أعد القائمة
  await sendText(phoneNumberId, wa, 'خيار غير معروف. الرجاء اختيار الخدمة من القائمة:');
  await sendServicesList(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICE_PICK');
}

/* ========= حفظ الطلبات ========= */
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

/* ========= إرسال رسائل واتساب ========= */
async function sendText(phoneNumberId, to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to, text: { body } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('WA sendText error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
  }
}

// ترحيب + زر الخدمات
async function sendWelcomeAndServicesButton(phoneNumberId, to) {
  const welcome =
    'أهلاً وسهلاً بكم في رايدر مول – المنصة الشاملة لخدمات الدراجات في قطر.\nالرجاء اختيار الخدمة من القائمة.';
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: welcome },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'BTN_SHOW_SERVICES', title: 'عرض الخدمات' } }
            ]
          }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('WA welcome button error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
  }
}

// قائمة الخدمات (List) + Fallback للأزرار إذا فشلت
async function sendServicesList(phoneNumberId, to) {
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'اختر خدمة من القائمة 👇' },
          action: {
            button: 'الخدمات',
            sections: [
              {
                title: 'خدمات Rider Mall',
                rows: [
                  { id: 'SRV_INSURANCE',   title: 'خدمات التأمين' },
                  { id: 'SRV_REGISTRATION',title: 'خدمات تجديد الترخيص وفاحص' },
                  { id: 'SRV_ROADSIDE',    title: 'خدمات المساعدة على الطريق' },
                  { id: 'SRV_MAINTENANCE', title: 'خدمات الصيانة' }
                ]
              }
            ]
          }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('WA list error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
    // Fallback تلقائي: أزرار (3) + رسالة للصيانة
    await sendServicesButtonsFallback(phoneNumberId, to);
  }
}

// fallback: أزرار بدل اللست
async function sendServicesButtonsFallback(phoneNumberId, to) {
  try {
    // أزرار 3 خدمات
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'اختر خدمة من الأزرار التالية:' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'SRV_INSURANCE',    title: 'التأمين' } },
              { type: 'reply', reply: { id: 'SRV_REGISTRATION', title: 'التجديد وفاحص' } },
              { type: 'reply', reply: { id: 'SRV_ROADSIDE',     title: 'مساعدة الطريق' } }
            ]
          }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    // تنبيه لخيار الصيانة بنص
    await sendText(phoneNumberId, to, 'لخدمة الصيانة: اكتب كلمة "صيانة" أو اخترها من القائمة لاحقًا.');
  } catch (e) {
    console.error('WA fallback buttons error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
  }
}

// خيارات التأمين (شامل / ضد الغير)
async function sendInsuranceOptions(phoneNumberId, to) {
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'تم اختيار خدمات التأمين، يرجى الاختيار:' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'INS_COMP', title: 'تأمين شامل (4%)' } },
              { type: 'reply', reply: { id: 'INS_TPL',  title: 'تأمين ضد الغير (400 ر.ق)' } }
            ]
          }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('WA insurance options error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
  }
}

/* ========= تشغيل السيرفر ========= */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
