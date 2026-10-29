import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Redis from "ioredis";
import crypto from "crypto";
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
    fbGet(`act_${accountId}/insights`, { fields: "spend,clicks,ctr,actions,cost_per_action_type", level: "account", ...prevRp }),
    fbGet(`act_${accountId}/insights`, { fields: INS_FIELDS, level: "campaign", ...rp, limit: "25", sort: "spend_descending" }),
    fbGet(`act_${accountId}`, { fields: "currency,name" }),
  ]);

  const ins = accIns.data?.[0] || {};
  const prevIns = prevAccIns.data?.[0] || {};
  const spend = parseFloat(ins.spend || 0);
  const conv = extractConv(ins.actions);

  // Métricas de Instagram desde acciones de anuncios
  // Visitas al perfil IG (acción directa de campañas de tráfico a IG)
  const igProfileVisits = 
    extractAction(ins.actions, "onsite_conversion.messaging_first_reply") === 0
      ? extractAction(ins.actions, "visit_instagram_profile") +
        extractAction(ins.actions, "onsite_conversion.view_content")
      : 0;

  // Seguidores nuevos de IG (acción "follow" en anuncios de IG)
  const igFollows = extractAction(ins.actions, "follow");
  let igFollowersDelta = igFollows;

  // Si la cuenta tiene IG Business conectado, traer seguidores reales
  try {
    const igRes = await fbGet(`act_${accountId}`, { fields: "instagram_actor_id" });
    if (igRes.instagram_actor_id) {
      // Traer seguidores via Instagram Graph API
      const igInsights = await fbGet(`${igRes.instagram_actor_id}/insights`, {
        metric: "follower_count,profile_views",
        period: "day",
        since: Math.floor((Date.now() - 8*86400000) / 1000),
        until: Math.floor(Date.now() / 1000),
      }).catch(() => null);
      
      if (igInsights?.data) {
        const followerMetric = igInsights.data.find(d => d.name === "follower_count");
        const profileMetric = igInsights.data.find(d => d.name === "profile_views");
        if (followerMetric?.values) {
          igFollowersDelta = followerMetric.values.reduce((s, v) => s + (v.value || 0), 0);
        }
        // Visitas al perfil IG orgánicas + pagas
        if (profileMetric?.values && profileMetric.values.length > 0) {
          const profileViews = profileMetric.values.reduce((s, v) => s + (v.value || 0), 0);
          // Usar el mayor entre las dos fuentes
          if (profileViews > igProfileVisits) {
            Object.defineProperty(ins, '_ig_profile_visits', { value: profileViews, writable: true });
          }
        }
      }
    }
  } catch { /* sin IG conectado, usamos datos de acciones de anuncios */ }

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
        clicks: parseInt(c.clicks || 0),
        ig_follows: extractAction(c.actions, "follow"),
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  const prevSpend = parseFloat(prevIns.spend || 0);
  const prevConv = extractConv(prevIns.actions);
  const prevClicks = parseInt(prevIns.clicks || 0);
  const prevCtr = parseFloat(prevIns.ctr || 0);
  const prevCPC = prevClicks > 0 ? prevSpend / prevClicks : 0;

  return {
    currency: accInfo.currency || "ARS",
    account: {
      spend, conversations: conv,
      cost_per_msg: extractCPM(ins.cost_per_action_type, conv, spend),
      reach: parseInt(ins.reach||0),
      impressions: parseInt(ins.impressions||0),
      ctr: parseFloat(ins.ctr||0),
      clicks: parseInt(ins.clicks||0),
      ig_follows: Math.round(igFollowersDelta),
      ig_profile_visits: Math.round(ins._ig_profile_visits || igProfileVisits),
    },
    prev_cost_per_msg: extractCPM(prevIns.cost_per_action_type, prevConv, prevSpend),
    prev_conversations: prevConv,
    prev_ctr: prevCtr,
    prev_cpc: prevCPC,
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
async function fetchAnalysis(name, phrase, payload, budgetConfig) {
  const budgetContext = budgetConfig ? `
PRESUPUESTO CONFIGURADO:
- Presupuesto mensual del cliente: ${budgetConfig.currency} ${budgetConfig.budget}
- Objetivo costo por mensaje: ${budgetConfig.targetCPM ? budgetConfig.currency + " " + budgetConfig.targetCPM : "no definido"}
- Objetivo costo por clic: ${budgetConfig.targetCPC ? budgetConfig.currency + " " + budgetConfig.targetCPC : "no definido"}
` : "";

  const prompt = `Sos un agente de Paid Social especializado en Meta Ads trabajando en una agencia argentina de marketing digital. Tu rol combina auditoría de cuentas y estrategia de paid social.

CUENTA BAJO ANÁLISIS: "${name}"
PERÍODO: ${phrase}
${budgetContext}

DATOS DE PERFORMANCE:
${JSON.stringify(payload, null, 2)}

FRAMEWORK DE ANÁLISIS — aplicá estos criterios:

1. ESTRUCTURA Y EFICIENCIA
   - Frecuencia objetivo: 1.5-2.5 para prospecting, 3-5 para retargeting
   - CTR saludable en Meta: 1%+ para tráfico, 0.5%+ para awareness
   - Costo por mensaje: evaluá si está dentro del objetivo configurado o del promedio del rubro
   - Campañas activas vs pausadas: ¿hay campañas activas sin gasto? señal de error

2. INDICADORES DE ALARMA (reportar si se cumplen)
   - CTR < 0.5%: creatividades agotadas o targeting equivocado
   - 0 conversaciones con gasto activo: problema de configuración o embudo roto
   - Costo por mensaje subió >15% vs período anterior: investigar causa
   - Campañas activas con $0 de gasto: posible error de pago o límite de cuenta
   - Alcance muy bajo con impresiones altas: frecuencia elevada, audiencia saturada

3. OPORTUNIDADES DE MEJORA
   - Basate en los datos reales, no en recomendaciones genéricas
   - Mencioná números concretos del período analizado
   - Si no hay datos suficientes, decilo explícitamente

4. CONTEXTO ARGENTINO
   - Considerá inflación al evaluar evolución de costos en ARS
   - El costo por mensaje en ARS puede variar mucho por rubro (gastronomía $500-2000, inmobiliaria $3000-15000, servicios $1000-5000)
   - Evaluá si el gasto es coherente con el presupuesto mensual informado

Respondé SOLO con JSON en español rioplatense, sin markdown:
{
  "veredicto": "estado general en máximo 2 frases con los números más importantes",
  "bueno": ["máximo 3 puntos fuertes con números concretos del período"],
  "malo": ["máximo 3 problemas con recomendación accionable específica"],
  "alerta_critica": null
}

Si hay un problema crítico (cuenta sin gasto, error de pago, 0 conversiones con gasto alto), ponelo en "alerta_critica" como string. Si no hay nada crítico, dejá null.`;
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
  const { name, phrase, payload, budgetConfig: clientConfig } = req.body;
  // Enriquecer con settings del servidor si no vienen del cliente
  let budgetConfig = clientConfig;
  if (!budgetConfig || !budgetConfig.budget) {
    const settings = await cache.get("global:settings") || {};
    const s = settings[id];
    if (s) budgetConfig = { currency: s.currency || "ARS", budget: s.budget, targetCPM: s.targetCPM, targetCPC: s.targetCPC };
  }
  const ck = `an:${id}:${phrase}`;
  const cached = await cache.get(ck);
  if (cached) return res.json({ ...cached, fromCache: true });
  try { const data = await fetchAnalysis(name, phrase, payload, budgetConfig); await cache.set(ck, data); res.json({ ...data, fromCache: false }); }
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

// Vista general — métricas de múltiples cuentas en paralelo (máx 6 simultáneas)
app.post("/api/overview", auth, async (req, res) => {
  const { accounts, range = "d7", from, to } = req.body;
  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: "Se requiere array de accounts" });
  }

  const results = {};
  const queue = [...accounts];
  const CONCURRENCY = 6;

  async function processOne(id) {
    const ck = `acc:${id}:${range==="custom"?`${from}:${to}`:range}`;
    const cached = await cache.get(ck);
    if (cached) { results[id] = { ...cached, fromCache: true }; return; }
    try {
      const data = await fetchAccountMetrics(id, range, from, to);
      await cache.set(ck, data);
      results[id] = { ...data, fromCache: false };
    } catch(e) {
      results[id] = { error: e.message };
    }
  }

  // Procesar en paralelo con límite de concurrencia
  let i = 0;
  async function next() {
    if (i >= queue.length) return;
    const id = queue[i++];
    await processOne(id);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, next));

  res.json(results);
});

// Settings compartidos: presupuestos, objetivos y tareas (persiste en Redis 90 días)
app.get("/api/settings", auth, async (req, res) => {
  const settings = await cache.get("global:settings") || {};
  res.json(settings);
});

// Actualizar settings de una cuenta específica
app.post("/api/settings/:id", auth, async (req, res) => {
  const { id } = req.params;
  const updates = req.body; // { budget, targetCPM, targetCPC, taskDone, taskWeek }
  const settings = await cache.get("global:settings") || {};
  settings[id] = { ...(settings[id] || {}), ...updates };
  await cache.set("global:settings", settings, 86400 * 90); // 90 días
  res.json({ ok: true, data: settings[id] });
});

// Actualizar settings en batch (múltiples cuentas)
app.post("/api/settings", auth, async (req, res) => {
  const { settings: incoming } = req.body;
  if (!incoming) return res.status(400).json({ error: "Se requiere objeto settings" });
  const current = await cache.get("global:settings") || {};
  for (const [id, vals] of Object.entries(incoming)) {
    current[id] = { ...(current[id] || {}), ...vals };
  }
  await cache.set("global:settings", current, 86400 * 90);
  res.json({ ok: true });
});

// Estado real de una cuenta (account_status de Meta)
app.get("/api/account/:id/status", auth, async (req, res) => {
  try {
    const data = await fbGet(`act_${req.params.id}`, { fields: "account_status,disable_reason,currency" });
    // account_status: 1=Activa, 2=Desactivada, 3=Sin confirmar, 7=Pendiente revisión, 9=En cierre
    // disable_reason: 0=Ninguno, 1=AUP, 2=Sin pago, 3=Abuso, 4=Integridad política, 5=tos
    const statusMap = { 1:"activa", 2:"problema", 3:"sin_confirmar", 7:"en_revision", 9:"cerrando" };
    const reasonMap = { 0:null, 1:"política", 2:"sin_pago", 3:"abuso", 4:"política", 5:"términos" };
    res.json({
      status: statusMap[data.account_status] || "desconocido",
      reason: reasonMap[data.disable_reason] || null,
      currency: data.currency,
    });
  } catch(e) { res.status(503).json({ error: e.message }); }
});

// Datos mensuales para gráfico (últimos 7 meses)
app.get("/api/account/:id/monthly", auth, async (req, res) => {
  const { id } = req.params;
  const ck = `monthly:${id}`;
  const cached = await cache.get(ck);
  if (cached) return res.json(cached);

  try {
    // Calcular últimos 7 meses
    const now = new Date();
    const months = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const since = d.toISOString().slice(0, 10);
      const until = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      months.push({
        label: d.toLocaleDateString("es-AR", { month: "short" }).replace(".", ""),
        year: d.getFullYear(),
        since,
        until,
      });
    }

    // Traer insights para cada mes en paralelo
    const results = await Promise.all(
      months.map(async (m) => {
        try {
          const data = await fbGet(`act_${id}/insights`, {
            fields: "spend,actions,cost_per_action_type,impressions,reach",
            time_range: JSON.stringify({ since: m.since, until: m.until }),
            level: "account",
          });
          const ins = data.data?.[0] || {};
          const spend = parseFloat(ins.spend || 0);
          const conv = extractConv(ins.actions);
          const cpm = extractCPM(ins.cost_per_action_type, conv, spend);
          return {
            label: m.label,
            year: m.year,
            spend,
            conversations: conv,
            cost_per_msg: cpm,
            reach: parseInt(ins.reach || 0),
            impressions: parseInt(ins.impressions || 0),
          };
        } catch {
          return { label: m.label, year: m.year, spend: 0, conversations: 0, cost_per_msg: null, reach: 0, impressions: 0 };
        }
      })
    );

    await cache.set(ck, results, 3600); // 1 hora
    res.json(results);
  } catch (e) {
    console.error("❌ monthly:", e.message);
    res.status(503).json({ error: e.message });
  }
});

// Lista dinámica de cuentas desde Meta (cache 1 hora)
app.get("/api/accounts", auth, async (req, res) => {
  const ck = "global:accounts";
  const cached = await cache.get(ck);
  if (cached) return res.json(cached);

  try {
    let allAccounts = [];
    let url = `${FB}/me/adaccounts?fields=account_id,name,currency,account_status,business_name&limit=100&access_token=${META_TOKEN}`;
    let pages = 0;
    
    while (url && pages < 5) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      
      for (const acc of (data.data || [])) {
        allAccounts.push({
          id: acc.account_id,
          name: acc.name || acc.business_name || "Sin nombre",
          biz: acc.business_name || "",
          cur: acc.currency || "ARS",
          status: acc.account_status,
        });
      }
      
      url = data.paging?.next || null;
      pages++;
    }
    
    // Filtrar cuentas activas y con acceso (status 1 = activa)
    // Status: 1=activa, 2=desactivada, 3=sin confirmar, 7=en revisión, 9=período de gracia
    const active = allAccounts.filter(a => [1, 3, 7, 9].includes(a.status));
    
    await cache.set(ck, active, 3600); // 1 hora
    console.log(`📋 ${active.length} cuentas activas de ${allAccounts.length} totales`);
    res.json(active);
  } catch(e) {
    console.error("❌ Error listando cuentas:", e.message);
    res.status(503).json({ error: e.message });
  }
});

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

async function checkAccountAlerts() {
  if (!SLACK_WEBHOOK) return;
  try {
    // Traer cuentas con info de facturación
    const resp = await fetch(`${FB}/me/adaccounts?fields=account_id,name,account_status,disable_reason,balance,currency,is_prepay_account,funding_source_details&limit=100&access_token=${META_TOKEN}`, { signal: AbortSignal.timeout(30000) });
    const data = await resp.json();
    if (data.error) return;
    const alerts = [];
    const settings = await cache.get("global:settings") || {};
    const pinnedIds = await cache.get("global:pinned") || [];
    // Solo monitorear cuentas favoritas
    const monitored = pinnedIds.length > 0
      ? (data.data || []).filter(a => pinnedIds.includes(a.account_id))
      : [];
    for (const acc of monitored) {
      const name = acc.name || acc.account_id;
      const isPrepay = acc.is_prepay_account || false;
      const balance = parseInt(acc.balance || 0);

      if (isPrepay) {
        // PREPAGO: alertar cuando quedan pocos fondos
        // balance es positivo = fondos disponibles
        if (balance > 0 && balance <= 10000 && acc.account_status === 1) {
          alerts.push("\u26a0\ufe0f *" + name + "* (prepago): fondos bajos \u2014 " + acc.currency + " " + Math.round(balance).toLocaleString("es-AR") + " restantes");
        }
        if (balance <= 0 && acc.account_status === 1) {
          alerts.push("\ud83d\udd34 *" + name + "* (prepago): sin fondos \u2014 cargar saldo urgente");
        }
      } else {
        // TARJETA: alertar si hay error de pago (status 2=desactivada, 3=pago pendiente)
        if (acc.account_status === 2) {
          alerts.push("\ud83d\udd34 *" + name + "* (tarjeta): cuenta desactivada \u2014 revisar m\u00e9todo de pago");
        } else if (acc.account_status === 3) {
          alerts.push("\u26a0\ufe0f *" + name + "* (tarjeta): pago pendiente/rechazado \u2014 revisar facturaci\u00f3n");
        }
      }

      // Presupuesto: consumo + pacing
      const s = settings[acc.account_id];
      if (s && s.budget && acc.account_status === 1) {
        try {
          const ir = await fetch(`${FB}/act_${acc.account_id}/insights?fields=spend&date_preset=this_month&level=account&access_token=${META_TOKEN}`, { signal: AbortSignal.timeout(15000) });
          const id = await ir.json();
          const ms = parseFloat(id.data?.[0]?.spend || 0);
          const pctSpent = s.budget > 0 ? Math.round(ms / s.budget * 100) : 0;
          const cur = s.currency || acc.currency || "ARS";

          // Presupuesto casi agotado
          if (pctSpent >= 90) alerts.push("\ud83d\udcb0 *" + name + "*: " + pctSpent + "% del presupuesto mensual ejecutado");

          // Pacing de presupuesto
          const pNow = new Date();
          const dayOfMonth = pNow.getDate();
          const daysInMonth = new Date(pNow.getFullYear(), pNow.getMonth() + 1, 0).getDate();
          const expectedPct = Math.round((dayOfMonth / daysInMonth) * 100);

          // Sobreejecutando: gasta demasiado r\u00e1pido
          if (pctSpent > expectedPct + 20 && pctSpent < 90) {
            const daysLeft = daysInMonth - dayOfMonth;
            const budgetLeft = Math.round(s.budget - ms);
            alerts.push("\ud83d\udd3a *" + name + "*: sobreejecutando \u2014 " + pctSpent + "% gastado al d\u00eda " + dayOfMonth + "/" + daysInMonth + " (esperado ~" + expectedPct + "%). Quedan " + cur + " " + budgetLeft.toLocaleString("es-AR") + " para " + daysLeft + " d\u00edas");
          }
          // Subejecutando: gasta muy lento (solo alertar despu\u00e9s del d\u00eda 10)
          else if (pctSpent < expectedPct - 20 && dayOfMonth >= 10) {
            alerts.push("\ud83d\udd3b *" + name + "*: subejecutando \u2014 solo " + pctSpent + "% gastado al d\u00eda " + dayOfMonth + "/" + daysInMonth + " (esperado ~" + expectedPct + "%). Riesgo de sub-inversi\u00f3n");
          }
        } catch {}
      }
    }
    if (alerts.length > 0) {
      await fetch(SLACK_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "\ud83d\udcca *Meta Ads \u2014 Alertas Concepto*\n" + alerts.join("\n") }) });
      console.log("\ud83d\udce2 Slack: " + alerts.length + " alertas");
    } else {
      console.log("\ud83d\udce2 Sin alertas");
    }
  } catch (e) { console.error("Slack error:", e.message); }
}

/* ------------------------------------------------------------------ */
/*  Fatiga creativa: CTR cae >30% vs promedio 4 semanas                */
/* ------------------------------------------------------------------ */
async function checkCreativeFatigue() {
  if (!SLACK_WEBHOOK) return;
  try {
    const pinnedIds = await cache.get("global:pinned") || [];
    if (!pinnedIds.length) return;

    const alerts = [];
    const now = new Date();
    const DAY = 86400000;

    // Semana actual (últimos 7 días) vs 4 semanas anteriores
    const currentFrom = new Date(now - 7 * DAY).toISOString().slice(0, 10);
    const currentTo = now.toISOString().slice(0, 10);
    const prevFrom = new Date(now - 35 * DAY).toISOString().slice(0, 10);
    const prevTo = new Date(now - 7 * DAY).toISOString().slice(0, 10);

    for (const accId of pinnedIds) {
      try {
        const [currentIns, prevIns] = await Promise.all([
          fbGet(`act_${accId}/insights`, {
            fields: "campaign_id,campaign_name,ctr,impressions",
            level: "campaign",
            time_range: JSON.stringify({ since: currentFrom, until: currentTo }),
            limit: "25",
          }),
          fbGet(`act_${accId}/insights`, {
            fields: "campaign_id,campaign_name,ctr,impressions",
            level: "campaign",
            time_range: JSON.stringify({ since: prevFrom, until: prevTo }),
            limit: "25",
          }),
        ]);

        const prevMap = {};
        for (const c of (prevIns.data || [])) {
          if (c.campaign_id) prevMap[c.campaign_id] = parseFloat(c.ctr || 0);
        }

        for (const c of (currentIns.data || [])) {
          if (!c.campaign_id) continue;
          const currentCTR = parseFloat(c.ctr || 0);
          const avgCTR = prevMap[c.campaign_id];
          if (!avgCTR || avgCTR === 0) continue;
          // Solo campañas con impresiones significativas
          if (parseInt(c.impressions || 0) < 100) continue;

          const drop = (avgCTR - currentCTR) / avgCTR;
          if (drop > 0.3) {
            alerts.push("⚠️ *" + (c.campaign_name || c.campaign_id) + "*: CTR cayó de " + avgCTR.toFixed(2) + "% a " + currentCTR.toFixed(2) + "% — posible fatiga creativa");
          }
        }

        await sleep(300); // Rate limiting entre cuentas
      } catch (e) {
        console.warn("⚠️ Fatigue check " + accId + ":", e.message);
      }
    }

    if (alerts.length > 0) {
      await fetch(SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "🎨 *Meta Ads — Fatiga Creativa*\n" + alerts.join("\n") }),
      });
      console.log("🎨 Fatigue: " + alerts.length + " alertas");
    } else {
      console.log("🎨 Sin fatiga creativa detectada");
    }
  } catch (e) {
    console.error("Fatigue error:", e.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Link de reporte público para clientes                              */
/* ------------------------------------------------------------------ */

// Generar/obtener token de reporte
function baseURL(req) { return `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`; }

app.post("/api/report-token/:id", auth, async (req, res) => {
  const { id } = req.params;
  const tokens = await cache.get("global:report-tokens") || {};

  if (tokens[id]) {
    return res.json({ token: tokens[id], url: `${baseURL(req)}/r/${tokens[id]}` });
  }

  const token = crypto.randomBytes(16).toString("hex");
  tokens[id] = token;

  const reverseTokens = await cache.get("global:token-accounts") || {};
  reverseTokens[token] = id;

  await cache.set("global:report-tokens", tokens, 86400 * 365);
  await cache.set("global:token-accounts", reverseTokens, 86400 * 365);

  res.json({ token, url: `${baseURL(req)}/r/${token}` });
});

// Obtener token existente (GET)
app.get("/api/report-token/:id", auth, async (req, res) => {
  const { id } = req.params;
  const tokens = await cache.get("global:report-tokens") || {};
  if (tokens[id]) {
    return res.json({ token: tokens[id], url: `${baseURL(req)}/r/${tokens[id]}` });
  }
  res.json({ token: null });
});

// Revocar token
app.delete("/api/report-token/:id", auth, async (req, res) => {
  const { id } = req.params;
  const tokens = await cache.get("global:report-tokens") || {};
  const token = tokens[id];
  if (token) {
    delete tokens[id];
    const reverseTokens = await cache.get("global:token-accounts") || {};
    delete reverseTokens[token];
    await cache.set("global:report-tokens", tokens, 86400 * 365);
    await cache.set("global:token-accounts", reverseTokens, 86400 * 365);
  }
  res.json({ ok: true });
});

// API pública de métricas (sin auth)
app.get("/api/public/:token", async (req, res) => {
  const { token } = req.params;
  const reverseTokens = await cache.get("global:token-accounts") || {};
  const accountId = reverseTokens[token];
  if (!accountId) return res.status(404).json({ error: "Reporte no encontrado" });

  const { range = "d7", from, to } = req.query;
  try {
    const data = await fetchAccountMetrics(accountId, range, from, to);
    // Datos públicos: sin info interna
    const publicCampaigns = (data.campaigns || []).map(c => ({
      name: c.name, spend: c.spend, conversations: c.conversations,
      cost_per_msg: c.cost_per_msg, reach: c.reach, impressions: c.impressions,
      ctr: c.ctr, status: c.status, objective: c.objective, clicks: c.clicks || 0,
    }));

    // Audiencia a nivel cuenta (gender, age, platform)
    let audience = null;
    try {
      const rp2 = rangeToParams(range, from, to);
      const BASE2 = { fields: "spend,impressions,reach,actions", level: "account", ...rp2 };
      const [gR, aR, pR] = await Promise.allSettled([
        fbGet(`act_${accountId}/insights`, { ...BASE2, breakdowns: "gender" }),
        fbGet(`act_${accountId}/insights`, { ...BASE2, breakdowns: "age" }),
        fbGet(`act_${accountId}/insights`, { ...BASE2, breakdowns: "publisher_platform" }),
      ]);
      const toRows2 = s => s.status === "fulfilled" ? (s.value.data || []) : [];
      const toPct2 = (rows, key) => {
        const total = rows.reduce((s, r) => s + parseFloat(r.impressions || 0), 0);
        if (!total) return [];
        return rows.map(r => ({ label: r[key] || "Otro", pct: Math.round(parseFloat(r.impressions||0) / total * 100) })).sort((a, b) => b.pct - a.pct).slice(0, 8);
      };
      const tG = g => g === "female" ? "Mujeres" : g === "male" ? "Hombres" : "Otro";
      const tP = p => ({ facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger" }[p] || p);
      audience = {
        gender: toPct2(toRows2(gR), "gender").map(r => ({ ...r, label: tG(r.label) })),
        age: toPct2(toRows2(aR), "age"),
        platform: toPct2(toRows2(pR), "publisher_platform").map(r => ({ ...r, label: tP(r.label) })),
      };
    } catch {}

    // Monthly data para el gráfico
    let monthly = [];
    try {
      const ck = `monthly:${accountId}`;
      const cached = await cache.get(ck);
      if (cached) { monthly = cached; }
      else {
        const now = new Date();
        const months = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          months.push({ label: d.toLocaleDateString("es-AR", { month: "short" }).replace(".", ""), year: d.getFullYear(), since: d.toISOString().slice(0, 10), until: new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10) });
        }
        monthly = await Promise.all(months.map(async m => {
          try {
            const md = await fbGet(`act_${accountId}/insights`, { fields: "spend,actions,cost_per_action_type,impressions,reach", time_range: JSON.stringify({ since: m.since, until: m.until }), level: "account" });
            const ins = md.data?.[0] || {};
            const sp = parseFloat(ins.spend || 0);
            const cv = extractConv(ins.actions);
            return { label: m.label, year: m.year, spend: sp, conversations: cv, cost_per_msg: extractCPM(ins.cost_per_action_type, cv, sp), reach: parseInt(ins.reach || 0), impressions: parseInt(ins.impressions || 0) };
          } catch { return { label: m.label, year: m.year, spend: 0, conversations: 0, cost_per_msg: null, reach: 0, impressions: 0 }; }
        }));
        await cache.set(ck, monthly, 3600);
      }
    } catch {}

    // Account name
    let accountName = "Cuenta";
    try { const ai = await fbGet(`act_${accountId}`, { fields: "name" }); accountName = ai.name || accountName; } catch {}

    res.json({
      currency: data.currency,
      accountName,
      account: data.account,
      prev_cost_per_msg: data.prev_cost_per_msg,
      campaigns: publicCampaigns,
      monthly,
      audience,
    });
  } catch (e) {
    res.status(503).json({ error: "No se pudieron obtener las métricas" });
  }
});

// Página de reporte para clientes
app.get("/r/:token", async (req, res) => {
  const { token } = req.params;
  const reverseTokens = await cache.get("global:token-accounts") || {};
  const accountId = reverseTokens[token];
  if (!accountId) return res.status(404).send("<h1>Reporte no encontrado</h1><p>Este link no es válido o fue revocado.</p>");

  let accountName = "Cuenta";
  try { const ai = await fbGet(`act_${accountId}`, { fields: "name" }); accountName = ai.name || accountName; } catch {}

  res.send(clientReportHTML(token, accountId, accountName));
});

function clientReportHTML(token, accountId, accountName) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${accountName} · Informe de pauta</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0E0C07;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#F6F1E7;min-height:100vh}
.container{max-width:900px;margin:0 auto}
/* Hero header */
.hero{background:linear-gradient(135deg,#D4650A 0%,#F2940B 60%,#F5B73B 100%);padding:32px 28px 28px;position:relative;overflow:hidden}
.hero .circle1{position:absolute;right:-30px;top:-30px;width:180px;height:180px;border-radius:50%;background:rgba(255,255,255,0.12)}
.hero .circle2{position:absolute;right:40px;bottom:-40px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,0.07)}
.hero-content{position:relative;z-index:1}
.hero .agency{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.8);margin-bottom:6px}
.hero .title{font-size:28px;font-weight:800;color:#fff;line-height:1.2}
.hero .client{font-size:17px;color:rgba(255,255,255,0.85);margin-top:3px;font-weight:500}
.hero .date-sub{font-size:12px;color:rgba(255,255,255,0.65);margin-top:8px}
.hero .badges{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
.hero .pill{background:rgba(0,0,0,0.2);color:#fff;font-size:10px;font-weight:700;padding:4px 12px;border-radius:20px}
.body-content{padding:20px 24px 24px}
.section-title{font-size:12px;font-weight:800;color:#F2740B;text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:22px}
.stat{background:#261E14;border:1px solid #3A2F1E;border-radius:14px;padding:14px}
.stat .label{font-size:10px;color:#7C7360;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.stat .value{font-size:22px;font-weight:800;margin-top:6px;line-height:1.1}
.stat .tint{color:#F2740B}
.campaigns{background:#1F1810;border:1px solid #3A2F1E;border-radius:14px;padding:16px;margin-bottom:20px}
.campaigns h2{font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#F2740B;margin-bottom:12px}
.camp-row{display:grid;grid-template-columns:2fr repeat(5,1fr);gap:8px;padding:10px 0;border-bottom:1px solid #2C2317;font-size:12px;align-items:center}
.camp-row.head{font-size:9.5px;color:#7C7360;font-weight:700;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid #3A2F1E}
.camp-row .r{text-align:right}
.camp-row .name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.camp-row .active{color:#3FBE79}.camp-row .paused{color:#7C7360}
.range-bar{display:inline-flex;gap:3px;background:#261E14;border:1px solid #3A2F1E;border-radius:10px;padding:3px;margin-bottom:18px}
.range-bar button{padding:6px 12px;font-size:12px;font-weight:700;border-radius:8px;border:none;cursor:pointer;background:transparent;color:#7C7360;font-family:inherit}
.range-bar button.active{background:#F2740B;color:#fff}
.chart-box{background:#261E14;border:1px solid #3A2F1E;border-radius:14px;padding:16px;margin-bottom:20px}
.chart-box h2{font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#F2740B;margin-bottom:14px}
.bars{display:flex;align-items:flex-end;gap:6px;height:160px;padding:0 4px}
.bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.bar-fill{width:100%;background:#F2740B;border-radius:4px 4px 0 0;min-height:4px;position:relative}
.bar-fill .bar-label{position:absolute;top:-18px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:700;color:#F6F1E7;white-space:nowrap}
.bar-month{font-size:10px;color:#7C7360;margin-top:6px}
.footer{text-align:center;font-size:10px;color:#7C7360;margin-top:20px;padding-top:12px;border-top:1px solid #2C2317}
.loading{text-align:center;padding:60px 0;color:#7C7360;font-size:14px}
.spin{animation:sp .9s linear infinite;display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="container" id="app">
  <div class="loading"><span class="spin">⟳</span> Cargando métricas…</div>
</div>
<script>
const TOKEN="${token}";
const ACCOUNT_NAME="${accountName.replace(/"/g, '\\"')}";
let currentRange="d7";

const compact=n=>{const v=+n||0,a=Math.abs(v);if(a>=1e6)return(v/1e6).toFixed(a>=1e7?0:1).replace(".",",")+"M";if(a>=1e5)return(v/1e3).toFixed(0)+"K";if(a>=1e4)return(v/1e3).toFixed(1).replace(".",",")+"K";return new Intl.NumberFormat("es-AR",{maximumFractionDigits:0}).format(v)};
const money=(n,c)=>{const v=+n||0;const s=c==="USD"?"US$ ":c==="DKK"?"DKK ":"$ ";if(Math.abs(v)>=1e5)return s+compact(v);return new Intl.NumberFormat("es-AR",{style:"currency",currency:c||"ARS",maximumFractionDigits:0}).format(v)};
const cost=(n,c)=>{if(n==null)return"—";const v=+n||0;if(Math.abs(v)>=1e3)return money(v,c);return new Intl.NumberFormat("es-AR",{style:"currency",currency:c||"ARS",maximumFractionDigits:2}).format(v)};
const pct=n=>n==null?"—":(+n||0).toFixed(2)+"%";
const monthNames=["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

async function loadReport(range){
  currentRange=range;
  const app=document.getElementById("app");
  app.innerHTML='<div class="loading"><span class="spin">⟳</span> Cargando métricas…</div>';
  try{
    const res=await fetch("/api/public/"+TOKEN+"?range="+range);
    if(!res.ok)throw new Error("Error "+res.status);
    const d=await res.json();
    render(d);
  }catch(e){
    app.innerHTML='<div class="loading" style="color:#E8613E">Error al cargar métricas. Intentá de nuevo más tarde.</div>';
  }
}

function render(d){
  const a=d.account||{};const c=d.currency||"ARS";
  const rangeTxt=currentRange==="d7"?"7 días":currentRange==="d30"?"30 días":"Personalizado";
  const today=new Date().toLocaleDateString("es-AR",{day:"numeric",month:"long",year:"numeric"});
  const now=new Date();const dateSub=monthNames[now.getMonth()]+" "+now.getFullYear();

  let campRows=(d.campaigns||[]).filter(x=>(+x.spend||0)>0).map(x=>{
    const active=x.status==="activa";
    return '<div class="camp-row"><div class="name">'+(x.name||"—")+'</div><div class="r" style="color:#F2740B;font-weight:700">'+money(x.spend,c)+'</div><div class="r">'+compact(x.conversations)+'</div><div class="r">'+cost(x.cost_per_msg,c)+'</div><div class="r">'+(active?'<span class="active">Activa</span>':'<span class="paused">Pausada</span>')+'</div><div class="r" style="color:'+(+x.ctr>=1?"#3FBE79":"inherit")+'">'+pct(x.ctr)+'</div></div>';
  }).join("");

  const monthly=d.monthly||[];
  const maxConv=Math.max(...monthly.map(m=>m.conversations||0),1);
  let chartBars=monthly.map(m=>{
    const h=Math.max(Math.round((m.conversations/maxConv)*140),4);
    return '<div class="bar-col"><div class="bar-fill" style="height:'+h+'px"><span class="bar-label">'+m.conversations+'</span></div><div class="bar-month">'+m.label+'</div></div>';
  }).join("");

  document.getElementById("app").innerHTML=
    /* Hero header naranja */
    '<div class="hero"><div class="circle1"></div><div class="circle2"></div><div class="hero-content">'
    +'<div class="agency">Concepto Agencia</div>'
    +'<div class="title">Informe de pauta</div>'
    +'<div class="client">'+ACCOUNT_NAME+'</div>'
    +'<div class="date-sub">'+dateSub+'</div>'
    +'<div class="badges"><span class="pill">Meta Ads</span><span class="pill">'+rangeTxt+'</span><span class="pill" style="background:rgba(63,190,121,0.3)">● En vivo</span></div>'
    +'</div></div>'

    +'<div class="body-content">'

    +'<div class="range-bar"><button class="'+(currentRange==="d7"?"active":"")+'" onclick="loadReport('+"'d7'"+')">7 días</button><button class="'+(currentRange==="d30"?"active":"")+'" onclick="loadReport('+"'d30'"+')">30 días</button></div>'

    +'<div class="section-title">Resumen General</div>'
    +'<div class="stats">'
    +'<div class="stat"><div class="label">Gasto total</div><div class="value tint">'+money(a.spend,c)+'</div></div>'
    +'<div class="stat"><div class="label">Conversaciones</div><div class="value">'+compact(a.conversations)+'</div></div>'
    +'<div class="stat"><div class="label">Costo por mensaje</div><div class="value">'+cost(a.cost_per_msg,c)+'</div></div>'
    +'<div class="stat"><div class="label">Alcance</div><div class="value">'+compact(a.reach)+'</div></div>'
    +'<div class="stat"><div class="label">Impresiones</div><div class="value">'+compact(a.impressions)+'</div></div>'
    +'<div class="stat"><div class="label">CTR</div><div class="value" style="color:'+(+a.ctr>=1?"#3FBE79":"inherit")+'">'+pct(a.ctr)+'</div></div>'
    +'</div>'

    +(campRows?'<div class="campaigns"><h2>Campañas</h2><div class="camp-row head"><div>Campaña</div><div class="r">Gasto</div><div class="r">Conv.</div><div class="r">C/msj</div><div class="r">Estado</div><div class="r">CTR</div></div>'+campRows+'</div>':'')

    +(monthly.length?'<div class="chart-box"><h2>Rendimiento mensual</h2><div class="bars">'+chartBars+'</div></div>':'')

    +'<div class="footer">Reporte generado por Concepto Agencia · '+today+'</div>'
    +'</div>';
}

loadReport("d7");
</script>
</body>
</html>`;
}

// Favoritas sincronizadas con el servidor
app.get("/api/pinned", auth, async (req, res) => {
  const pinned = await cache.get("global:pinned") || [];
  res.json(pinned);
});
app.post("/api/pinned", auth, async (req, res) => {
  const { pinned } = req.body;
  if (!Array.isArray(pinned)) return res.status(400).json({ error: "Se requiere array" });
  await cache.set("global:pinned", pinned, 86400 * 90);
  res.json({ ok: true });
});

app.get("/api/check-alerts", auth, async (req, res) => { await checkAccountAlerts(); await checkCreativeFatigue(); res.json({ ok: true }); });
if (SLACK_WEBHOOK) {
  // Alertas a las 08:00, 12:00 y 18:00 hora Argentina (UTC-3)
  const ALERT_HOURS = [8, 12, 18];
  let lastAlertHour = null;
  setInterval(() => {
    const now = new Date();
    const argHour = (now.getUTCHours() - 3 + 24) % 24;
    const argMin = now.getUTCMinutes();
    if (ALERT_HOURS.includes(argHour) && argMin < 5 && lastAlertHour !== argHour) {
      lastAlertHour = argHour;
      console.log("\ud83d\udce2 Alerta programada " + argHour + ":00 AR");
      checkAccountAlerts();
      checkCreativeFatigue();
    }
    if (!ALERT_HOURS.includes(argHour)) lastAlertHour = null;
  }, 60000); // chequea cada minuto
  console.log("\ud83d\udce2 Slack alerts: 08:00, 12:00, 18:00 hora Argentina");
}


app.get("*", (_, res) => res.sendFile(path.join(__dirname, "../client/index.html")));

// Slack alerts
createServer(app).listen(PORT, () => console.log(`🚀 Puerto ${PORT} | ${redis?"Redis":"Memoria"} ${CACHE_TTL}s`));
