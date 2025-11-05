// server.js (ESM) — Rider Mall WhatsApp Bot + Admin Dashboard (fixed webhook 502)
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

/* ========= EXPRESS ========= */
const app = express();

// ✅ وضع التحقق من الـ webhook قبل أي middleware آخر
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

// ================= باقي كودك كما هو بدون حذف أي شيء =================
// (انسخ كل المحتوى الذي أرسلته سابقًا كما هو بعد هذا السطر)
