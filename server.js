// server.js (ESM) — Rider Mall WhatsApp Bot + Admin Dashboard
// v2025-10-29-b (thumbnails + download + statuses + CSV + filter)
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import { MongoClient, ObjectId } from 'mongodb';

/* ========= SETTINGS ========= */
const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN || 'dev-token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const FALLBACK_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'rider_mall';
const COLLECTION = 'servicerequests';
const API_VERSION = 'v24.0';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

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

/* ========= SESSIONS ========= */
const sessions = new Map();
function setState(wa, state, context = {}) {
  sessions.set(wa, { state, context: { ...(sessions.get(wa)?.context || {}), ...context } });
}
function getState(wa) {
  return sessions.get(wa) || { state: 'IDLE', context: {} };
}

/* ========= EXPRESS ========= */
const app = express();
app.use(express.json({ limit: '2mb' }));
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

    // interactive
    if (type === 'interactive') {
      const btn = msg.interactive?.button_reply;
      const lst = msg.interactive?.list_reply;
      const selectionId = (btn?.id || lst?.id || '').trim();
      await handleSelection(phoneNumberId, from, selectionId);
      return;
    }

    // images (docs step-by-step)
    if (type === 'image') {
      const mediaId = msg.image?.id;

      if (current.state === 'INS_COMP_AWAIT_DOCS') {
        await handleInsuranceDocsImage(phoneNumberId, from, mediaId);
        return;
      }
      if (current.state === 'REG_AWAIT_DOCS') {
        await handleRegistrationDocsImage(phoneNumberId, from, mediaId);
        return;
      }
    }

    // text
    let text = '';
    if (type === 'text') text = msg.text?.body || '';
    const norm = normalize(text);

    // guards while awaiting docs (no greeting reset)
    if (current.state === 'INS_COMP_AWAIT_DOCS') {
      const docs = current.context.docs || [];
      if (docs.length === 0) await sendText(phoneNumberId, from, 'الرجاء إرسال **صورة استمارة الدراجة**.');
      else if (docs.length === 1) await sendText(phoneNumberId, from, 'الرجاء إرسال **صورة الإقامة القطرية للمالك**.');
      return;
    }
    if (current.state === 'REG_AWAIT_DOCS') {
      const docs = current.context.docs || [];
      if (docs.length === 0) await sendText(phoneNumberId, from, 'الرجاء إرسال **صورة استمارة الدراجة**.');
      else if (docs.length === 1) await sendText(phoneNumberId, from, 'الرجاء إرسال **صورة الإقامة القطرية للمالك**.');
      return;
    }

    // insurance comprehensive: expecting bike value
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

    // after quote text
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

    // registration cost confirm — text
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

    // registration slot — text
    if (current.state === 'REG_SLOT_PICK') {
      if (norm.includes('صباح') || norm.includes('am') || norm.includes('sabah')) {
        await finalizeRegistration(phoneNumberId, from, 'صباحي'); return;
      }
      if (norm.includes('مساء') || norm.includes('pm') || norm.includes('masai')) {
        await finalizeRegistration(phoneNumberId, from, 'مسائي'); return;
      }
    }

    // roadside slot — text
    if (current.state === 'RD_BOOKING_SLOT') {
      if (norm.includes('صباح') || norm.includes('am') || norm.includes('sabah')) {
        setState(from, 'RD_COST_CONFIRM', { preferredSlot: 'صباحي' });
        await sendRoadsideCostConfirm(phoneNumberId, from);
        return;
      }
      if (norm.includes('مساء') || norm.includes('pm') || norm.includes('masai')) {
        setState(from, 'RD_COST_CONFIRM', { preferredSlot: 'مسائي' });
        await sendRoadsideCostConfirm(phoneNumberId, from);
        return;
      }
    }

    // roadside cost confirm — text
    if (current.state === 'RD_COST_CONFIRM') {
      if (['موافق','ok','yes','y'].includes(norm)) {
        await finalizeRoadsideBooking(phoneNumberId, from, current.context.preferredSlot || null);
        return;
      }
      if (norm.includes('غير') || norm.includes('no') || norm === 'x') {
        await backToMainMenu(phoneNumberId, from); return;
      }
      return;
    }

    // greetings
    const greetings = ['مرحبا','السلام عليكم','السلام','هاي','hi','hello','start','ابدا','ابدأ','قائمة','menu','help'];
    if (greetings.some(g => norm.includes(g))) {
      await sendWelcomeAndServicesButton(phoneNumberId, from);
      setState(from, 'AWAIT_SERVICES_BUTTON');
      return;
    }

    // default
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
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .toLowerCase()
    .replace(/[آأإ]/g,'ا')
    .replace(/[ة]/g,'ه')
    .replace(/[^\u0600-\u06FFa-z0-9\s.]/g,'');
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

  if (id === 'BTN_SHOW_SERVICES') {
    await sendServicesList(phoneNumberId, wa);
    setState(wa, 'AWAIT_SERVICE_PICK');
    return;
  }

  // services
  if (normalizedId.includes('SRV_INSURANCE') || normalizedId.includes('تأمين') || normalizedId.includes('التأمين')) {
    await sendInsuranceOptions(phoneNumberId, wa);
    setState(wa, 'AWAIT_INSURANCE_TYPE'); return;
  }
  if (normalizedId.includes('SRV_REGISTRATION') || normalizedId.includes('REGISTRATION') || normalizedId.includes('تجديد')) {
    await startRegistrationDocsFlow(phoneNumberId, wa); return;
  }
  if (normalizedId.includes('SRV_ROADSIDE') || normalizedId.includes('ROADSIDE') || normalizedId.includes('مساعد')) {
    await sendRoadsideOptions(phoneNumberId, wa);
    setState(wa, 'RD_PICK'); return;
  }
  if (normalizedId.includes('SRV_MAINTENANCE') || normalizedId.includes('MAINTENANCE') || normalizedId.includes('صيانة')) {
    await sendText(phoneNumberId, wa, 'شكراً لاختياركم خدمة الصيانة ✅ (يتم تفعيلها لاحقًا)');
    setState(wa, 'SRV_MAINTENANCE_INFO'); return;
  }

  // insurance options
  if (normalizedId.includes('INS_COMP')) {
    setState(wa, 'INS_COMP_WAIT_VALUE', { bikeValue: null, premium: null, docs: [] });
    await sendText(phoneNumberId, wa, 'الرجاء إرسال **قيمة الدراجة بالأرقام فقط** (مثال: 80000).');
    return;
  }
  if (normalizedId.includes('INS_TPL')) { await confirmTPL(phoneNumberId, wa); return; }

  // after quote
  if (normalizedId === 'INS_AGREE') { await startInsuranceDocsFlow(phoneNumberId, wa); return; }
  if (normalizedId === 'INS_DISAGREE') { await backToMainMenu(phoneNumberId, wa); return; }
  if (normalizedId === 'INS_SWITCH_TPL') { await confirmTPL(phoneNumberId, wa); return; }

  // registration confirms
  if (normalizedId === 'REG_AGREE') { await sendRegistrationSlotChoice(phoneNumberId, wa); setState(wa,'REG_SLOT_PICK'); return; }
  if (normalizedId === 'REG_DISAGREE') { await backToMainMenu(phoneNumberId, wa); return; }
  if (normalizedId === 'REG_SLOT_AM') { await finalizeRegistration(phoneNumberId, wa, 'صباحي'); return; }
  if (normalizedId === 'REG_SLOT_PM') { await finalizeRegistration(phoneNumberId, wa, 'مسائي'); return; }

  // roadside
  if (normalizedId === 'RD_EMERGENCY') { await finalizeRoadsideEmergency(phoneNumberId, wa); return; }
  if (normalizedId === 'RD_BOOK') { await sendRoadsideSlotChoice(phoneNumberId, wa); setState(wa,'RD_BOOKING_SLOT'); return; }
  if (normalizedId === 'RD_SLOT_AM') { setState(wa,'RD_COST_CONFIRM',{preferredSlot:'صباحي'}); await sendRoadsideCostConfirm(phoneNumberId, wa); return; }
  if (normalizedId === 'RD_SLOT_PM') { setState(wa,'RD_COST_CONFIRM',{preferredSlot:'مسائي'}); await sendRoadsideCostConfirm(phoneNumberId, wa); return; }
  if (normalizedId === 'RD_AGREE') { const { preferredSlot } = getState(wa).context||{}; await finalizeRoadsideBooking(phoneNumberId, wa, preferredSlot||null); return; }
  if (normalizedId === 'RD_DISAGREE') { await backToMainMenu(phoneNumberId, wa); return; }

  await sendText(phoneNumberId, wa, 'خيار غير معروف. الرجاء اختيار خدمة من القائمة:');
  await sendServicesList(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICE_PICK');
}

/* ===== INSURANCE ===== */
async function sendInsuranceComprehensiveQuote(phoneNumberId, to, premium) {
  await sendText(phoneNumberId, to, `تكلفة التأمين ${premium} ريال قطري.\nيرجى الاختيار:`);
  await sendButtons(
    phoneNumberId, to,
    [
      { id: 'INS_AGREE',      title: 'موافق' },
      { id: 'INS_DISAGREE',   title: 'غير موافق' },
      { id: 'INS_SWITCH_TPL', title: 'ضد الغير' }
    ],
    'اختر أحد الخيارات:'
  );
}
async function startInsuranceDocsFlow(phoneNumberId, to) {
  setState(to, 'INS_COMP_AWAIT_DOCS', { docs: [] });
  await sendText(phoneNumberId, to, 'الرجاء إرسال **صورة استمارة الدراجة**.');
}
async function handleInsuranceDocsImage(phoneNumberId, wa, mediaId) {
  const st = getState(wa);
  const ctx = st.context || {};
  const docs = ctx.docs || [];
  if (!mediaId) { await sendText(phoneNumberId, wa, '⚠️ لم أستقبل الصورة، يرجى المحاولة مرة أخرى.'); return; }

  if (docs.length === 0) {
    docs.push({ type: 'image', mediaId, label: 'استمارة الدراجة' });
    setState(wa, 'INS_COMP_AWAIT_DOCS', { docs });
    await sendText(phoneNumberId, wa, '✅ تم استلام **صورة استمارة الدراجة**.\nالرجاء الآن إرسال **صورة الإقامة القطرية للمالك**.');
    return;
  }
  if (docs.length === 1) {
    docs.push({ type: 'image', mediaId, label: 'الإقامة القطرية للمالك' });
    const { bikeValue, premium } = ctx;
    setState(wa, 'DONE', { docs });
    await saveServiceRequest(wa, { id:'SRV_INSURANCE_COMP', label:'تأمين شامل', bikeValue, premium, attachments: docs });
    await sendText(phoneNumberId, wa, '✅ تم استلام جميع الصور.\nشكرًا لاختياركم **خدمات التأمين من رايدر مول**.\nسيتم التواصل معكم قريبًا.');
    return;
  }
  await sendText(phoneNumberId, wa, '✅ تم استلام الصور المطلوبة، لا حاجة لإرسال المزيد.');
}
async function confirmTPL(phoneNumberId, wa) {
  await sendText(phoneNumberId, wa, 'شكراً لاختيارك **التأمين ضد الغير** بتكلفة **400 ريال قطري** ✅');
  await saveServiceRequest(wa, { id:'SRV_INSURANCE_TPL', label:'تأمين ضد الغير', price:400 });
  setState(wa, 'DONE');
}

/* ===== REGISTRATION & FAHES ===== */
async function startRegistrationDocsFlow(phoneNumberId, wa) {
  setState(wa, 'REG_AWAIT_DOCS', { docs: [] });
  await sendText(phoneNumberId, wa, 'الرجاء إرسال **صورة استمارة الدراجة**.');
}
async function handleRegistrationDocsImage(phoneNumberId, wa, mediaId) {
  const st = getState(wa);
  const ctx = st.context || {};
  const docs = ctx.docs || [];
  if (!mediaId) { await sendText(phoneNumberId, wa, '⚠️ لم أستقبل الصورة، يرجى المحاولة مرة أخرى.'); return; }

  if (docs.length === 0) {
    docs.push({ type: 'image', mediaId, label: 'استمارة الدراجة' });
    setState(wa, 'REG_AWAIT_DOCS', { docs });
    await sendText(phoneNumberId, wa, '✅ تم استلام **صورة استمارة الدراجة**.\nالرجاء الآن إرسال **صورة الإقامة القطرية للمالك**.');
    return;
  }
  if (docs.length === 1) {
    docs.push({ type: 'image', mediaId, label: 'الإقامة القطرية للمالك' });
    setState(wa, 'REG_COST_CONFIRM', { docs });
    await sendButtons(
      phoneNumberId, wa,
      [
        { id:'REG_AGREE',    title:'موافق' },
        { id:'REG_DISAGREE', title:'غير موافق' }
      ],
      'الرجاء تأكيد تكلفة النقل **200 ريال قطري**:'
    );
    return;
  }
  await sendText(phoneNumberId, wa, '✅ تم استلام الصور المطلوبة، لا حاجة لإرسال المزيد.');
}
async function sendRegistrationSlotChoice(phoneNumberId, wa) {
  await sendButtons(
    phoneNumberId, wa,
    [
      { id:'REG_SLOT_AM', title:'صباحي' },
      { id:'REG_SLOT_PM', title:'مسائي' }
    ],
    'شكراً للموافقة. الرجاء اختيار الموعد المناسب:'
  );
}
async function finalizeRegistration(phoneNumberId, wa, slot) {
  const st = getState(wa);
  const docs = st.context.docs || [];
  await saveServiceRequest(wa, { id:'SRV_REGISTRATION', label:'تجديد الترخيص وفاحص', price:200, preferredSlot:slot, attachments:docs });
  await sendText(phoneNumberId, wa, `شكراً لاختياركم **خدمات تجديد الترخيص وفاحص**.\nتم تسجيل موعدك (${slot}) ✅\nسيتم التواصل معكم قريبًا.`);
  setState(wa, 'DONE');
}

/* ===== ROADSIDE ===== */
async function sendRoadsideOptions(phoneNumberId, wa) {
  await sendButtons(
    phoneNumberId, wa,
    [
      { id:'RD_EMERGENCY', title:'خدمة طارئة' },
      { id:'RD_BOOK',      title:'حجز موعد' }
    ],
    'شكراً لاختياركم **المساعدة على الطريق**. يرجى الاختيار:'
  );
}
async function finalizeRoadsideEmergency(phoneNumberId, wa) {
  await saveServiceRequest(wa, { id:'SRV_ROADSIDE_EMERGENCY', label:'مساعدة الطريق - طارئة', price:null, preferredSlot:null, attachments:[] });
  await sendText(phoneNumberId, wa, 'شكراً لاستخدامكم **خدمات رايدر مول للمساعدة على الطريق والنقل**.\nسيتم التواصل معكم فورًا.');
  setState(wa, 'DONE');
}
async function sendRoadsideSlotChoice(phoneNumberId, wa) {
  await sendButtons(
    phoneNumberId, wa,
    [
      { id:'RD_SLOT_AM', title:'صباحي' },
      { id:'RD_SLOT_PM', title:'مسائي' }
    ],
    'هل تفضل موعد **صباحي** أم **مسائي**؟'
  );
}
async function sendRoadsideCostConfirm(phoneNumberId, wa) {
  await sendButtons(
    phoneNumberId, wa,
    [
      { id:'RD_AGREE',    title:'موافق' },
      { id:'RD_DISAGREE', title:'غير موافق' }
    ],
    'يرجى تأكيد الموافقة على التكلفة **200 ريال قطري**:'
  );
}
async function finalizeRoadsideBooking(phoneNumberId, wa, slot) {
  await saveServiceRequest(wa, { id:'SRV_ROADSIDE_BOOKING', label:'مساعدة الطريق - حجز', price:200, preferredSlot:slot, attachments:[] });
  await sendText(phoneNumberId, wa, 'شكراً لاستخدامكم **خدمات المساعدة على الطريق والنقل**.\nسيتم التواصل معكم قريبًا.');
  setState(wa, 'DONE');
}

/* ===== COMMON ===== */
async function backToMainMenu(phoneNumberId, wa) {
  await sendText(phoneNumberId, wa, 'تم إلغاء الطلب. بإمكانك اختيار خدمة جديدة من القائمة:');
  await sendWelcomeAndServicesButton(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICES_BUTTON', { bikeValue:null, premium:null, docs:[] });
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

/* ===== WA SENDERS ===== */
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
async function sendWelcomeAndServicesButton(phoneNumberId, to) {
  const welcome = 'أهلاً وسهلاً بكم في رايدر مول – المنصة الشاملة لخدمات الدراجات في قطر.\nالرجاء اختيار الخدمة من القائمة.';
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
          action: { buttons: [ { type:'reply', reply:{ id:'BTN_SHOW_SERVICES', title:'عرض الخدمات' } } ] }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('WA welcome button error:', JSON.stringify(e?.response?.data || { message: e.message }, null, 2));
  }
}
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
              { title:'خدمات Rider Mall',
                rows:[
                  { id:'SRV_INSURANCE',    title:'التأمين' },
                  { id:'SRV_REGISTRATION', title:'التجديد وفاحص' },
                  { id:'SRV_ROADSIDE',     title:'مساعدة الطريق' },
                  { id:'SRV_MAINTENANCE',  title:'الصيانة' }
                ] }
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
              { type:'reply', reply:{ id:'SRV_INSURANCE',    title:'التأمين' } },
              { type:'reply', reply:{ id:'SRV_REGISTRATION', title:'التجديد وفاحص' } },
              { type:'reply', reply:{ id:'SRV_ROADSIDE',     title:'مساعدة الطريق' } }
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
              { type:'reply', reply:{ id:'INS_COMP', title:'شامل (4%)' } },
              { type:'reply', reply:{ id:'INS_TPL',  title:'ضد الغير (400)' } }
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

/* ===================== ADMIN ===================== */
function adminAuth(req, res, next) {
  try {
    const headerKey = req.get('x-admin-key') || '';
    const queryKey = req.query.key || '';
    if (!ADMIN_API_KEY) return res.status(500).send('ADMIN_API_KEY not set.');
    if (headerKey === ADMIN_API_KEY || queryKey === ADMIN_API_KEY) return next();
    return res.status(401).send('Unauthorized');
  } catch { return res.status(401).send('Unauthorized'); }
}

// list with filters
app.get('/api/admin/requests', adminAuth, async (req, res) => {
  try {
    const col = await getCollection();
    const { serviceId, status, limit = '100', page = '1', q = '' } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 100, 500);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

    const filter = {};
    if (serviceId) filter.serviceId = String(serviceId);
    if (status) filter.status = String(status);
    if (q) {
      filter.$or = [
        { waNumber: { $regex: String(q), $options: 'i' } },
        { serviceLabel: { $regex: String(q), $options: 'i' } }
      ];
    }

    const total = await col.countDocuments(filter);
    const items = await col.find(filter).sort({ createdAt: -1 }).skip(skip).limit(lim).toArray();
    res.json({ ok: true, total, page: Number(page), limit: lim, items });
  } catch (e) {
    console.error('Admin list error:', e);
    res.status(500).json({ ok: false, error: 'Admin list failed' });
  }
});

// quick stats
app.get('/api/admin/stats', adminAuth, async (_req, res) => {
  try {
    const col = await getCollection();
    const byService = await col.aggregate([
      { $group: { _id: '$serviceId', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    const total = await col.countDocuments();
    res.json({ ok: true, total, byService });
  } catch (e) {
    console.error('Admin stats error:', e);
    res.status(500).json({ ok: false, error: 'Admin stats failed' });
  }
});

// update status
app.patch('/api/admin/requests/:id/status', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!['new','in_progress','done','canceled'].includes(status)) {
      return res.status(400).json({ ok:false, error:'Invalid status' });
    }
    const col = await getCollection();
    await col.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
    res.json({ ok: true });
  } catch (e) {
    console.error('Admin update status error:', e);
    res.status(500).json({ ok: false, error: 'Update failed' });
  }
});

// export CSV (respects same filters)
app.get('/api/admin/export', adminAuth, async (req, res) => {
  try {
    const col = await getCollection();
    const { serviceId, status, q = '' } = req.query;
    const filter = {};
    if (serviceId) filter.serviceId = String(serviceId);
    if (status) filter.status = String(status);
    if (q) {
      filter.$or = [
        { waNumber: { $regex: String(q), $options: 'i' } },
        { serviceLabel: { $regex: String(q), $options: 'i' } }
      ];
    }
    const items = await col.find(filter).sort({ createdAt: -1 }).toArray();

    const headers = [
      'createdAt','waNumber','serviceId','serviceLabel',
      'bikeValue','premium','price','preferredSlot','status','attachmentsCount'
    ];
    const rows = items.map(it => [
      it.createdAt?.toISOString() || '',
      it.waNumber || '',
      it.serviceId || '',
      it.serviceLabel || '',
      it.bikeValue ?? '',
      it.premium ?? '',
      it.price ?? '',
      it.preferredSlot ?? '',
      it.status ?? '',
      (it.attachments || []).length
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rider_mall_requests.csv"');
    res.send(csv);
  } catch (e) {
    console.error('Admin export error:', e);
    res.status(500).send('Export failed');
  }
});

/* ==== MEDIA PROXY (WhatsApp) ==== */
// 1) GET media info to fetch URL  2) GET the file stream and pipe to client
app.get('/api/admin/media/:mediaId', adminAuth, async (req, res) => {
  const { mediaId } = req.params;
  try {
    // Step 1: get media URL
    const meta = await axios.get(
      `https://graph.facebook.com/${API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = meta.data?.url;
    if (!mediaUrl) return res.status(404).send('No media url');

    // Step 2: fetch the binary with auth and stream
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'stream'
    });

    // Pass through headers (basic)
    if (fileRes.headers['content-type']) res.setHeader('Content-Type', fileRes.headers['content-type']);
    if (fileRes.headers['content-length']) res.setHeader('Content-Length', fileRes.headers['content-length']);

    fileRes.data.pipe(res);
  } catch (e) {
    console.error('Media proxy error:', e?.response?.data || e.message);
    res.status(500).send('Media fetch failed');
  }
});

// Admin Page (updated UI with thumbnails)
app.get('/admin', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Rider Mall — Admin</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Tahoma,Arial;background:#0b0b0b;color:#fff;margin:0}
  header{background:#000;padding:16px 20px;border-bottom:1px solid #111;display:flex;gap:12px;align-items:center}
  .brand{font-weight:700;color:#FFB800}
  .card{background:#111;border:1px solid #1f1f1f;border-radius:14px;padding:16px;margin:16px}
  .controls{display:flex;gap:8px;flex-wrap:wrap}
  input,select,button{padding:10px 12px;border-radius:10px;border:1px solid #222;background:#0f0f0f;color:#fff}
  button{cursor:pointer;background:#FFB800;color:#000;border:none;font-weight:700}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border-bottom:1px solid #222;padding:10px;font-size:14px;vertical-align:top}
  th{text-align:right;color:#aaa}
  .badge{background:#1a1a1a;border:1px solid #2a2a2a;padding:2px 8px;border-radius:999px;font-size:12px}
  .muted{color:#aaa}.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
  .row-actions{display:flex;gap:6px;align-items:center}
  .thumb{width:92px;height:92px;object-fit:cover;border-radius:10px;border:1px solid #222;display:block}
  .att{display:flex;gap:8px;align-items:center;margin-bottom:6px}
  .att a{color:#FFB800;text-decoration:none}
</style>
</head>
<body>
<header><div class="brand">Rider Mall Admin</div><div class="muted">لوحة عرض الطلبات</div></header>
<div class="card">
  <div class="controls">
    <input id="key" type="password" placeholder="أدخل ADMIN_API_KEY"/>
    <input id="q" type="search" placeholder="بحث برقم واتساب أو الخدمة"/>
    <select id="service">
      <option value="">كل الخدمات</option>
      <option value="SRV_INSURANCE_COMP">تأمين شامل</option>
      <option value="SRV_INSURANCE_TPL">تأمين ضد الغير</option>
      <option value="SRV_REGISTRATION">التجديد وفاحص</option>
      <option value="SRV_ROADSIDE_EMERGENCY">مساعدة الطريق - طارئة</option>
      <option value="SRV_ROADSIDE_BOOKING">مساعدة الطريق - حجز</option>
    </select>
    <select id="status">
      <option value="">كل الحالات</option>
      <option value="new">new</option>
      <option value="in_progress">in_progress</option>
      <option value="done">done</option>
      <option value="canceled">canceled</option>
    </select>
    <button id="load">تحميل</button>
    <button id="export">تصدير CSV</button>
    <button id="auto">تشغيل/إيقاف التحديث كل 30ث</button>
  </div>
  <div class="muted" style="margin-top:8px">نصيحة: بعد إدخال المفتاح، سيتم حفظه محليًا في المتصفح.</div>
  <div id="stats" style="margin-top:12px"></div>
  <div id="table"></div>
</div>
<script>
  const elKey=document.getElementById('key');
  const elQ=document.getElementById('q');
  const elService=document.getElementById('service');
  const elStatus=document.getElementById('status');
  const elLoad=document.getElementById('load');
  const elExport=document.getElementById('export');
  const elAuto=document.getElementById('auto');
  const elTable=document.getElementById('table');
  const elStats=document.getElementById('stats');

  const savedKey=localStorage.getItem('rm_admin_key')||''; if(savedKey) elKey.value=savedKey;
  let timer=null;

  function esc(s=''){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
  async function fetchJSON(url, opts={}){
    const key=elKey.value.trim(); if(!key){ alert('أدخل ADMIN_API_KEY'); throw new Error('no key'); }
    localStorage.setItem('rm_admin_key', key);
    const u=new URL(url, window.location.origin);
    const res=await fetch(u.toString(), { ...opts, headers:{ ...(opts.headers||{}), 'x-admin-key': key, 'Content-Type':'application/json' }});
    if(!res.ok){ throw new Error('HTTP '+res.status+': '+(await res.text())); }
    return res.json();
  }
  function mediaUrl(id){
    const key=elKey.value.trim();
    const u=new URL('/api/admin/media/'+id, window.location.origin);
    u.searchParams.set('key', key);
    return u.toString();
  }

  async function load(){
    const q=elQ.value.trim(); const serviceId=elService.value.trim(); const status=elStatus.value.trim();
    const url=new URL('/api/admin/requests', window.location.origin);
    if(q) url.searchParams.set('q', q);
    if(serviceId) url.searchParams.set('serviceId', serviceId);
    if(status) url.searchParams.set('status', status);
    url.searchParams.set('limit','100');

    elTable.innerHTML='<div class="muted">...جاري التحميل</div>';
    try{
      const data=await fetchJSON(url.toString());
      renderTable(data.items||[]);
      await loadStats();
    }catch(e){ elTable.innerHTML='<div style="color:#f66">خطأ: '+esc(e.message)+'</div>'; }
  }

  async function loadStats(){
    try{
      const data=await fetchJSON('/api/admin/stats');
      const rows=(data.byService||[]).map(r=>\`<span class="badge">\${esc(r._id||'غير محدد')}: \${r.count}</span>\`).join(' ');
      elStats.innerHTML=\`<div class="muted">إجمالي الطلبات: \${data.total}</div><div style="margin-top:6px">\${rows}</div>\`;
    }catch{ elStats.innerHTML=''; }
  }

  function statusSelect(current){
    const options=['new','in_progress','done','canceled'].map(s=>\`<option value="\${s}" \${s===current?'selected':''}>\${s}</option>\`).join('');
    return \`<select class="stSel">\${options}</select>\`;
  }

  function renderAtt(att){
    if(!att.mediaId) return '-';
    const url=mediaUrl(att.mediaId);
    return \`
      <div class="att">
        <img class="thumb" src="\${url}" alt="\${esc(att.label||'image')}" />
        <div>
          <div class="mono">\${esc(att.label||'ملف')}</div>
          <a href="\${url}" target="_blank" download>تنزيل</a>
        </div>
      </div>\`;
  }

  function renderTable(items){
    if(!items.length){ elTable.innerHTML='<div class="muted">لا توجد طلبات.</div>'; return; }
    const rows=items.map(it=>{
      const atts=(it.attachments||[]).map(renderAtt).join('');
      return \`
        <tr data-id="\${esc(it._id)}">
          <td class="mono">\${esc(new Date(it.createdAt).toLocaleString())}</td>
          <td class="mono">\${esc(it.waNumber||'')}</td>
          <td>\${esc(it.serviceLabel||it.serviceId||'')}</td>
          <td>
            <div>السعر: \${it.price ?? '-'} | قيمة الدراجة: \${it.bikeValue ?? '-'}</div>
            <div>القسط: \${it.premium ?? '-'}</div>
            <div>الموعد المفضل: \${esc(it.preferredSlot||'-')}</div>
          </td>
          <td>\${atts||'-'}</td>
          <td class="row-actions">
            \${statusSelect(it.status||'new')}
            <button class="saveBtn">حفظ</button>
          </td>
        </tr>\`;
    }).join('');
    elTable.innerHTML=\`
      <table>
        <thead><tr>
          <th>التاريخ</th><th>واتساب</th><th>الخدمة</th><th>تفاصيل</th><th>مرفقات</th><th>الحالة</th>
        </tr></thead>
        <tbody>\${rows}</tbody>
      </table>\`;

    // bind save buttons
    elTable.querySelectorAll('.saveBtn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const tr=btn.closest('tr'); const id=tr.getAttribute('data-id');
        const sel=tr.querySelector('.stSel'); const status=sel.value;
        try{
          await fetchJSON('/api/admin/requests/'+id+'/status', { method:'PATCH', body: JSON.stringify({ status }) });
          btn.textContent='تم ✅'; setTimeout(()=>btn.textContent='حفظ', 1200);
        }catch(e){ btn.textContent='خطأ ❌'; setTimeout(()=>btn.textContent='حفظ', 1500); }
      });
    });
  }

  elLoad.addEventListener('click', load);
  elExport.addEventListener('click', ()=>{
    const key=elKey.value.trim(); if(!key){ alert('أدخل ADMIN_API_KEY'); return; }
    localStorage.setItem('rm_admin_key', key);
    const url=new URL('/api/admin/export', window.location.origin);
    const q=elQ.value.trim(); const serviceId=elService.value.trim(); const status=elStatus.value.trim();
    if(q) url.searchParams.set('q', q);
    if(serviceId) url.searchParams.set('serviceId', serviceId);
    if(status) url.searchParams.set('status', status);
    url.searchParams.set('key', key); // للسماح بالتنزيل في تبويب جديد
    window.open(url.toString(), '_blank');
  });

  elAuto.addEventListener('click', ()=>{
    if(timer){ clearInterval(timer); timer=null; elAuto.textContent='تشغيل/إيقاف التحديث كل 30ث'; return; }
    timer=setInterval(load, 30000); elAuto.textContent='(يعمل) إيقاف التحديث';
  });

  load();
</script>
</body></html>`);
});

/* ===== START ===== */
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server running on port ${PORT}`); });
