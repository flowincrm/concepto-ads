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
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "900"); // segundos

if (!ANTHROPIC_KEY) {
  console.error("❌ Falta ANTHROPIC_API_KEY en las variables de entorno");
  process.exit(1);
}
if (!META_TOKEN) {
  console.error("❌ Falta META_ACCESS_TOKEN en las variables de entorno");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Redis — con fallback a Map en memoria si no hay Redis              */
/* ------------------------------------------------------------------ */
let redis = null;
const memCache = new Map();

if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      connectTimeout: 5000,
    });
    redis.on("error", (e) => {
      console.warn("⚠️  Redis error, usando caché en memoria:", e.message);
      redis = null;
    });
    await redis.connect();
    console.log("✅ Redis conectado");
  } catch (e) {
    console.warn("⚠️  Redis no disponible, usando caché en memoria:", e.message);
    redis = null;
  }
}

const cache = {
  async get(key) {
    try {
      if (redis) {
        const val = await redis.get(key);
        return val ? JSON.parse(val) : null;
      }
      const entry = memCache.get(key);
      if (!entry) return null;
      if (Date.now() > entry.exp) { memCache.delete(key); return null; }
      return entry.val;
    } catch { return null; }
  },
  async set(key, val, ttl = CACHE_TTL) {
    try {
      if (redis) {
        await redis.setex(key, ttl, JSON.stringify(val));
      } else {
        memCache.set(key, { val, exp: Date.now() + ttl * 1000 });
        // Limpiar caché si crece demasiado
        if (memCache.size > 500) {
          const now = Date.now();
          for (const [k, v] of memCache) {
            if (now > v.exp) memCache.delete(k);
          }
        }
      }
    } catch { /* silencioso */ }
  },
  async del(key) {
    try {
      if (redis) await redis.del(key);
      else memCache.delete(key);
    } catch { /* silencioso */ }
  }
};

/* ------------------------------------------------------------------ */
/*  Llamada a Anthropic con retry + backoff para 429                   */
/* ------------------------------------------------------------------ */
async function callAnthropic(prompt, maxTokens = 4000) {
  const backoffs = [0, 2000, 5000, 12000, 25000]; // ~44s máximo
  let lastError = null;

  for (const wait of backoffs) {
    if (wait) await sleep(wait + Math.random() * 1000);

    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "mcp-client-2025-04-04",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
          mcp_servers: [
            {
              type: "url",
              url: "https://mcp.facebook.com/ads",
              name: "Meta ADS",
              authorization_token: META_TOKEN,
            },
          ],
        }),
        signal: AbortSignal.timeout(90000), // 90s timeout
      });
    } catch (e) {
      lastError = `Error de red: ${e.message}`;
      continue;
    }

    if (res.status === 429 || res.status === 529) {
      const retryAfter = res.headers.get("retry-after");
      const extraWait = retryAfter ? parseInt(retryAfter) * 1000 : 0;
      if (extraWait > 0) await sleep(extraWait);
      lastError = `Rate limit (${res.status})`;
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    return extractJSON(data);
  }

  throw new Error(
    `Meta Ads está saturado en este momento. ` +
    `Esperá unos segundos y volvé a intentar. (${lastError})`
  );
}

function extractJSON(data) {
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = clean.indexOf("{");
  const b = clean.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("Respuesta sin JSON parseable");
  return JSON.parse(clean.slice(a, b + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Middlewares                                                         */
/* ------------------------------------------------------------------ */
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../client")));

// Autenticación simple por header o query param
function auth(req, res, next) {
  const token =
    req.headers["x-panel-secret"] ||
    req.query.secret;
  if (token !== PANEL_SECRET) {
    return res.status(401).json({ error: "No autorizado. Necesitás la clave del panel." });
  }
  next();
}

/* ------------------------------------------------------------------ */
/*  Endpoints                                                           */
/* ------------------------------------------------------------------ */

// Health check
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// Verificar clave
app.post("/api/auth", (req, res) => {
  const { secret } = req.body;
  if (secret !== PANEL_SECRET) return res.status(401).json({ ok: false });
  res.json({ ok: true });
});

// Métricas de una cuenta
app.get("/api/account/:id", auth, async (req, res) => {
  const { id } = req.params;
  const range = req.query.range || "d7";
  const from = req.query.from;
  const to = req.query.to;

  const phrase = buildPhrase(range, from, to);
  const cacheKey = `account:${id}:${range === "custom" ? `${from}:${to}` : range}`;

  // Intentar caché
  const cached = await cache.get(cacheKey);
  if (cached) {
    console.log(`📦 Cache hit: ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  console.log(`🔍 Consultando Meta Ads: cuenta ${id}, ${phrase}`);

  try {
    const data = await callAnthropic(promptDetail(id, phrase), 4000);
    await cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (e) {
    console.error(`❌ Error cuenta ${id}:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

// Análisis IA de una cuenta
app.post("/api/account/:id/analysis", auth, async (req, res) => {
  const { id } = req.params;
  const { name, phrase, payload } = req.body;
  const cacheKey = `analysis:${id}:${phrase}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    console.log(`📦 Cache hit análisis: ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  console.log(`🤖 Generando análisis IA: ${name}`);

  try {
    const data = await callAnthropic(promptAnalysis(name, phrase, payload), 1500);
    await cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (e) {
    console.error(`❌ Error análisis ${id}:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

// Creativos de una campaña
app.get("/api/campaign/:id/ads", auth, async (req, res) => {
  const { id } = req.params;
  const range = req.query.range || "d7";
  const from = req.query.from;
  const to = req.query.to;

  const phrase = buildPhrase(range, from, to);
  const cacheKey = `creatives:${id}:${range === "custom" ? `${from}:${to}` : range}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    console.log(`📦 Cache hit creativos: ${cacheKey}`);
    return res.json({ ...cached, fromCache: true });
  }

  console.log(`🎨 Consultando creativos: campaña ${id}, ${phrase}`);

  try {
    const data = await callAnthropic(promptCreatives(id, phrase), 3000);
    await cache.set(cacheKey, data);
    res.json({ ...data, fromCache: false });
  } catch (e) {
    console.error(`❌ Error creativos ${id}:`, e.message);
    res.status(503).json({ error: e.message });
  }
});

// Limpiar caché de una cuenta (para forzar refresh)
app.delete("/api/cache/:id", auth, async (req, res) => {
  const { id } = req.params;
  const keys = [
    `account:${id}:d7`, `account:${id}:d30`,
    `analysis:${id}:*`,
  ];
  for (const key of keys) await cache.del(key);
  res.json({ ok: true });
});

// Fallback → servir el panel
app.get("*", (_, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

/* ------------------------------------------------------------------ */
/*  Prompts                                                             */
/* ------------------------------------------------------------------ */
function buildPhrase(range, from, to) {
  if (range === "d7")  return "los últimos 7 días";
  if (range === "d30") return "los últimos 30 días";
  if (range === "custom" && from && to) return `del ${from} al ${to}`;
  return "los últimos 7 días";
}

function promptDetail(id, phrase) {
  return `Tenés herramientas de Meta Ads. Cuenta publicitaria id ${id}, período: ${phrase}.
Devolvé SOLO JSON compacto (sin markdown) con esta estructura EXACTA:
{"currency":"ARS","account":{"spend":0,"conversations":0,"cost_per_msg":0,"reach":0,"impressions":0,"ctr":0,"clicks":0},"prev_cost_per_msg":0,"campaigns":[{"id":"","name":"","status":"activa","objective":"","spend":0,"conversations":0,"cost_per_msg":0,"reach":0,"impressions":0,"ctr":0}]}
Reglas:
- account: totales agregados. conversations = conversaciones iniciadas por mensajería. cost_per_msg = costo por conversación. CTR en porcentaje.
- prev_cost_per_msg: mismo indicador del período anterior equivalente (misma duración, inmediatamente previo).
- campaigns: hasta 10 campañas ordenadas por gasto desc. id como string. objective en español. cost_per_msg=null si no aplica.
- Números como number (0 si no aplica).`;
}

function promptCreatives(campaignId, phrase) {
  return `Tenés herramientas de Meta Ads. CAMPAÑA id ${campaignId}, período: ${phrase}.
Devolvé SOLO JSON compacto (sin markdown):
{"currency":"ARS","ads":[{"id":"","name":"","status":"activa","format":"imagen","spend":0,"conversations":0,"cost_per_msg":0,"reach":0,"impressions":0,"ctr":0,"clicks":0}]}
ads: hasta 12 anuncios ordenados por gasto desc. format: imagen/video/carrusel/colección/reel. cost_per_msg=null si no aplica.`;
}

function promptAnalysis(name, phrase, payload) {
  return `Sos analista senior de Meta Ads en una agencia argentina. Analizá los datos de "${name}" (${phrase}).
Datos: ${JSON.stringify(payload)}
Devolvé SOLO JSON, español rioplatense, con números concretos:
{"veredicto":"estado general en una frase","bueno":["hasta 3 puntos fuertes"],"malo":["hasta 3 problemas con recomendación"]}`;
}

/* ------------------------------------------------------------------ */
/*  Start                                                               */
/* ------------------------------------------------------------------ */
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`\n🚀 Concepto Ads Server corriendo en puerto ${PORT}`);
  console.log(`📊 Panel disponible en http://localhost:${PORT}`);
  console.log(`💾 Caché: ${redis ? "Redis" : "Memoria"} | TTL: ${CACHE_TTL}s`);
});

server.on("error", (e) => {
  console.error("Error en el servidor:", e);
  process.exit(1);
});
