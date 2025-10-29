// server.js (ESM) — Rider Mall WhatsApp Bot
// خطوة 7: تأمين شامل كامل (قيمة -> 4% -> موافق/غير/ضد الغير -> صور -> شكر + حفظ)
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
const API_VERSION = 'v24.0'; // حسب تحذير Meta

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

/* ========= جلسات مبسطة ========= */
const sessions = new Map(); // key: waNumber -> { state, context }
function setState(wa, state, context = {}) {
  sessions.set(wa, { state, context: { ...(sessions.get(wa)?.context || {}), ...context } });
}
function getState(wa) {
  return sessions.get(wa) || { state: 'IDLE', context: {} };
}

/* ========= Express ========= */
const app = express();
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (_req, res) => res.status(200).send('OK'));

/* Verify Webhook */
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

/* Receive Webhook */
app.post('/webhook', async (req, res) => {
  console.log('Incoming webhook:', JSON.stringify(req.body));
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const phoneNumberId = value?.metadata?.phone_number_id || FALLBACK_PHONE_ID;
    const messages = value?.messages;
    if (!messages || !messages[0] || !phoneNumberId) return;

    const msg = messages[0];
    const from = msg.from;
    const type = msg.type;
    const current = getState(from);

    // 1) تفاعلي (أزرار/قائمة)
    if (type === 'interactive') {
      const btn = msg.interactive?.button_reply;
      const lst = msg.interactive?.list_reply;
      const selectionId = (btn?.id || lst?.id || '').trim();
      await handleSelection(phoneNumberId, from, selectionId);
      return;
    }

    // 2) صور أثناء طلب المستندات للتأمين الشامل
    if (type === 'image' && current.state === 'INS_COMP_AWAIT_DOCS') {
      const mediaId = msg.image?.id;
      await handleInsuranceDocsImage(phoneNumberId, from, mediaId);
      return;
    }

    // 3) نصوص عامة أو ضمن حالة التأمين الشامل
    let text = '';
    if (type === 'text') text = msg.text?.body || '';
    const norm = normalize(text);

    // استقبال قيمة الدراجة أثناء الشامل
    if (current.state === 'INS_COMP_WAIT_VALUE') {
      const num = parseArabicNumber(norm);
      if (Number.isFinite(num) && num > 0) {
        const premium = Math.round(num * 0.04);
        setState(from, 'INS_COMP_QUOTE_SENT', { bikeValue: num, premium });
        await sendInsuranceComprehensiveQuote(phoneNumberId, from, premium);
      } else {
        await sendText(phoneNumberId, from, 'الرجاء إرسال **قيمة الدراجة بالأرقام فقط** (مثال: 80000).');
      }
      return;
    }

    // تحكم في الردود على الموافقة/عدم الموافقة/تحويل ضد الغير بالنص أيضًا
    if (current.state === 'INS_COMP_QUOTE_SENT') {
      if (['موافق','ok','yes','y'].includes(norm)) {
        await startInsuranceDocsFlow(phoneNumberId, from);
        return;
      }
      if (norm.includes('غير') || norm.includes('no') || norm === 'x') {
        await backToMainMenu(phoneNumberId, from);
        return;
      }
      if (norm.includes('ضد') || norm.includes('tpl')) {
        await confirmTPL(phoneNumberId, from);
        return;
      }
    }

    // كلمات بدء المحادثة
    const greetings = ['مرحبا','السلام عليكم','السلام','هاي','hi','hello','start','ابدا','ابدأ','قائمة','menu','help'];
    if (greetings.some(g => norm.includes(g))) {
      await sendWelcomeAndServicesButton(phoneNumberId, from);
      setState(from, 'AWAIT_SERVICES_BUTTON');
      return;
    }

    // أي شيء آخر -> إعادة ترحيب
    await sendText(phoneNumberId, from, 'أهلاً بك في Rider Mall 👋');
    await sendWelcomeAndServicesButton(phoneNumberId, from);
    setState(from, 'AWAIT_SERVICES_BUTTON');
  } catch (e) {
    console.error('Handler error:', e);
  }
});

/* ========= المنطق ========= */
function normalize(s='') {
  return s.trim()
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))) // أرقام عربية -> إنجليزية
    .toLowerCase()
    .replace(/[آأإ]/g,'ا')
    .replace(/[ة]/g,'ه')
    .replace(/[^\u0600-\u06FFa-z0-9\s.]/g,''); // نسمح بنقطة للارقام العشرية
}
function parseArabicNumber(s='') {
  const digits = s.replace(/[^0-9.]/g,'');
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}

async function handleSelection(phoneNumberId, wa, idRaw) {
  const { state } = getState(wa);
  const id = (idRaw || '').trim();
  const normalizedId = id.toUpperCase();
  console.log('➡️ User selected option ID:', id, 'Current state:', state);

  // زر "عرض الخدمات" -> قائمة (مع fallback)
  if (id === 'BTN_SHOW_SERVICES') {
    await sendServicesList(phoneNumberId, wa);
    setState(wa, 'AWAIT_SERVICE_PICK');
    return;
  }

  // خدمات رئيسية
  if (
    normalizedId.includes('SRV_INSURANCE') ||
    normalizedId.includes('INSURANCE') ||
    normalizedId.includes('تأمين') ||
    normalizedId.includes('التأمين')
  ) {
    await sendInsuranceOptions(phoneNumberId, wa);
    setState(wa, 'AWAIT_INSURANCE_TYPE');
    return;
  }
  if (
    normalizedId.includes('SRV_REGISTRATION') ||
    normalizedId.includes('REGISTRATION') ||
    normalizedId.includes('تجديد')
  ) {
    await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة تجديد الترخيص وفاحص ✅');
    setState(wa, 'SRV_REGISTRATION_INFO');
    return;
  }
  if (
    normalizedId.includes('SRV_ROADSIDE') ||
    normalizedId.includes('ROADSIDE') ||
    normalizedId.includes('مساعد')
  ) {
    await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة المساعدة على الطريق ✅');
    setState(wa, 'SRV_ROADSIDE_INFO');
    return;
  }
  if (
    normalizedId.includes('SRV_MAINTENANCE') ||
    normalizedId.includes('MAINTENANCE') ||
    normalizedId.includes('صيانة')
  ) {
    await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة الصيانة ✅');
    setState(wa, 'SRV_MAINTENANCE_INFO');
    return;
  }

  // خيارات التأمين
  if (normalizedId.includes('INS_COMP')) {
    // تأمين شامل -> اطلب قيمة الدراجة
    setState(wa, 'INS_COMP_WAIT_VALUE', { bikeValue: null, premium: null, docs: [] });
    await sendText(phoneNumberId, wa, 'الرجاء إرسال **قيمة الدراجة بالأرقام فقط** (مثال: 80000).');
    return;
  }
  if (normalizedId.includes('INS_TPL')) {
    await confirmTPL(phoneNumberId, wa);
    return;
  }

  // أزرار الموافقة بعد عرض السعر
  if (normalizedId === 'INS_AGREE') {
    await startInsuranceDocsFlow(phoneNumberId, wa);
    return;
  }
  if (normalizedId === 'INS_DISAGREE') {
    await backToMainMenu(phoneNumberId, wa);
    return;
  }
  if (normalizedId === 'INS_SWITCH_TPL') {
    await confirmTPL(phoneNumberId, wa);
    return;
  }

  // غير معروف
  await sendText(phoneNumberId, wa, 'خيار غير معروف. الرجاء اختيار الخدمة من القائمة:');
  await sendServicesList(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICE_PICK');
}

/* ====== مسارات فرعية للتأمين ====== */

// عرض السعر والأزرار بعد إدخال قيمة الدراجة
async function sendInsuranceComprehensiveQuote(phoneNumberId, to, premium) {
  await sendText(
    phoneNumberId,
    to,
    `تكلفة التأمين ${premium} ريال قطري.\nيرجى الاختيار:`
  );
  // أزرار: موافق / غير موافق / ضد الغير
  await sendButtons(
    phoneNumberId,
    to,
    [
      { id: 'INS_AGREE',      title: 'موافق' },
      { id: 'INS_DISAGREE',   title: 'غير موافق' },
      { id: 'INS_SWITCH_TPL', title: 'ضد الغير' }
    ],
    'اختر أحد الخيارات:'
  );
}

// بدء طلب المستندات (صورتين)
async function startInsuranceDocsFlow(phoneNumberId, to) {
  setState(to, 'INS_COMP_AWAIT_DOCS', { docs: [] });
  await sendText(
    phoneNumberId,
    to,
    'الرجاء إرسال **صورتين**:\n1) استمارة الدراجة\n2) الإقامة القطرية للمالك'
  );
}

// استقبال صورة أثناء طلب المستندات
async function handleInsuranceDocsImage(phoneNumberId, wa, mediaId) {
  const st = getState(wa);
  const docs = st.context.docs || [];
  if (mediaId) docs.push({ type: 'image', mediaId });

  if (docs.length < 2) {
    setState(wa, 'INS_COMP_AWAIT_DOCS', { docs });
    await sendText(phoneNumberId, wa, `تم استلام الصورة ${docs.length} ✅ — يرجى إرسال الصورة ${docs.length + 1}.`);
    return;
  }

  // اكتملت الصور
  const { bikeValue, premium } = st.context;
  setState(wa, 'DONE', { docs });
  await saveServiceRequest(wa, {
    id: 'SRV_INSURANCE_COMP',
    label: 'تأمين شامل',
    bikeValue,
    premium,
    attachments: docs
  });

  await sendText(
    phoneNumberId,
    wa,
    'شكرًا لاختياركم خدمات التأمين من رايدر مول.\nسيتواصل معكم فريقنا في أقرب وقت ممكن ✅'
  );
}

// تأكيد التأمين ضد الغير
async function confirmTPL(phoneNumberId, wa) {
  await sendText(phoneNumberId, wa, 'شكراً لاختيارك **التأمين ضد الغير** بتكلفة **400 ريال قطري** ✅');
  await saveServiceRequest(wa, { id: 'SRV_INSURANCE_TPL', label: 'تأمين ضد الغير', price: 400 });
  setState(wa, 'DONE');
}

// رجوع للقائمة الرئيسية
async function backToMainMenu(phoneNumberId, wa) {
  await sendText(phoneNumberId, wa, 'تم إلغاء الطلب. بإمكانك اختيار خدمة جديدة من القائمة:');
  await sendWelcomeAndServicesButton(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICES_BUTTON', { bikeValue: null, premium: null, docs: [] });
}

/* ========= حفظ الطلبات ========= */
async function saveServiceRequest(waNumber, service) {
  try {
    const col = await getCollection();
    const doc = {
      waNumber,
      serviceId: service.id,
      serviceLabel: service.label,
      bikeValue: service.bikeValue ?? null,
      premium: service.premium ?? null,
      price: service.price ?? null,
      attachments: service.attachments ?? [],
      status: 'new',
      createdAt: new Date()
    };
    await col.insertOne(doc);
    console.log('💾 Saved service request:', doc);
  } catch (e) {
    console.error('Mongo save error:', e);
  }
}

/* ========= إرسال رسائل ========= */
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

async function sendButtons(phoneNumberId, to, buttonsArr, bodyText) {
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText || 'اختر:' },
          action: {
            buttons: buttonsArr.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } }))
          }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('WA buttons error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
  }
}

/* ترحيب + زر “عرض الخدمات” */
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

/* قائمة الخدمات (list) — عناوين قصيرة (≤ 24) + Fallback */
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
                  { id: 'SRV_INSURANCE',    title: 'التأمين' },
                  { id: 'SRV_REGISTRATION', title: 'التجديد وفاحص' },
                  { id: 'SRV_ROADSIDE',     title: 'مساعدة الطريق' },
                  { id: 'SRV_MAINTENANCE',  title: 'الصيانة' }
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
    await sendServicesButtonsFallback(phoneNumberId, to);
  }
}

/* Fallback: أزرار قصيرة العناوين (≤ 20) */
async function sendServicesButtonsFallback(phoneNumberId, to) {
  try {
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
    await sendText(phoneNumberId, to, 'لخدمة الصيانة: اكتب "صيانة" أو اخترها من القائمة لاحقًا.');
  } catch (e) {
    console.error('WA fallback buttons error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
  }
}

/* خيارات التأمين — عناوين ≤ 20 */
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
              { type: 'reply', reply: { id: 'INS_COMP', title: 'شامل (4%)' } },
              { type: 'reply', reply: { id: 'INS_TPL',  title: 'ضد الغير (400)' } }
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

/* ========= تشغيل ========= */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
