// server.js (ESM) — Rider Mall WhatsApp Bot + Admin Dashboard (fixed webhook order)
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

/* ===== VERIFY WEBHOOK (لازم قبل أي middleware) ===== */
app.get('/webhook', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified ✅');
      return res.status(200).send(challenge);
    }
    console.log('Webhook verify failed ❌');
    return res.sendStatus(403);
  } catch (err) {
    console.error('Webhook verify error:', err);
    return res.sendStatus(500);
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/', (_req, res) => res.status(200).send('OK'));

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

    // greetings — NOW: send welcome + list directly
    const greetings = ['مرحبا','السلام عليكم','السلام','هاي','hi','hello','start','ابدا','ابدأ','قائمة','menu','help'];
    if (greetings.some(g => norm.includes(g))) {
      await sendWelcomeWithList(phoneNumberId, from);
      setState(from, 'AWAIT_SERVICE_PICK');
      return;
    }

    // default fallback -> welcome + list as well
    await sendWelcomeWithList(phoneNumberId, from);
    setState(from, 'AWAIT_SERVICE_PICK');
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
  await sendWelcomeWithList(phoneNumberId, wa);
  setState(wa, 'AWAIT_SERVICE_PICK', { bikeValue:null, premium:null, docs:[] });
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

// NEW: welcome with list immediately (no "عرض الخدمات" button)
async function sendWelcomeWithList(phoneNumberId, to) {
  const welcome = 'أهلاً وسهلاً بكم في رايدر مول – المنصة الشاملة لخدمات الدراجات في قطر.\nالرجاء اختيار الخدمة من القائمة.';
  await sendServicesList(phoneNumberId, to, welcome);
}

// Accept custom body text for the list
async function sendServicesList(phoneNumberId, to, bodyText = 'اختر خدمة من القائمة 👇') {
  try {
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
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
app.get('/api/admin/media/:mediaId', adminAuth, async (req, res) => {
  const { mediaId } = req.params;
  try {
    const meta = await axios.get(
      `https://graph.facebook.com/${API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = meta.data?.url;
    if (!mediaUrl) return res.status(404).send('No media url');

    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'stream'
    });

    if (fileRes.headers['content-type']) res.setHeader('Content-Type', fileRes.headers['content-type']);
    if (fileRes.headers['content-length']) res.setHeader('Content-Length', fileRes.headers['content-length']);

    fileRes.data.pipe(res);
  } catch (e) {
    console.error('Media proxy error:', e?.response?.data || e.message);
    res.status(500).send('Media fetch failed');
  }
});

// Admin Page (thumbnails UI)
app.get('/admin', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html> ... (نفس صفحة الأدمن الطويلة كما عندك) ...`);
});

/* ===== START ===== */
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server running on port ${PORT}`); });

// حمايات عامة
process.on('uncaughtException', (e)=>console.error('uncaughtException', e));
process.on('unhandledRejection', (e)=>console.error('unhandledRejection', e));
