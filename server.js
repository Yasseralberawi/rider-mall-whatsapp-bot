// server.js (ESM) — Rider Mall WhatsApp Bot
// v2025-10-29 — Insurance (COMP/TPL) + Registration & Fahes + robust list/buttons
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import { MongoClient } from 'mongodb';

/* ========= SETTINGS ========= */
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'dev-token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const FALLBACK_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'rider_mall';
const COLLECTION = 'servicerequests';
const API_VERSION = 'v24.0'; // per Meta notice

/* ========= MONGO ========= */
let mongoClient;
async function getCollection() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB');
  }
  return mongoClient.db(DB_NAME).collection(COLLECTION);
}

/* ========= SESSIONS (in-memory) ========= */
const sessions = new Map(); // key: waNumber -> { state, context }
function setState(wa, state, context = {}) {
  sessions.set(wa, { state, context: { ...(sessions.get(wa)?.context || {}), ...context } });
}
function getState(wa) {
  return sessions.get(wa) || { state: 'IDLE', context: {} };
}

/* ========= EXPRESS ========= */
const app = express();
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (_req, res) => res.status(200).send('OK'));

/* ===== VERIFY WEBHOOK ===== */
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

/* ===== RECEIVE WEBHOOK ===== */
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

    /* ===== interactive replies ===== */
    if (type === 'interactive') {
      const btn = msg.interactive?.button_reply;
      const lst = msg.interactive?.list_reply;
      const selectionId = (btn?.id || lst?.id || '').trim();
      await handleSelection(phoneNumberId, from, selectionId);
      return;
    }

    /* ===== images (docs upload) ===== */
    if (type === 'image') {
      const mediaId = msg.image?.id;

      // Insurance comprehensive docs (step-by-step)
      if (current.state === 'INS_COMP_AWAIT_DOCS') {
        await handleInsuranceDocsImage(phoneNumberId, from, mediaId);
        return;
      }

      // Registration & Fahes docs
      if (current.state === 'REG_AWAIT_DOCS') {
        await handleRegistrationDocsImage(phoneNumberId, from, mediaId);
        return;
      }
    }

    /* ===== text ===== */
    let text = '';
    if (type === 'text') text = msg.text?.body || '';
    const norm = normalize(text);

    // === GUARD: if waiting insurance docs and user sent text, do NOT greet — just re-prompt ===
    if (current.state === 'INS_COMP_AWAIT_DOCS') {
      const docs = current.context.docs || [];
      if (docs.length === 0) {
        await sendText(phoneNumberId, from, 'الرجاء إرسال **صورة استمارة الدراجة**.');
      } else if (docs.length === 1) {
        await sendText(phoneNumberId, from, 'الرجاء إرسال **صورة الإقامة القطرية للمالك**.');
      }
      return;
    }

    // Insurance comprehensive — expecting bike value
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

    // Insurance comprehensive — after quote: allow text choices, too
    if (current.state === 'INS_COMP_QUOTE_SENT') {
      if (['موافق','ok','yes','y'].includes(norm)) {
        await startInsuranceDocsFlow(phoneNumberId, from); // will ask for form image ONLY
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

    // Registration & Fahes — after cost confirm
    if (current.state === 'REG_COST_CONFIRM') {
      if (['موافق','ok','yes','y'].includes(norm)) {
        await sendRegistrationSlotChoice(phoneNumberId, from);
        setState(from, 'REG_SLOT_PICK');
        return;
      }
      if (norm.includes('غير') || norm.includes('no') || norm === 'x') {
        await backToMainMenu(phoneNumberId, from);
        return;
      }
    }

    // Registration & Fahes — slot pick by text
    if (current.state === 'REG_SLOT_PICK') {
      if (norm.includes('صباح') || norm.includes('am') || norm.includes('sabah')) {
        await finalizeRegistration(phoneNumberId, from, 'صباحي');
        return;
      }
      if (norm.includes('مساء') || norm.includes('pm') || norm.includes('masai')) {
        await finalizeRegistration(phoneNumberId, from, 'مسائي');
        return;
      }
    }

    // greetings
    const greetings = ['مرحبا','السلام عليكم','السلام','هاي','hi','hello','start','ابدا','ابدأ','قائمة','menu','help'];
    if (greetings.some(g => norm.includes(g))) {
      await sendWelcomeAndServicesButton(phoneNumberId, from);
      setState(from, 'AWAIT_SERVICES_BUTTON');
      return;
    }

    // default: send welcome again
    await sendText(phoneNumberId, from, 'أهلاً بك في Rider Mall 👋');
    await sendWelcomeAndServicesButton(phoneNumberId, from);
    setState(from, 'AWAIT_SERVICES_BUTTON');
  } catch (e) {
    console.error('Handler error:', e);
  }
});

/* ========= HELPERS ========= */
function normalize(s='') {
  return s.trim()
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))) // Arabic digits -> English
    .toLowerCase()
    .replace(/[آأإ]/g,'ا')
    .replace(/[ة]/g,'ه')
    .replace(/[^\u0600-\u06FFa-z0-9\s.]/g,''); // keep dot
}
function parseArabicNumber(s='') {
  const digits = s.replace(/[^0-9.]/g,'');
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}

/* ========= FLOW HANDLER ========= */
async function handleSelection(phoneNumberId, wa, idRaw) {
  const { state } = getState(wa);
  const id = (idRaw || '').trim();
  const normalizedId = id.toUpperCase();
  console.log('➡️ User selected option ID:', id, 'Current state:', state);

  // Show services list
  if (id === 'BTN_SHOW_SERVICES') {
    await sendServicesList(phoneNumberId, wa);
    setState(wa, 'AWAIT_SERVICE_PICK');
    return;
  }

  // Main services
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
    await startRegistrationDocsFlow(phoneNumberId, wa); // يبدأ طلب الصور
    return;
  }

  if (
    normalizedId.includes('SRV_ROADSIDE') ||
    normalizedId.includes('ROADSIDE') ||
    normalizedId.includes('مساعد')
  ) {
    await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة المساعدة على الطريق ✅ (سنفعّل السيناريو التفصيلي لاحقًا)');
    setState(wa, 'SRV_ROADSIDE_INFO');
    return;
  }

  if (
    normalizedId.includes('SRV_MAINTENANCE') ||
    normalizedId.includes('MAINTENANCE') ||
    normalizedId.includes('صيانة')
  ) {
    await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة الصيانة ✅ (يتم تفعيلها لاحقًا)');
    setState(wa, 'SRV_MAINTENANCE_INFO');
    return;
  }

  // Insurance options
  if (normalizedId.includes('INS_COMP')) {
    setState(wa, 'INS_COMP_WAIT_VALUE', { bikeValue: null, premium: null, docs: [] });
    await sendText(phoneNumberId, wa, 'الرجاء إرسال **قيمة الدراجة بالأرقام فقط** (مثال: 80000).');
    return;
  }
  if (normalizedId.includes('INS_TPL')) {
    await confirmTPL(phoneNumberId, wa);
    return;
  }

  // After quote: buttons
  if (normalizedId === 'INS_AGREE') {
    await startInsuranceDocsFlow(phoneNumberId, wa); // سيطلب "صورة الاستمارة" فقط
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

  // Registration cost confirm buttons
  if (normalizedId === 'REG_AGREE') {
    await sendRegistrationSlotChoice(phoneNumberId, wa);
    setState(wa, 'REG_SLOT_PICK');
    return;
  }
  if (normalizedId === 'REG_DISAGREE') {
    await backToMainMenu(phoneNumberId, wa);
    return;
  }

  // Registration slot buttons
  if (normalizedId === 'REG_SLOT_AM') {
    await finalizeRegistration(phoneNumberId, wa, 'صباحي');
    return;
  }
  if (normalizedId === 'REG_SLOT_PM') {
    await finalizeRegistration(phoneNumberId, wa, 'مسائي');
    return;
  }

  // Unknown
  await sendText(phoneNumberId, wa, 'خيار غير معروف. الرجاء اختيار الخدمة من القائمة:');
  await sendServicesList(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICE_PICK');
}

/* ===== INSURANCE (COMPREHENSIVE) ===== */
async function sendInsuranceComprehensiveQuote(phoneNumberId, to, premium) {
  await sendText(
    phoneNumberId,
    to,
    `تكلفة التأمين ${premium} ريال قطري.\nيرجى الاختيار:`
  );
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

// ✅ بعد الموافقة على السعر: نطلب "صورة استمارة الدراجة" فقط
async function startInsuranceDocsFlow(phoneNumberId, to) {
  setState(to, 'INS_COMP_AWAIT_DOCS', { docs: [] });
  await sendText(
    phoneNumberId,
    to,
    'الرجاء إرسال **صورة استمارة الدراجة**.'
  );
}

// ===== INSURANCE DOCS FLOW (Step-by-step)
async function handleInsuranceDocsImage(phoneNumberId, wa, mediaId) {
  const st = getState(wa);
  const ctx = st.context || {};
  const docs = ctx.docs || [];

  if (!mediaId) {
    await sendText(phoneNumberId, wa, '⚠️ لم أستقبل الصورة، يرجى المحاولة مرة أخرى.');
    return;
  }

  // الصورة الأولى = استمارة الدراجة
  if (docs.length === 0) {
    docs.push({ type: 'image', mediaId, label: 'استمارة الدراجة' });
    setState(wa, 'INS_COMP_AWAIT_DOCS', { docs });
    await sendText(
      phoneNumberId,
      wa,
      '✅ تم استلام **صورة استمارة الدراجة**.\nالرجاء الآن إرسال **صورة الإقامة القطرية للمالك**.'
    );
    return;
  }

  // الصورة الثانية = الإقامة القطرية
  if (docs.length === 1) {
    docs.push({ type: 'image', mediaId, label: 'الإقامة القطرية للمالك' });

    const { bikeValue, premium } = ctx;
    setState(wa, 'DONE', { docs });

    await saveServiceRequest(wa, {
      id: 'SRV_INSURANCE_COMP',
      label: 'تأمين شامل',
      bikeValue,
      premium,
      attachments: docs,
    });

    await sendText(
      phoneNumberId,
      wa,
      '✅ تم استلام جميع الصور بنجاح.\nشكرًا لاختياركم **خدمات التأمين من رايدر مول**.\nسيتم التواصل معكم من ضمن فريق رايدر مول في أقرب وقت ممكن.'
    );
    return;
  }

  // أكثر من صورتين → تجاهل الباقي
  await sendText(phoneNumberId, wa, '✅ تم استلام الصور المطلوبة، لا حاجة لإرسال المزيد.');
}

async function confirmTPL(phoneNumberId, wa) {
  await sendText(phoneNumberId, wa, 'شكراً لاختيارك **التأمين ضد الغير** بتكلفة **400 ريال قطري** ✅');
  await saveServiceRequest(wa, { id: 'SRV_INSURANCE_TPL', label: 'تأمين ضد الغير', price: 400 });
  setState(wa, 'DONE');
}

/* ===== REGISTRATION & FAHES ===== */
async function startRegistrationDocsFlow(phoneNumberId, wa) {
  setState(wa, 'REG_AWAIT_DOCS', { docs: [] });
  await sendText(
    phoneNumberId,
    wa,
    'شكراً لاختياركم **تجديد الترخيص وفاحص**.\nالرجاء إرسال **صورتين**:\n1) استمارة الدراجة\n2) الإقامة القطرية للمالك'
  );
}
async function handleRegistrationDocsImage(phoneNumberId, wa, mediaId) {
  const st = getState(wa);
  const docs = st.context.docs || [];
  if (mediaId) docs.push({ type: 'image', mediaId });

  if (docs.length < 2) {
    setState(wa, 'REG_AWAIT_DOCS', { docs });
    await sendText(phoneNumberId, wa, `تم استلام الصورة ${docs.length} ✅ — يرجى إرسال الصورة ${docs.length + 1}.`);
    return;
  }

  // Got both images → ask cost confirm (200 QAR)
  setState(wa, 'REG_COST_CONFIRM', { docs });
  await sendButtons(
    phoneNumberId,
    wa,
    [
      { id: 'REG_AGREE',    title: 'موافق' },
      { id: 'REG_DISAGREE', title: 'غير موافق' }
    ],
    'الرجاء تأكيد تكلفة النقل **200 ريال قطري**:'
  );
}
async function sendRegistrationSlotChoice(phoneNumberId, wa) {
  await sendButtons(
    phoneNumberId,
    wa,
    [
      { id: 'REG_SLOT_AM', title: 'صباحي' },
      { id: 'REG_SLOT_PM', title: 'مسائي' }
    ],
    'اختر الموعد المناسب:'
  );
}
async function finalizeRegistration(phoneNumberId, wa, slot) {
  const st = getState(wa);
  const docs = st.context.docs || [];
  await saveServiceRequest(wa, {
    id: 'SRV_REGISTRATION',
    label: 'تجديد الترخيص وفاحص',
    price: 200,
    preferredSlot: slot,
    attachments: docs
  });

  await sendText(
    phoneNumberId,
    wa,
    `شكرًا لاختياركم خدمات **تجديد الترخيص وفاحص**.\nتم تسجيل موعدك (${slot}) ✅\nسيتواصل معك فريق رايدر مول قريبًا.`
  );
  setState(wa, 'DONE');
}

/* ===== COMMON ACTIONS ===== */
async function backToMainMenu(phoneNumberId, wa) {
  await sendText(phoneNumberId, wa, 'تم إلغاء الطلب. بإمكانك اختيار خدمة جديدة من القائمة:');
  await sendWelcomeAndServicesButton(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICES_BUTTON', { bikeValue: null, premium: null, docs: [] });
}

/* ===== PERSISTENCE ===== */
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
      preferredSlot: service.preferredSlot ?? null,
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

/* ===== SENDING HELPERS ===== */
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

/* ===== WELCOME + SERVICES ===== */
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

/* list (<=24 chars per row) + fallback */
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

/* ===== INSURANCE OPTIONS (<=20 chars) ===== */
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

/* ===== START SERVER ===== */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
