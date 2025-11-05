// server.js (ESM) — Rider Mall WhatsApp Bot + Admin Dashboard (webhook 502 fixed)
import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import { MongoClient, ObjectId } from 'mongodb';
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

/* ===== VERIFY WEBHOOK ===== */
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
    res.sendStatus(500);
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
// استخدم رقم واتساب الحقيقي من ENV دائماً
const phoneNumberId = FALLBACK_PHONE_ID || value?.metadata?.phone_number_id;

// ولو حاب تمنع أي ID وهمي من اختبارات Meta:
const metaId = value?.metadata?.phone_number_id;
if (metaId && metaId !== '123456123') {
  // ممكن ترجع له فقط إذا كان حقيقي (اختياري)
  // phoneNumberId = metaId;
}
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
  console.log('🔹 Interactive payload:', JSON.stringify(msg.interactive));
  console.log('➡️ User selected option ID:', selectionId);
  await handleSelection(phoneNumberId, from, selectionId);
  return;
}
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

// باقي الكود بنفس نسختك السابقة تمامًا ⬇️
// (كل شيء من handleSelection إلى sendInsuranceOptions إلى /admin HTML page إلى النهاية)


// ===== START SERVER =====
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));

process.on('uncaughtException', e => console.error('❌ uncaughtException', e));
process.on('unhandledRejection', e => console.error('❌ unhandledRejection', e));



