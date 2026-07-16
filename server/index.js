import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Redis from "ioredis";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const PANEL_SECRET = process.env.PANEL_SECRET || "concepto2024";
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "900");
const FB_VERSION = "v19.0";
const FB = `https://graph.facebook.com/${FB_VERSION}`;

if (!ANTHROPIC_KEY) { console.error("❌ Falta ANTHROPIC_API_KEY"); process.exit(1); }
if (!META_TOKEN)    { console.error("❌ Falta META_ACCESS_TOKEN");  process.exit(1); }

/* ------------------------------------------------------------------ */
/*  Redis con fallback en memoria                                       */
/* ------------------------------------------------------------------ */
let redis = null;
const memCache = new Map();

if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true, connectTimeout: 5000 });
    redis.on("error", (e) => { console.warn("⚠️ Redis error:", e.message); redis = null; });
    await redis.connect();
    console.log("✅ Redis conectado");
  } catch (e) {
    console.warn("⚠️ Redis no disponible, usando memoria:", e.message);
    redis = null;
  }
}

const cache = {
  async get(k) {
    try {
      if (redis) { const v = await redis.get(k); return v ? JSON.parse(v) : null; }
      const e = memCache.get(k);
      if (!e) return null;
      if (Date.now() > e.exp) { memCache.delete(k); return null; }
      return e.val;
    } catch { return null; }
  },
  async set(k, v, ttl = CACHE_TTL) {
    try {
      if (redis) await redis.setex(k, ttl, JSON.stringify(v));
      else {
        memCache.set(k, { val: v, exp: Date.now() + ttl * 1000 });
        if (memCache.size > 500) { const n = Date.now(); for (const [key, e] of memCache) if (n > e.exp) memCache.delete(key); }
      }
    } catch {}
  },
  async del(k) { try { if (redis) await redis.del(k); else memCache.delete(k); } catch {} }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Graph API helpers                                                   */
/* ------------------------------------------------------------------ */
async function fbGet(path, params = {}) {
  const url = new URL(`${FB}/${path}`);
  url.searchParams.set("access_token", META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message}`);
  return data;
}

/* Convierte rango a date_preset o time_range para la API */
function rangeToParams(range, from, to) {
  if (range === "d7")  return { date_preset: "last_7d" };
  if (range === "d30") return { date_preset: "last_30d" };
  if (range === "custom" && from && to) return { time_range: JSON.stringify({ since: from, until: to }) };
  return { date_preset: "last_7d" };
}

/* Período anterior para comparar costo por mensaje */
function prevRangeParams(range, from, to) {
  if (range === "d7") {
    const end = new Date(Date.now() - 7 * 86400000);
    const start = new Date(Date.now() - 14 * 86400000);
    return { time_range: JSON.stringify({ since: start.toISOString().slice(0,10), until: end.toISOString().slice(0,10) }) };
  }
  if (range === "d30") {
    const end = new Date(Date.now() - 30 * 86400000);
    const start = new Date(Date.now() - 60 * 86400000);
    return { time_range: JSON.stringify({ since: start.toISOString().slice(0,10), until: end.toISOString().slice(0,10) }) };
  }
  if (range === "custom" && from && to) {
    const days = Math.round((new Date(to) - new Date(from)) / 86400000);
    const prevTo = new Date(new Date(from) - 86400000);
    const prevFrom = new Date(prevTo - days * 86400000);
    return { time_range: JSON.stringify({ since: prevFrom.toISOString().slice(0,10), until: prevTo.toISOString().slice(0,10) }) };
  }
  return { date_preset: "last_14d" };
}

const INSIGHT_FIELDS = "spend,impressions,reach,clicks,ctr,actions,action_values,cost_per_action_type";

function extractConversations(actions = []) {
  const a = actions.find(a => a.action_type === "onsite_conversion.messaging_conversation_started_7d"
    || a.action_type === "onsite_conversion.total_messaging_connection");
  return a ? parseFloat(a.value) : 0;
}

function extractCostPerMsg(costPerAction = [], conversations = 0, spend = 0) {
  const c = costPerAction.find(a => a.action_type === "onsite_conversion.messaging_conversation_started_7d"
    || a.action_type === "onsite_conversion.total_messaging_connection");
  if (c) return parseFloat(c.value);
  if (conversations > 0 && spend > 0) return spend / conversations;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Traer métricas de una cuenta via Graph API                          */
/* ------------------------------------------------------------------ */
async function fetchAccountMetrics(accountId, range, from, to) {
  const rp = rangeToParams(range, from, to);
  const prevRp = prevRangeParams(range, from, to);

  // Insights de la cuenta (período actual)
  const [insightsRes, prevInsightsRes, campaignsRes] = await Promise.all([
    fbGet(`act_${accountId}/insights`, {
      fields: INSIGHT_FIELDS,
      level: "account",
      ...rp,
    }),
    fbGet(`act_${accountId}/insights`, {
      fields: "spend,actions,cost_per_action_type",
      level: "account",
      ...prevRp,
    }),
    fbGet(`act_${accountId}/campaigns`, {
      fields: `id,name,status,objective`,
      limit: "20",
    }),
  ]);

  const ins = insightsRes.data?.[0] || {};
  const prevIns = prevInsightsRes.data?.[0] || {};

  const spend = parseFloat(ins.spend || 0);
  const conversations = extractConversations(ins.actions);
  const costPerMsg = extractCostPerMsg(ins.cost_per_action_type, conversations, spend);
  const prevConversations = extractConversations(prevIns.actions);
  const prevSpend = parseFloat(prevIns.spend || 0);
  const prevCostPerMsg = extractCostPerMsg(prevIns.cost_per_action_type, prevConversations, prevSpend);

  // Insights por campaña
  const campaignIds = (campaignsRes.data || []).map(c => c.id);
  let campaignInsights = [];

  if (campaignIds.length > 0) {
    try {
      const batchRes = await fbGet(`act_${accountId}/insights`, {
        fields: INSIGHT_FIELDS,
        level: "campaign",
        ...rp,
        limit: "20",
      });
      campaignInsights = batchRes.data || [];
    } catch (e) {
      console.warn("⚠️ No se pudieron traer insights de campañas:", e.message);
    }
  }

  // Combinar campañas con sus insights
  const campaigns = (campaignsRes.data || [])
    .map(c => {
      const ci = campaignInsights.find(i => i.campaign_id === c.id) || {};
      const cSpend = parseFloat(ci.spend || 0);
      const cConv = extractConversations(ci.actions);
      const cCostMsg = extractCostPerMsg(ci.cost_per_action_type, cConv, cSpend);
      return {
        id: c.id,
        name: c.name,
        status: /ACTIVE/i.test(c.status) ? "activa" : "pausada",
        objective: translateObjective(c.objective),
        spend: cSpend,
        conversations: cConv,
        cost_per_msg: cCostMsg,
        reach: parseInt(ci.reach || 0),
        impressions: parseInt(ci.impressions || 0),
        ctr: parseFloat(ci.ctr || 0),
      };
    })
    .filter(c => c.spend > 0 || c.status === "activa")
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  // Detectar moneda
  let currency = "ARS";
  try {
    const accInfo = await fbGet(`act_${accountId}`, { fields: "currency" });
    currency = accInfo.currency || "ARS";
  } catch {}

  return {
    currency,
    account: {
      spend,
      conversations,
      cost_per_msg: costPerMsg,
      reach: parseInt(ins.reach || 0),
      impressions: parseInt(ins.impressions || 0),
      ctr: parseFloat(ins.ctr || 0),
      clicks: parseInt(ins.clicks || 0),
    },
    prev_cost_per_msg: prevCostPerMsg,
    campaigns,
  };
}

/* ------------------------------------------------------------------ */
/*  Traer anuncios de una campaña via Graph API                         */
/* ------------------------------------------------------------------ */
async function fetchCampaignAds(campaignId, range, from, to) {
  const rp = rangeToParams(range, from, to);

  const [adsRes, insightsRes] = await Promise.all([
    fbGet(`${campaignId}/ads`, { fields: "id,name,status,creative{object_type}", limit: "25" }),
    fbGet(`${campaignId}/insights`, {
      fields: INSIGHT_FIELDS,
      level: "ad",
      ...rp,
      limit: "25",
    }),
  ]);

  const insightsMap = {};
  for (const i of insightsRes.data || []) insightsMap[i.ad_id] = i;

  const ads = (adsRes.data || []).map(ad => {
    const i = insightsMap[ad.id] || {};
    const spend = parseFloat(i.spend || 0);
    const conv = extractConversations(i.actions);
    const costMsg = extractCostPerMsg(i.cost_per_action_type, conv, spend);
    const objType = ad.creative?.object_type || "";
    return {
      id: ad.id,
      name: ad.name,
      status: /ACTIVE/i.test(ad.status) ? "activa" : "pausada",
      format: detectFormat(objType),
      spend,
      conversations: conv,
      cost_per_msg: costMsg,
      reach: parseInt(i.reach || 0),
      impressions: parseInt(i.impressions || 0),
      ctr: parseFloat(i.ctr || 0),
      clicks: parseInt(i.clicks || 0),
    };
  })
  .sort((a, b) => b.spend - a.spend)
  .slice(0, 12);

  return { ads };
}

function translateObjective(obj = "") {
  const map = {
    MESSAGES: "Mensajes", CONVERSIONS: "Conversiones", LINK_CLICKS: "Tráfico",
    VIDEO_VIEWS: "Videos", REACH: "Alcance", BRAND_AWARENESS: "Reconocimiento",
    LEAD_GENERATION: "Clientes potenciales", APP_INSTALLS: "Instalaciones",
    OUTCOME_TRAFFIC: "Tráfico", OUTCOME_ENGAGEMENT: "Interacción",
    OUTCOME_LEADS: "Clientes potenciales", OUTCOME_SALES: "Ventas",
    OUTCOME_AWARENESS: "Reconocimiento", OUTCOME_APP_PROMOTION: "App",
  };
  return map[obj] || obj || "";
}

function detectFormat(objType = "") {
  if (/video/i.test(objType)) return "video";
  if (/carousel/i.test(objType)) return "carrusel";
  if (/collection/i.test(objType)) return "colección";
  return "imagen";
}

/* ------------------------------------------------------------------ */
/*  Análisis IA con Claude (sin MCP)                                   */
/* ------------------------------------------------------------------ */
async function fetchAnalysis(name, phrase, payload) {
  const prompt = `Sos analista senior de Meta Ads en una agencia argentina. Analizá los datos de "${name}" (${phrase}).
Datos: ${JSON.stringify(payload)}
Devolvé SOLO JSON, español rioplatense, con números concretos:
{"veredicto":"estado general en una frase","bueno":["hasta 3 puntos fuertes"],"malo":["hasta 3 problemas con recomendación"]}`;

  const backoffs = [0, 2000, 5000];
  for (const wait of backoffs) {
    if (wait) await sleep(wait);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) { await sleep(5000); continue; }
      if (!res.ok) throw new Error(`Anthropic ${res.status}`);
      const data = await res.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
      const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
      if (a === -1) throw new Error("Sin JSON");
      return JSON.parse(clean.slice(a, b + 1));
    } catch (e) {
      if (wait === 5000) throw e;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Express                                                             */
/* ------------------------------------------------------------------ */
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../client")));

function auth(req, res, next) {
  const token = req.headers["x-panel-secret"] || req.query.secret;
  if (token !== PANEL_SECRET) return res.status(401).json({ error: "No autorizado." });
  next();
}

app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.post("/api/auth", (req, res) => {
  if (req.body.secret !== PANEL_SECRET) return res.status(401).json({ ok: false });
  res.json({ ok: true });
});

app.get("/api/account/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { range = "d7", from, to } = req.query;
  const cacheKey = `acc:${id}:${range === "custom" ? `${from}:${to}` : range}`;

  const cached = await cache.get(cacheKey);
  if (cached) { console.log(`📦 Cache: ${cacheKey}`); return res.json({ ...cached, fromCache: true }); }

  console.log(`🔍 Meta API: cuenta ${id}`);
  try {
    const data = await fetchAccountMetrics(id, range, from, to);
    await cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (e) {
    console.error(`❌ Error cuenta ${id}:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

app.post("/api/account/:id/analysis", auth, async (req, res) => {
  const { id } = req.params;
  const { name, phrase, payload } = req.body;
  const cacheKey = `an:${id}:${phrase}`;

  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  console.log(`🤖 Análisis IA: ${name}`);
  try {
    const data = await fetchAnalysis(name, phrase, payload);
    await cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (e) {
    console.error(`❌ Error análisis:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

app.get("/api/campaign/:id/ads", auth, async (req, res) => {
  const { id } = req.params;
  const { range = "d7", from, to } = req.query;
  const cacheKey = `cr:${id}:${range === "custom" ? `${from}:${to}` : range}`;

  const cached = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  console.log(`🎨 Meta API: creativos campaña ${id}`);
  try {
    const data = await fetchCampaignAds(id, range, from, to);
    await cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (e) {
    console.error(`❌ Error creativos:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "../client/index.html")));

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`\n🚀 Concepto Ads Server en puerto ${PORT}`);
  console.log(`💾 Caché: ${redis ? "Redis" : "Memoria"} | TTL: ${CACHE_TTL}s`);
  console.log(`📡 Graph API: ${FB_VERSION}`);
});
server.on("error", e => { console.error("Error:", e); process.exit(1); });
