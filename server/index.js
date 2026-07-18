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

/* Redis con fallback en memoria */
let redis = null;
const memCache = new Map();
if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true, connectTimeout: 5000 });
    redis.on("error", e => { console.warn("⚠️ Redis:", e.message); redis = null; });
    await redis.connect();
    console.log("✅ Redis conectado");
  } catch (e) { console.warn("⚠️ Redis no disponible:", e.message); redis = null; }
}

const cache = {
  async get(k) {
    try {
      if (redis) { const v = await redis.get(k); return v ? JSON.parse(v) : null; }
      const e = memCache.get(k);
      if (!e || Date.now() > e.exp) { memCache.delete(k); return null; }
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
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fbGet(endpoint, params = {}) {
  const url = new URL(`${FB}/${endpoint}`);
  url.searchParams.set("access_token", META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message}`);
  return data;
}

function rangeToParams(range, from, to) {
  if (range === "d7")  return { date_preset: "last_7d" };
  if (range === "d30") return { date_preset: "last_30d" };
  if (range === "custom" && from && to) return { time_range: JSON.stringify({ since: from, until: to }) };
  return { date_preset: "last_7d" };
}

function prevRangeParams(range, from, to) {
  const D = 86400000;
  if (range === "d7") return { time_range: JSON.stringify({ since: new Date(Date.now()-14*D).toISOString().slice(0,10), until: new Date(Date.now()-7*D).toISOString().slice(0,10) }) };
  if (range === "d30") return { time_range: JSON.stringify({ since: new Date(Date.now()-60*D).toISOString().slice(0,10), until: new Date(Date.now()-30*D).toISOString().slice(0,10) }) };
  if (range === "custom" && from && to) {
    const days = Math.round((new Date(to) - new Date(from)) / D);
    const prevTo = new Date(new Date(from) - D);
    const prevFrom = new Date(+prevTo - days * D);
    return { time_range: JSON.stringify({ since: prevFrom.toISOString().slice(0,10), until: prevTo.toISOString().slice(0,10) }) };
  }
  return { date_preset: "last_14d" };
}

const INS_FIELDS = "campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,actions,cost_per_action_type";
const ACC_FIELDS = "spend,impressions,reach,clicks,ctr,actions,cost_per_action_type";
const MSG_TYPES = [
  "onsite_conversion.messaging_conversation_started_7d",
  "onsite_conversion.total_messaging_connection",
  "onsite_conversion.messaging_first_reply",
];

function extractConv(actions = []) {
  for (const t of MSG_TYPES) { const a = (actions||[]).find(x => x.action_type === t); if (a) return parseFloat(a.value); }
  return 0;
}
function extractCPM(cpa = [], conv = 0, spend = 0) {
  for (const t of MSG_TYPES) { const c = (cpa||[]).find(x => x.action_type === t); if (c) return parseFloat(c.value); }
  if (conv > 0 && spend > 0) return spend / conv;
  return null;
}
function extractAction(actions = [], type) {
  const a = (actions||[]).find(x => x.action_type === type);
  return a ? parseFloat(a.value) : 0;
}
function translateObj(obj = "") {
  const m = { MESSAGES:"Mensajes",CONVERSIONS:"Conversiones",LINK_CLICKS:"Tráfico",VIDEO_VIEWS:"Videos",REACH:"Alcance",BRAND_AWARENESS:"Reconocimiento",LEAD_GENERATION:"Leads",APP_INSTALLS:"App",OUTCOME_TRAFFIC:"Tráfico",OUTCOME_ENGAGEMENT:"Interacción",OUTCOME_LEADS:"Leads",OUTCOME_SALES:"Ventas",OUTCOME_AWARENESS:"Reconocimiento",OUTCOME_APP_PROMOTION:"App" };
  return m[obj] || obj || "";
}
function detectFormat(t = "") {
  if (/video/i.test(t)) return "video";
  if (/carousel/i.test(t)) return "carrusel";
  if (/collection/i.test(t)) return "colección";
  return "imagen";
}

/* ------------------------------------------------------------------ */
/*  Métricas de cuenta                                                  */
/* ------------------------------------------------------------------ */
async function fetchAccountMetrics(accountId, range, from, to) {
  const rp = rangeToParams(range, from, to);
  const prevRp = prevRangeParams(range, from, to);

  const [accIns, prevAccIns, campIns, accInfo] = await Promise.all([
    fbGet(`act_${accountId}/insights`, { fields: ACC_FIELDS, level: "account", ...rp }),
    fbGet(`act_${accountId}/insights`, { fields: "spend,actions,cost_per_action_type", level: "account", ...prevRp }),
    fbGet(`act_${accountId}/insights`, { fields: INS_FIELDS, level: "campaign", ...rp, limit: "25", sort: "spend_descending" }),
    fbGet(`act_${accountId}`, { fields: "currency,name" }),
  ]);

  const ins = accIns.data?.[0] || {};
  const prevIns = prevAccIns.data?.[0] || {};
  const spend = parseFloat(ins.spend || 0);
  const conv = extractConv(ins.actions);

  // Seguidores e interacciones IG desde acciones de los anuncios
  const igFollows = extractAction(ins.actions, "follow");
  const igProfileVisits = extractAction(ins.actions, "onsite_conversion.post_save") + extractAction(ins.actions, "page_engagement");

  // Intentar traer seguidores IG reales si la cuenta tiene IG conectado
  let igFollowersDelta = igFollows; // fallback: seguidores por anuncios
  try {
    const igRes = await fbGet(`act_${accountId}`, { fields: "instagram_actor_id" });
    if (igRes.instagram_actor_id) {
      const igInsights = await fbGet(`${igRes.instagram_actor_id}/insights`, {
        metric: "follower_count",
        period: "day",
        ...rp,
      });
      if (igInsights.data?.[0]?.values) {
        const vals = igInsights.data[0].values;
        igFollowersDelta = vals.reduce((s, v) => s + (v.value || 0), 0);
      }
    }
  } catch { /* sin IG conectado, usamos el fallback */ }

  // Campañas
  const campInsData = campIns.data || [];
  let campMeta = {};
  if (campInsData.length > 0) {
    try {
      const ids = campInsData.map(c => c.campaign_id).filter(Boolean);
      const metaRes = await fbGet(`act_${accountId}/campaigns`, {
        fields: "id,name,status,objective",
        filtering: JSON.stringify([{ field: "id", operator: "IN", value: ids }]),
        limit: "50",
      });
      for (const c of metaRes.data || []) campMeta[c.id] = c;
    } catch (e) { console.warn("⚠️ campMeta:", e.message); }
  }

  const campaigns = campInsData
    .filter(c => c.campaign_id)
    .map(c => {
      const meta = campMeta[c.campaign_id] || {};
      const cSpend = parseFloat(c.spend || 0);
      const cConv = extractConv(c.actions);
      return {
        id: c.campaign_id,
        name: c.campaign_name || meta.name || "Sin nombre",
        status: /ACTIVE/i.test(meta.status || "") ? "activa" : "pausada",
        objective: translateObj(meta.objective),
        spend: cSpend,
        conversations: cConv,
        cost_per_msg: extractCPM(c.cost_per_action_type, cConv, cSpend),
        reach: parseInt(c.reach || 0),
        impressions: parseInt(c.impressions || 0),
        ctr: parseFloat(c.ctr || 0),
        ig_follows: extractAction(c.actions, "follow"),
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  const prevSpend = parseFloat(prevIns.spend || 0);
  const prevConv = extractConv(prevIns.actions);

  return {
    currency: accInfo.currency || "ARS",
    account: {
      spend, conversations: conv,
      cost_per_msg: extractCPM(ins.cost_per_action_type, conv, spend),
      reach: parseInt(ins.reach||0),
      impressions: parseInt(ins.impressions||0),
      ctr: parseFloat(ins.ctr||0),
      clicks: parseInt(ins.clicks||0),
      ig_follows: igFollowersDelta,
      ig_profile_visits: Math.round(igProfileVisits),
    },
    prev_cost_per_msg: extractCPM(prevIns.cost_per_action_type, prevConv, prevSpend),
    campaigns,
  };
}

/* ------------------------------------------------------------------ */
/*  Audiencia de campaña (4 breakdowns en paralelo)                    */
/* ------------------------------------------------------------------ */
async function fetchCampaignAudience(campaignId, range, from, to) {
  const rp = rangeToParams(range, from, to);
  const BASE = { fields: "spend,impressions,reach,actions", level: "campaign", ...rp, limit: "50" };

  const [genderRes, ageRes, platformRes, regionRes] = await Promise.allSettled([
    fbGet(`${campaignId}/insights`, { ...BASE, breakdowns: "gender" }),
    fbGet(`${campaignId}/insights`, { ...BASE, breakdowns: "age" }),
    fbGet(`${campaignId}/insights`, { ...BASE, breakdowns: "publisher_platform" }),
    fbGet(`${campaignId}/insights`, { ...BASE, breakdowns: "region" }),
  ]);

  function toRows(settled) {
    if (settled.status !== "fulfilled") return [];
    return settled.value.data || [];
  }

  function toPct(rows, key) {
    const total = rows.reduce((s, r) => s + parseFloat(r.impressions || 0), 0);
    if (!total) return [];
    return rows
      .map(r => ({ label: r[key] || "Otro", pct: Math.round(parseFloat(r.impressions||0) / total * 100), reach: parseInt(r.reach||0), spend: parseFloat(r.spend||0) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 8);
  }

  const genderRows = toRows(genderRes);
  const ageRows = toRows(ageRes);
  const platformRows = toRows(platformRes);
  const regionRows = toRows(regionRes);

  const translateGender = g => g === "female" ? "Mujeres" : g === "male" ? "Hombres" : "Otro";
  const translatePlatform = p => ({ facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger" }[p] || p);

  return {
    gender: toPct(genderRows, "gender").map(r => ({ ...r, label: translateGender(r.label) })),
    age: toPct(ageRows, "age"),
    platform: toPct(platformRows, "publisher_platform").map(r => ({ ...r, label: translatePlatform(r.label) })),
    region: toPct(regionRows, "region").slice(0, 6),
  };
}

/* ------------------------------------------------------------------ */
/*  Creativos de campaña                                                */
/* ------------------------------------------------------------------ */
async function fetchCampaignAds(campaignId, range, from, to) {
  const rp = rangeToParams(range, from, to);
  const [adsRes, insRes] = await Promise.all([
    fbGet(`${campaignId}/ads`, { fields: "id,name,status,creative{id,object_type,thumbnail_url,image_url}", limit: "50" }),
    fbGet(`${campaignId}/insights`, { fields: "ad_id,spend,impressions,reach,clicks,ctr,actions,cost_per_action_type", level: "ad", ...rp, limit: "50" }),
  ]);

  const insMap = {};
  for (const i of insRes.data || []) if (i.ad_id) insMap[i.ad_id] = i;

  const ads = (adsRes.data || [])
    .map(ad => {
      const i = insMap[ad.id] || {};
      const spend = parseFloat(i.spend || 0);
      const conv = extractConv(i.actions);
      const cr = ad.creative || {};
      return {
        id: ad.id, name: ad.name,
        status: /ACTIVE/i.test(ad.status) ? "activa" : "pausada",
        format: detectFormat(cr.object_type || ""),
        thumbnail_url: cr.thumbnail_url || cr.image_url || null,
        spend, conversations: conv,
        cost_per_msg: extractCPM(i.cost_per_action_type, conv, spend),
        reach: parseInt(i.reach||0), impressions: parseInt(i.impressions||0),
        ctr: parseFloat(i.ctr||0), clicks: parseInt(i.clicks||0),
        ig_follows: extractAction(i.actions, "follow"),
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 12);

  return { ads };
}

/* ------------------------------------------------------------------ */
/*  Análisis IA                                                         */
/* ------------------------------------------------------------------ */
async function fetchAnalysis(name, phrase, payload) {
  const prompt = `Sos analista senior de Meta Ads en una agencia argentina. Analizá los datos de "${name}" (${phrase}).
Datos: ${JSON.stringify(payload)}
Devolvé SOLO JSON, español rioplatense, con números concretos:
{"veredicto":"estado general en una frase","bueno":["hasta 3 puntos fuertes"],"malo":["hasta 3 problemas con recomendación"]}`;
  for (const wait of [0, 3000, 8000]) {
    if (wait) await sleep(wait);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) continue;
      if (!res.ok) throw new Error(`Anthropic ${res.status}`);
      const data = await res.json();
      const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
      const clean = text.replace(/```json/gi,"").replace(/```/g,"").trim();
      const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
      if (a===-1) throw new Error("Sin JSON");
      return JSON.parse(clean.slice(a, b+1));
    } catch(e) { if (wait===8000) throw e; }
  }
}

/* ------------------------------------------------------------------ */
/*  Express                                                             */
/* ------------------------------------------------------------------ */
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../client")));

function auth(req, res, next) {
  const t = req.headers["x-panel-secret"] || req.query.secret;
  if (t !== PANEL_SECRET) return res.status(401).json({ error: "No autorizado." });
  next();
}

app.get("/health", (_, res) => res.json({ ok: true }));
app.post("/api/auth", (req, res) => { if (req.body.secret !== PANEL_SECRET) return res.status(401).json({ ok: false }); res.json({ ok: true }); });

app.get("/api/account/:id", auth, async (req, res) => {
  const { id } = req.params;
  const { range="d7", from, to } = req.query;
  const ck = `acc:${id}:${range==="custom"?`${from}:${to}`:range}`;
  const cached = await cache.get(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try { const data = await fetchAccountMetrics(id, range, from, to); await cache.set(ck, data); res.json({ ...data, fromCache: false }); }
  catch(e) { console.error(`❌ cuenta ${id}:`, e.message); res.status(503).json({ error: e.message }); }
});

app.post("/api/account/:id/analysis", auth, async (req, res) => {
  const { id } = req.params;
  const { name, phrase, payload } = req.body;
  const ck = `an:${id}:${phrase}`;
  const cached = await cache.get(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try { const data = await fetchAnalysis(name, phrase, payload); await cache.set(ck, data); res.json({ ...data, fromCache: false }); }
  catch(e) { res.status(503).json({ error: e.message }); }
});

app.get("/api/campaign/:id/ads", auth, async (req, res) => {
  const { id } = req.params;
  const { range="d7", from, to } = req.query;
  const ck = `cr:${id}:${range==="custom"?`${from}:${to}`:range}`;
  const cached = await cache.get(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try { const data = await fetchCampaignAds(id, range, from, to); await cache.set(ck, data); res.json({ ...data, fromCache: false }); }
  catch(e) { res.status(503).json({ error: e.message }); }
});

app.get("/api/campaign/:id/audience", auth, async (req, res) => {
  const { id } = req.params;
  const { range="d7", from, to } = req.query;
  const ck = `aud:${id}:${range==="custom"?`${from}:${to}`:range}`;
  const cached = await cache.get(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try { const data = await fetchCampaignAudience(id, range, from, to); await cache.set(ck, data); res.json({ ...data, fromCache: false }); }
  catch(e) { console.error(`❌ audiencia ${id}:`, e.message); res.status(503).json({ error: e.message }); }
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "../client/index.html")));

createServer(app).listen(PORT, () => console.log(`🚀 Puerto ${PORT} | ${redis?"Redis":"Memoria"} ${CACHE_TTL}s`));
