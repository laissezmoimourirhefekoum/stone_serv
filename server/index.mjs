import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import busboy from "busboy";
import Stripe from "stripe";

// ============================================================
// CHEMIN DU DOSSIER SERVER
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, ".env");

// ============================================================
// CHARGEMENT DU .env (robuste)
// ============================================================

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  try {
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) continue;

      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;

      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();

      value = value.replace(/^(['"])(.*)\1$/, "$2");

      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.error(`Erreur lors du chargement de ${filePath}:`, error.message);
  }
}

loadEnvFile(envPath);

function env(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : undefined;
}

const IS_PRODUCTION = env("NODE_ENV") === "production";

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(env("PORT") || 3002);

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

const DEFAULT_OAUTH_REDIRECT =
  env("OAUTH_REDIRECT_URL") || "http://localhost:5173/";

const AVATAR_BUCKET = "avatars";
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

// ============================================================
// CONFIGURATION STRIPE
// ============================================================

const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET");

const APP_URL = (env("APP_URL") || "http://localhost:5173").replace(/\/+$/, "");

const STRIPE_PRICES = {
  starter: {
    monthly: env("STRIPE_PRICE_STARTER_MONTHLY"),
    annual: env("STRIPE_PRICE_STARTER_ANNUAL"),
  },
  pro: {
    monthly: env("STRIPE_PRICE_PRO_MONTHLY"),
    annual: env("STRIPE_PRICE_PRO_ANNUAL"),
  },
  enterprise: {
    monthly: env("STRIPE_PRICE_ENTERPRISE_MONTHLY"),
    annual: env("STRIPE_PRICE_ENTERPRISE_ANNUAL"),
  },
};

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

// ============================================================
// CONFIGURATION TIKTOK
// ============================================================

const TIKTOK_CLIENT_KEY = env("TIKTOK_CLIENT_KEY");
const TIKTOK_CLIENT_SECRET = env("TIKTOK_CLIENT_SECRET");
const TIKTOK_REDIRECT_URI =
  env("TIKTOK_REDIRECT_URI") || `${APP_URL}/tiktok/callback`;

const TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload";
const TIKTOK_API = "https://open.tiktokapis.com";
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

const tiktokEnabled = Boolean(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET);

// ============================================================
// CONFIGURATION PINTEREST
// ============================================================

const PINTEREST_APP_ID = env("PINTEREST_APP_ID");
const PINTEREST_APP_SECRET = env("PINTEREST_APP_SECRET");
const PINTEREST_REDIRECT_URI =
  env("PINTEREST_REDIRECT_URI") || `${APP_URL}/pinterest/callback`;

const PINTEREST_SCOPES =
  env("PINTEREST_SCOPES") ||
  "user_accounts:read,boards:read,boards:write,pins:read,pins:write";

const PINTEREST_AUTH_URL = "https://www.pinterest.com/oauth/";
const PINTEREST_OAUTH_BASE = (
  env("PINTEREST_OAUTH_BASE") || "https://api.pinterest.com/v5"
).replace(/\/+$/, "");
const PINTEREST_API_BASE = (
  env("PINTEREST_API_BASE") || "https://api-sandbox.pinterest.com/v5"
).replace(/\/+$/, "");

const pinterestEnabled = Boolean(PINTEREST_APP_ID && PINTEREST_APP_SECRET);

// ============================================================
// CONFIGURATION YOUTUBE
// ============================================================

const YOUTUBE_CLIENT_ID = env("YOUTUBE_CLIENT_ID");
const YOUTUBE_CLIENT_SECRET = env("YOUTUBE_CLIENT_SECRET");
const YOUTUBE_REDIRECT_URI =
  env("YOUTUBE_REDIRECT_URI") || `${APP_URL}/youtube/callback`;

const YOUTUBE_SCOPES = (
  env("YOUTUBE_SCOPES") ||
  "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload"
)
  .split(/[\s,]+/)
  .filter(Boolean)
  .join(" ");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

const youtubeEnabled = Boolean(YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET);

// ============================================================
// SECRET DE SIGNATURE DU STATE OAUTH
// ============================================================

const OAUTH_STATE_SECRET =
  env("OAUTH_STATE_SECRET") ||
  TIKTOK_CLIENT_SECRET ||
  PINTEREST_APP_SECRET ||
  YOUTUBE_CLIENT_SECRET;

// ⚠️ En production, un secret de signature OAuth est OBLIGATOIRE :
// les fallbacks (secrets clients OAuth) sont acceptables, mais un
// secret dédié est fortement recommandé.
if (IS_PRODUCTION && !env("OAUTH_STATE_SECRET")) {
  console.warn(
    "⚠️  OAUTH_STATE_SECRET manquant : définis un secret dédié (32+ caractères aléatoires) en production."
  );
}

// ============================================================
// VÉRIFICATION SUPABASE
// ============================================================

const missingVars = [
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_ANON_KEY", SUPABASE_ANON_KEY],
  ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingVars.length > 0) {
  console.error("");
  console.error("Supabase non configuré. Variables manquantes :");
  for (const name of missingVars) console.error(` - ${name}`);
  console.error("");
  console.error("Définis-les dans les variables d'environnement de");
  console.error("ton hébergeur, ou dans le fichier :");
  console.error(envPath);
  console.error("");

  process.exit(1);
}

try {
  const parsed = new URL(SUPABASE_URL);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Protocole invalide");
  }
} catch {
  console.error("");
  console.error("SUPABASE_URL invalide :", JSON.stringify(SUPABASE_URL));
  console.error(
    "Elle doit ressembler à : https://xxxxxxxx.supabase.co (sans guillemets)."
  );
  console.error("");

  process.exit(1);
}

// Debug optionnel : DEBUG_ENV=1 (n'affiche jamais les secrets)
if (env("DEBUG_ENV") === "1") {
  console.log("[env] SUPABASE_URL      :", JSON.stringify(SUPABASE_URL));
  console.log("[env] ANON key length   :", SUPABASE_ANON_KEY.length);
  console.log("[env] SERVICE key length:", SUPABASE_SERVICE_ROLE_KEY.length);
  console.log("[env] APP_URL           :", JSON.stringify(APP_URL));
  console.log("[env] TIKTOK_REDIRECT   :", JSON.stringify(TIKTOK_REDIRECT_URI));
  console.log(
    "[env] PINTEREST_REDIRECT:",
    JSON.stringify(PINTEREST_REDIRECT_URI)
  );
  console.log("[env] PINTEREST_API_BASE:", JSON.stringify(PINTEREST_API_BASE));
  console.log("[env] YOUTUBE_REDIRECT  :", JSON.stringify(YOUTUBE_REDIRECT_URI));
  console.log("[env] YOUTUBE_SCOPES    :", JSON.stringify(YOUTUBE_SCOPES));
}

// ============================================================
// FAIL-FAST EN PRODUCTION
// ============================================================
//
// Sans APP_URL / OAUTH_REDIRECT_URL en production, les redirections
// Stripe et OAuth pointeraient silencieusement vers localhost.
// On refuse de démarrer plutôt que de servir des URLs cassées.

if (IS_PRODUCTION) {
  const fatalMissing = [];

  if (!env("APP_URL") || APP_URL.startsWith("http://localhost")) {
    fatalMissing.push("APP_URL (URL du frontend de production)");
  }

  if (
    !env("OAUTH_REDIRECT_URL") ||
    DEFAULT_OAUTH_REDIRECT.startsWith("http://localhost")
  ) {
    fatalMissing.push("OAUTH_REDIRECT_URL");
  }

  if (!OAUTH_STATE_SECRET) {
    fatalMissing.push(
      "OAUTH_STATE_SECRET (ou au moins un secret client OAuth)"
    );
  }

  if (fatalMissing.length > 0) {
    console.error("");
    console.error("❌ Configuration de production incomplète :");
    for (const name of fatalMissing) console.error(` - ${name}`);
    console.error("");

    process.exit(1);
  }
} else {
  if (!env("APP_URL")) {
    console.warn(
      "⚠️  APP_URL manquant — fallback http://localhost:5173 (dev uniquement)."
    );
  }

  if (!env("OAUTH_REDIRECT_URL")) {
    console.warn(
      "⚠️  OAUTH_REDIRECT_URL manquant — fallback http://localhost:5173/ (dev uniquement)."
    );
  }
}

if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️  Stripe non configuré (STRIPE_SECRET_KEY manquant).");
}

if (!STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "⚠️  STRIPE_WEBHOOK_SECRET manquant — les webhooks ne seront pas vérifiés."
  );
}

if (!tiktokEnabled) {
  console.warn(
    "⚠️  TikTok non configuré (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET manquant)."
  );
}

if (!pinterestEnabled) {
  console.warn(
    "⚠️  Pinterest non configuré (PINTEREST_APP_ID / PINTEREST_APP_SECRET manquant)."
  );
}

if (!youtubeEnabled) {
  console.warn(
    "⚠️  YouTube non configuré (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET manquant)."
  );
}

if (TIKTOK_REDIRECT_URI.includes("#")) {
  console.warn(
    `⚠️  TIKTOK_REDIRECT_URI contient un "#" (${TIKTOK_REDIRECT_URI}) — c'est invalide. Utilise https://<frontend>/tiktok/callback.`
  );
}

if (PINTEREST_REDIRECT_URI.includes("#")) {
  console.warn(
    `⚠️  PINTEREST_REDIRECT_URI contient un "#" (${PINTEREST_REDIRECT_URI}) — c'est invalide. Utilise https://<frontend>/pinterest/callback.`
  );
}

if (YOUTUBE_REDIRECT_URI.includes("#")) {
  console.warn(
    `⚠️  YOUTUBE_REDIRECT_URI contient un "#" (${YOUTUBE_REDIRECT_URI}) — c'est invalide. Utilise https://<frontend>/youtube/callback.`
  );
}

if (pinterestEnabled && PINTEREST_API_BASE.includes("sandbox")) {
  console.warn(
    "ℹ️  Pinterest en mode SANDBOX (PINTEREST_API_BASE = " +
      PINTEREST_API_BASE +
      ")."
  );
}

// ============================================================
// CLIENTS SUPABASE
// ============================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const supabaseOAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: "implicit",
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// ============================================================
// RATE LIMITING (en mémoire, par IP)
// ============================================================
//
// Simple sliding window par IP. Suffisant pour un backend Railway
// mono-instance ; pour du multi-instance, passe à Redis (ioredis +
// rate-limiter-flexible).
//
// Buckets :
//   strict : login, check-verification, refresh (anti brute-force)
//   oauth  : URLs + callbacks OAuth
//   api    : toutes les autres routes authentifiées
//
// TRUST_PROXY=1 derrière Railway pour utiliser X-Forwarded-For.

const TRUST_PROXY = env("TRUST_PROXY") === "1" || IS_PRODUCTION;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (TRUST_PROXY && typeof forwarded === "string") {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }

  return req.socket?.remoteAddress || "unknown";
}

function createRateLimiter({ windowMs, max, label }) {
  const hits = new Map();

  // Nettoyage périodique pour éviter une fuite mémoire.
  const cleaner = setInterval(() => {
    const cutoff = Date.now() - windowMs;

    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((t) => t > cutoff);

      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }, Math.min(windowMs, 5 * 60 * 1000));

  cleaner.unref?.();

  return {
    check(key) {
      const now = Date.now();
      const cutoff = now - windowMs;

      const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);

      if (timestamps.length >= max) {
        const retryAfterMs = timestamps[0] + windowMs - now;

        console.warn(
          `[ratelimit:${label}] Requête refusée pour ${key} (${timestamps.length}/${max} en ${windowMs / 1000}s)`
        );

        return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
      }

      timestamps.push(now);
      hits.set(key, timestamps);

      return { allowed: true, retryAfterSec: null };
    },
  };
}

const limiterStrict = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  label: "auth",
});

const limiterOauth = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  label: "oauth",
});

const limiterApi = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  label: "api",
});

// ============================================================
// CORS
// ============================================================

function normalizeOrigin(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://stone-prod.vercel.app",
  "https://stone-prod-2fpb2146e-xsdevs-projects.vercel.app",
];

const VERCEL_DEPLOYMENT_ORIGIN_PATTERN =
  /^https:\/\/stone-prod(-[a-z0-9]+)?-xsdevs-projects\.vercel\.app$/;

const extraAllowedOrigins = (env("ALLOWED_ORIGINS") || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

if (extraAllowedOrigins.includes("*")) {
  console.warn(
    '⚠️  ALLOWED_ORIGINS contient "*" : ignoré (incompatible avec les credentials). Liste les origines explicitement.'
  );
}

const allowedOrigins = new Set(
  [
    ...DEFAULT_ALLOWED_ORIGINS,
    APP_URL,
    ...extraAllowedOrigins.filter((origin) => origin !== "*"),
  ]
    .map(normalizeOrigin)
    .filter(Boolean)
);

function isOriginAllowed(origin) {
  if (!origin || typeof origin !== "string") return false;

  const normalized = normalizeOrigin(origin);

  return (
    allowedOrigins.has(normalized) ||
    VERCEL_DEPLOYMENT_ORIGIN_PATTERN.test(normalized)
  );
}

const warnedRejectedOrigins = new Set();

// Liste explicite de headers autorisés (on ne réfléchit plus
// aveuglément access-control-request-headers).
const CORS_ALLOWED_HEADERS =
  "Content-Type, Authorization, X-Requested-With";

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  res.setHeader("Vary", "Origin");

  if (origin) {
    if (isOriginAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", normalizeOrigin(origin));
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else if (!warnedRejectedOrigins.has(origin)) {
      warnedRejectedOrigins.add(origin);
      console.warn(
        `[cors] Origine refusée : ${origin} — ajoute-la à ALLOWED_ORIGINS ou APP_URL sur Railway si elle est légitime.`
      );
    }
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ============================================================
// VALIDATION DU redirectTo (anti open redirect)
// ============================================================
//
// Le redirectTo fourni par le client doit être une URL dont l'origine
// est explicitement autorisée (mêmes règles que CORS). N'importe
// quelle autre valeur est ignorée et remplacée par le défaut.

function sanitizeRedirectTo(value) {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_OAUTH_REDIRECT;
  }

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return DEFAULT_OAUTH_REDIRECT;
    }

    const origin = parsed.origin;

    if (!isOriginAllowed(origin)) {
      console.warn(
        `[oauth] redirectTo refusé (origine non autorisée) : ${origin}`
      );
      return DEFAULT_OAUTH_REDIRECT;
    }

    return parsed.toString();
  } catch {
    return DEFAULT_OAUTH_REDIRECT;
  }
}

// ============================================================
// LOGGING SERVEUR + ERREURS
// ============================================================

function newRequestId() {
  return crypto.randomUUID().slice(0, 8);
}

// En production, le client ne reçoit JAMAIS le message d'erreur
// interne (fuite d'implémentation) : seulement un message générique
// + un requestId corrélable aux logs serveur.
function internalErrorResponse(res, requestId, error, context) {
  console.error(`[${requestId}] ${context}:`, error);

  if (res.headersSent) {
    res.end();
    return;
  }

  sendJson(res, 500, {
    success: false,
    error: IS_PRODUCTION
      ? "Internal server error"
      : error instanceof Error
      ? error.message
      : "Internal server error",
    request_id: requestId,
  });
}

// ============================================================
// JSON BODY
// ============================================================

const MAX_JSON_BODY = 1024 * 1024; // 1 Mo suffit pour toutes nos routes JSON

async function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let rejected = false;

    req.on("data", (chunk) => {
      if (rejected) return;

      body += chunk.toString();

      if (body.length > MAX_JSON_BODY) {
        rejected = true;
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (rejected) return;

      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

// ============================================================
// RAW BODY (signature Stripe)
// ============================================================

const MAX_RAW_BODY = MAX_JSON_BODY; // les payloads Stripe sont petits

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on("data", (chunk) => {
      if (rejected) return;

      size += chunk.length;
      chunks.push(chunk);

      if (size > MAX_RAW_BODY) {
        rejected = true;
        reject(new Error("Webhook body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

// ============================================================
// VALIDATION DU TYPE D'IMAGE (magic bytes, pas le header client)
// ============================================================
//
// Le Content-Type envoyé par le client est arbitraire : on vérifie
// les magic bytes du buffer. SVG volontairement EXCLU (XSS possible
// via un SVG servi depuis le domaine public du bucket).

const ALLOWED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // PNG : 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG : FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF : "GIF8"
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }

  // WebP : "RIFF"...."WEBP"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

// ============================================================
// MULTIPART BODY (upload d'avatar)
// ============================================================

function parseAvatarUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;

    try {
      bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_AVATAR_SIZE,
          files: 1,
        },
      });
    } catch (initError) {
      reject(initError);
      return;
    }

    let fileBuffer = null;
    let fileName = "avatar";
    let mimeType = "";
    let fileTooLarge = false;
    let fileFound = false;

    bb.on("file", (fieldname, file, info) => {
      if (fieldname !== "avatar") {
        file.resume();
        return;
      }

      fileFound = true;
      fileName = info?.filename || fileName;
      mimeType = info?.mimeType || info?.mimetype || "application/octet-stream";

      const chunks = [];

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("limit", () => {
        fileTooLarge = true;
      });

      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("field", () => {
      // On ignore les autres champs.
    });

    bb.on("close", () => {
      if (fileTooLarge) {
        reject(new Error("FILE_TOO_LARGE"));
        return;
      }

      if (!fileFound || !fileBuffer) {
        reject(new Error("NO_FILE"));
        return;
      }

      resolve({
        buffer: fileBuffer,
        fileName,
        mimeType,
      });
    });

    bb.on("error", (error) => {
      reject(error);
    });

    req.pipe(bb);
  });
}

function extractAvatarStoragePath(filePathOrUrl) {
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const markerIndex = filePathOrUrl.indexOf(marker);

  if (markerIndex !== -1) {
    const raw = filePathOrUrl.slice(markerIndex + marker.length).split("?")[0];

    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  if (!filePathOrUrl.startsWith("http")) {
    return filePathOrUrl;
  }

  return null;
}

function isOwnedAvatarPath(storagePath, userId) {
  if (typeof storagePath !== "string") return false;
  if (storagePath.includes("..")) return false;
  if (storagePath.startsWith("/")) return false;

  return storagePath.startsWith(`${userId}/`);
}

// ============================================================
// LIMITE DE CONCURRENCE DES UPLOADS VIDÉO (anti OOM)
// ============================================================
//
// Chaque upload TikTok bufferise jusqu'à 100 Mo en RAM. Sans
// limite de concurrence, quelques requêtes parallèles suffisent à
// faire crasher le container Railway (OOM). MAX_VIDEO_UPLOADS
// est la borne supérieure raisonnable pour une petite instance.

const MAX_VIDEO_UPLOADS = Number(env("MAX_VIDEO_UPLOADS") || 2);
let activeVideoUploads = 0;
const videoUploadWaiters = [];

function acquireVideoSlot() {
  if (activeVideoUploads < MAX_VIDEO_UPLOADS) {
    activeVideoUploads++;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    videoUploadWaiters.push({ resolve, reject });

    // File d'attente bornée : on refuse plutôt que d'empiler.
    if (videoUploadWaiters.length > 10) {
      videoUploadWaiters.pop();
      reject(new Error("UPLOAD_QUEUE_FULL"));
    }
  });
}

function releaseVideoSlot() {
  activeVideoUploads = Math.max(0, activeVideoUploads - 1);

  const next = videoUploadWaiters.shift();

  if (next) {
    activeVideoUploads++;
    next.resolve();
  }
}

// ============================================================
// RESPONSE
// ============================================================

function sendJson(res, statusCode, data) {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });

  res.end(JSON.stringify(data));
}

// ============================================================
// AUTHENTIFICATION
// ============================================================

async function getAuthenticatedUser(req) {
  const authorization = req.headers.authorization;

  if (!authorization) {
    return {
      user: null,
      token: null,
      error: "Missing Authorization header",
      code: "NO_TOKEN",
    };
  }

  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return {
      user: null,
      token: null,
      error: "Missing access token",
      code: "NO_TOKEN",
    };
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    const isExpired = Boolean(
      error?.message?.toLowerCase().includes("expired")
    );

    return {
      user: null,
      token: null,
      error: isExpired ? "Session expired" : "Invalid or expired session",
      code: isExpired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
    };
  }

  return {
    user,
    token,
    error: null,
    code: null,
  };
}

// ============================================================
// NORMALISATION UTILISATEUR
// ============================================================

function resolveAvatar(metadata) {
  if (typeof metadata.custom_avatar_url === "string") {
    return metadata.custom_avatar_url;
  }

  return (
    metadata.avatar_url || metadata.avatarUrl || metadata.picture || ""
  );
}

function formatUser(user) {
  if (!user) return null;

  const metadata = user.user_metadata || {};

  const fullName = metadata.full_name || metadata.name || "";
  const [guessedFirst, ...guessedRest] = fullName.split(" ").filter(Boolean);

  return {
    id: user.id,
    email: user.email || "",
    first_name:
      metadata.first_name ||
      metadata.firstName ||
      metadata.given_name ||
      guessedFirst ||
      "",
    last_name:
      metadata.last_name ||
      metadata.lastName ||
      metadata.family_name ||
      guessedRest.join(" ") ||
      "",
    avatar_url: resolveAvatar(metadata),
    bio: metadata.bio || "",
    email_confirmed_at: user.email_confirmed_at || null,
    created_at: user.created_at || null,
    subscription: metadata.subscription || null,
  };
}

// ============================================================
// STRIPE — HELPERS
// ============================================================

async function getOrCreateStripeCustomer(user) {
  const existing = user.user_metadata?.stripe_customer_id;
  if (existing) return existing;

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  });

  await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...(user.user_metadata || {}),
      stripe_customer_id: customer.id,
    },
  });

  return customer.id;
}

async function resolveUserIdFromCustomer(customerId) {
  if (!customerId) return null;

  const id = typeof customerId === "string" ? customerId : customerId.id;

  try {
    const customer = await stripe.customers.retrieve(id);
    if (customer && !customer.deleted) {
      return customer.metadata?.supabase_user_id || null;
    }
  } catch (error) {
    console.error("resolveUserIdFromCustomer error:", error.message);
  }

  return null;
}

async function syncSubscriptionToUser(userId, subscription) {
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
  const current = data?.user?.user_metadata || {};

  const price = subscription.items?.data?.[0]?.price;

  const metadata = {
    ...current,
    subscription: {
      id: subscription.id,
      status: subscription.status,
      price_id: price?.id || null,
      product_id: price?.product || null,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
      customer_id:
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id || null,
    },
  };

  await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: metadata,
  });
}

// ============================================================
// STATE OAUTH SIGNÉ (anti-CSRF, stateless)
// ============================================================

function hmac(value) {
  return crypto
    .createHmac("sha256", OAUTH_STATE_SECRET)
    .update(value)
    .digest("hex");
}

function createOAuthState(provider, userId) {
  const payload = `${provider}.${userId}.${Date.now() + 10 * 60 * 1000}.${crypto
    .randomBytes(8)
    .toString("hex")}`;

  return Buffer.from(`${payload}.${hmac(payload)}`).toString("base64url");
}

function verifyOAuthState(provider, state, userId) {
  try {
    const decoded = Buffer.from(String(state), "base64url").toString("utf-8");
    const lastDot = decoded.lastIndexOf(".");

    if (lastDot === -1) return false;

    const payload = decoded.slice(0, lastDot);
    const signature = decoded.slice(lastDot + 1);

    const a = Buffer.from(signature);
    const b = Buffer.from(hmac(payload));

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

    const [stateProvider, stateUserId, expiresAt] = payload.split(".");

    return (
      stateProvider === provider &&
      stateUserId === userId &&
      Number(expiresAt) > Date.now()
    );
  } catch {
    return false;
  }
}

// ============================================================
// TIKTOK — APPEL API
// ============================================================

async function tiktokApi(
  pathname,
  { method = "POST", token, json, form } = {}
) {
  const headers = {};
  let body;

  if (token) headers.Authorization = `Bearer ${token}`;

  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(json);
  }

  const response = await fetch(`${TIKTOK_API}${pathname}`, {
    method,
    headers,
    body,
  });

  const data = await response.json().catch(() => ({}));

  if (typeof data.error === "string") {
    throw new Error(data.error_description || data.error);
  }

  if (data.error?.code && data.error.code !== "ok") {
    const err = new Error(data.error.message || data.error.code);
    err.tiktokCode = data.error.code;
    throw err;
  }

  return data;
}

// ============================================================
// TIKTOK — STOCKAGE / REFRESH DES TOKENS
// ============================================================

async function saveTikTokTokens(userId, t, extra = {}) {
  const now = Date.now();

  const { error } = await supabaseAdmin.from("tiktok_accounts").upsert(
    {
      user_id: userId,
      open_id: t.open_id,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      access_expires_at: new Date(now + t.expires_in * 1000).toISOString(),
      refresh_expires_at: new Date(
        now + t.refresh_expires_in * 1000
      ).toISOString(),
      scope: t.scope,
      updated_at: new Date().toISOString(),
      ...extra,
    },
    { onConflict: "user_id" }
  );

  if (error) throw new Error(error.message);
}

async function getTikTokAccount(userId) {
  const { data } = await supabaseAdmin
    .from("tiktok_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data || null;
}

async function getValidTikTokToken(userId) {
  const account = await getTikTokAccount(userId);

  if (!account) {
    const err = new Error("TikTok account not connected");
    err.statusCode = 400;
    err.code = "TIKTOK_NOT_CONNECTED";
    throw err;
  }

  if (new Date(account.access_expires_at).getTime() > Date.now() + 60_000) {
    return account.access_token;
  }

  if (new Date(account.refresh_expires_at).getTime() <= Date.now()) {
    const err = new Error("TikTok session expired, please reconnect");
    err.statusCode = 401;
    err.code = "TIKTOK_REFRESH_EXPIRED";
    throw err;
  }

  const refreshed = await tiktokApi("/v2/oauth/token/", {
    form: {
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
    },
  });

  await saveTikTokTokens(userId, refreshed);
  return refreshed.access_token;
}

// ============================================================
// TIKTOK — UPLOAD VIDÉO (multipart)
// ============================================================

function parseVideoUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;

    try {
      bb = busboy({
        headers: req.headers,
        limits: { fileSize: MAX_VIDEO_SIZE, files: 1 },
      });
    } catch (initError) {
      reject(initError);
      return;
    }

    const fields = {};
    const chunks = [];
    let fileFound = false;
    let tooLarge = false;
    let mimeType = "";

    bb.on("file", (fieldname, file, info) => {
      if (fieldname !== "video") {
        file.resume();
        return;
      }

      fileFound = true;
      mimeType = info?.mimeType || "";

      file.on("data", (chunk) => chunks.push(chunk));
      file.on("limit", () => {
        tooLarge = true;
      });
    });

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("close", () => {
      if (tooLarge) {
        reject(new Error("FILE_TOO_LARGE"));
        return;
      }

      if (!fileFound) {
        reject(new Error("NO_FILE"));
        return;
      }

      resolve({ buffer: Buffer.concat(chunks), mimeType, fields });
    });

    bb.on("error", reject);

    req.pipe(bb);
  });
}

// ⚠️ FIX : Math.floor perdait le dernier chunk partiel (une vidéo
// de 75 Mo n'uploadait que 70 Mo). On utilise Math.ceil.
function computeChunking(size) {
  const MB = 1024 * 1024;

  if (size <= 64 * MB) {
    return { chunkSize: size, totalChunks: 1 };
  }

  const chunkSize = 10 * MB;
  return { chunkSize, totalChunks: Math.ceil(size / chunkSize) };
}

async function uploadVideoToTikTok(uploadUrl, buffer, mimeType, chunking) {
  const { chunkSize, totalChunks } = chunking;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end =
      i === totalChunks - 1 ? buffer.length - 1 : start + chunkSize - 1;
    const part = buffer.subarray(start, end + 1);

    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
      },
      body: part,
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(
        `TikTok upload failed (chunk ${i + 1}/${totalChunks}, HTTP ${response.status})`
      );
    }
  }
}

function buildPostInfo(fields) {
  const toBool = (v) => v === true || v === "true" || v === "1";

  return {
    title: String(fields.title || "").slice(0, 2200),
    privacy_level: String(fields.privacy_level || "SELF_ONLY"),
    disable_comment: toBool(fields.disable_comment),
    disable_duet: toBool(fields.disable_duet),
    disable_stitch: toBool(fields.disable_stitch),
  };
}

function sendTikTokError(res, error) {
  sendJson(res, error.statusCode || 500, {
    success: false,
    error: error.message || "TikTok error",
    code: error.code || error.tiktokCode || undefined,
  });
}

// ============================================================
// PINTEREST — APPEL API
// ============================================================

async function pinterestApi(
  pathname,
  { method = "GET", base = PINTEREST_API_BASE, token, basic = false, form, json } = {}
) {
  const headers = { Accept: "application/json" };
  let body;

  if (basic) {
    const credentials = Buffer.from(
      `${PINTEREST_APP_ID}:${PINTEREST_APP_SECRET}`
    ).toString("base64");

    headers.Authorization = `Basic ${credentials}`;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }

  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      data.message ||
        data.error_description ||
        (typeof data.error === "string" ? data.error : "") ||
        `Pinterest error (HTTP ${response.status})`
    );
    err.pinterestStatus = response.status;
    err.pinterestCode = data.code;
    throw err;
  }

  return data;
}

// ============================================================
// PINTEREST — STOCKAGE / REFRESH DES TOKENS
// ============================================================

async function savePinterestTokens(userId, t, extra = {}) {
  const now = Date.now();

  const accessTtl = Number(t.expires_in) || 30 * 24 * 60 * 60;
  const refreshTtl =
    Number(t.refresh_token_expires_in) || 365 * 24 * 60 * 60;

  const { error } = await supabaseAdmin.from("pinterest_accounts").upsert(
    {
      user_id: userId,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      access_expires_at: new Date(now + accessTtl * 1000).toISOString(),
      refresh_expires_at: new Date(now + refreshTtl * 1000).toISOString(),
      scope: t.scope || null,
      updated_at: new Date().toISOString(),
      ...extra,
    },
    { onConflict: "user_id" }
  );

  if (error) throw new Error(error.message);
}

async function getPinterestAccount(userId) {
  const { data } = await supabaseAdmin
    .from("pinterest_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data || null;
}

async function getValidPinterestToken(userId) {
  const account = await getPinterestAccount(userId);

  if (!account) {
    const err = new Error("Pinterest account not connected");
    err.statusCode = 400;
    err.code = "PINTEREST_NOT_CONNECTED";
    throw err;
  }

  if (new Date(account.access_expires_at).getTime() > Date.now() + 60_000) {
    return account.access_token;
  }

  if (new Date(account.refresh_expires_at).getTime() <= Date.now()) {
    const err = new Error("Pinterest session expired, please reconnect");
    err.statusCode = 401;
    err.code = "PINTEREST_REFRESH_EXPIRED";
    throw err;
  }

  const refreshed = await pinterestApi("/oauth/token", {
    method: "POST",
    base: PINTEREST_OAUTH_BASE,
    basic: true,
    form: {
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
    },
  });

  await savePinterestTokens(userId, {
    ...refreshed,
    refresh_token: refreshed.refresh_token || account.refresh_token,
  });

  return refreshed.access_token;
}

function sendPinterestError(res, error) {
  sendJson(res, error.statusCode || error.pinterestStatus || 500, {
    success: false,
    error: error.message || "Pinterest error",
    code: error.code || error.pinterestCode || undefined,
  });
}

// ============================================================
// YOUTUBE — APPEL API GOOGLE
// ============================================================

async function googleRequest(
  requestUrl,
  { method = "GET", token, form, json } = {}
) {
  const headers = { Accept: "application/json" };
  let body;

  if (token) headers.Authorization = `Bearer ${token}`;

  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(json);
  }

  const response = await fetch(requestUrl, { method, headers, body });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const oauthError = typeof data.error === "string" ? data.error : undefined;

    const err = new Error(
      data.error_description ||
        data.error?.message ||
        oauthError ||
        `Google error (HTTP ${response.status})`
    );
    err.googleStatus = response.status;
    err.googleError = oauthError;
    throw err;
  }

  return data;
}

async function fetchYouTubeChannel(accessToken) {
  const data = await googleRequest(
    `${YOUTUBE_API_BASE}/channels?part=snippet&mine=true`,
    { token: accessToken }
  );

  const channel = data.items?.[0];
  if (!channel) return null;

  const thumbnails = channel.snippet?.thumbnails || {};

  return {
    id: channel.id,
    title: channel.snippet?.title || null,
    customUrl: channel.snippet?.customUrl || null,
    avatarUrl:
      thumbnails.high?.url ||
      thumbnails.medium?.url ||
      thumbnails.default?.url ||
      null,
  };
}

// ============================================================
// YOUTUBE — STOCKAGE / REFRESH DES TOKENS
// ============================================================

async function saveYouTubeTokens(userId, t, extra = {}) {
  const now = Date.now();
  const accessTtl = Number(t.expires_in) || 3600;

  const row = {
    user_id: userId,
    access_token: t.access_token,
    access_expires_at: new Date(now + accessTtl * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    ...extra,
  };

  if (t.refresh_token) row.refresh_token = t.refresh_token;
  if (t.scope) row.scope = t.scope;

  if (t.refresh_token_expires_in !== undefined) {
    row.refresh_expires_at = t.refresh_token_expires_in
      ? new Date(now + Number(t.refresh_token_expires_in) * 1000).toISOString()
      : null;
  }

  const { error } = await supabaseAdmin
    .from("youtube_accounts")
    .upsert(row, { onConflict: "user_id" });

  if (error) throw new Error(error.message);
}

async function getYouTubeAccount(userId) {
  const { data } = await supabaseAdmin
    .from("youtube_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data || null;
}

async function getValidYouTubeToken(userId) {
  const account = await getYouTubeAccount(userId);

  if (!account) {
    const err = new Error("YouTube account not connected");
    err.statusCode = 400;
    err.code = "YOUTUBE_NOT_CONNECTED";
    throw err;
  }

  if (new Date(account.access_expires_at).getTime() > Date.now() + 60_000) {
    return account.access_token;
  }

  const refreshExpired =
    account.refresh_expires_at &&
    new Date(account.refresh_expires_at).getTime() <= Date.now();

  if (!account.refresh_token || refreshExpired) {
    const err = new Error("YouTube session expired, please reconnect");
    err.statusCode = 401;
    err.code = "YOUTUBE_REFRESH_EXPIRED";
    throw err;
  }

  let refreshed;

  try {
    refreshed = await googleRequest(GOOGLE_TOKEN_URL, {
      method: "POST",
      form: {
        client_id: YOUTUBE_CLIENT_ID,
        client_secret: YOUTUBE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: account.refresh_token,
      },
    });
  } catch (refreshError) {
    if (refreshError.googleError === "invalid_grant") {
      const err = new Error("YouTube session expired, please reconnect");
      err.statusCode = 401;
      err.code = "YOUTUBE_REFRESH_EXPIRED";
      throw err;
    }

    throw refreshError;
  }

  await saveYouTubeTokens(userId, refreshed);
  return refreshed.access_token;
}

function sendYouTubeError(res, error) {
  sendJson(res, error.statusCode || error.googleStatus || 500, {
    success: false,
    error: error.message || "YouTube error",
    code: error.code || error.googleError || undefined,
  });
}

// ============================================================
// SERVER
// ============================================================

const server = createServer(async (req, res) => {
  const requestId = newRequestId();

  try {
    setCorsHeaders(req, res);
  } catch (corsError) {
    console.error(`[${requestId}] CORS error:`, corsError);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Length": "0" });
    res.end();
    return;
  }

  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || `localhost:${PORT}`}`
    );

    const clientIp = getClientIp(req);

    // ========================================================
    // RATE LIMITING (par IP, avant toute logique métier)
    // ========================================================
    //
    // strict : brute-force des credentials
    // oauth  : génération d'URLs et callbacks OAuth
    // api    : défaut pour tout le reste
    //
    // Les webhooks Stripe (serveur → serveur, signature vérifiée)
    // et le health check sont exemptés.

    const pathname = url.pathname;
    const isStripeWebhook =
      req.method === "POST" && pathname === "/api/stripe/webhook";
    const isHealth = req.method === "GET" && pathname === "/api/health";

    if (!isStripeWebhook && !isHealth) {
      const limiter = pathname.startsWith("/api/auth/login") ||
        pathname.startsWith("/api/auth/check-verification") ||
        pathname.startsWith("/api/auth/signup") ||
        pathname.startsWith("/api/auth/refresh")
        ? limiterStrict
        : pathname.startsWith("/api/auth/") ||
          pathname.startsWith("/api/tiktok/auth/") ||
          pathname.startsWith("/api/pinterest/auth/") ||
          pathname.startsWith("/api/youtube/auth/")
        ? limiterOauth
        : limiterApi;

      const { allowed, retryAfterSec } = limiter.check(clientIp);

      if (!allowed) {
        if (retryAfterSec) {
          res.setHeader("Retry-After", String(retryAfterSec));
        }

        sendJson(res, 429, {
          success: false,
          error: "Too many requests. Please try again later.",
        });
        return;
      }
    }

    // ========================================================
    // HEALTH
    // ========================================================

    if (isHealth) {
      sendJson(res, 200, {
        success: true,
        server: "Stone",
        supabase: true,
        stripe: Boolean(stripe),
        tiktok: tiktokEnabled,
        pinterest: pinterestEnabled,
        youtube: youtubeEnabled,
      });

      return;
    }

    // ========================================================
    // AUTH — SIGN UP
    // ========================================================

    if (req.method === "POST" && pathname === "/api/auth/signup") {
      const body = await getJsonBody(req);

      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");

      const firstName = String(
        body.firstName ?? body.first_name ?? ""
      ).trim();
      const lastName = String(
        body.lastName ?? body.last_name ?? ""
      ).trim();

      if (!email || !password) {
        sendJson(res, 400, {
          success: false,
          error: "Email and password are required",
        });
        return;
      }

      if (password.length < 6) {
        sendJson(res, 400, {
          success: false,
          error: "Password must contain at least 6 characters",
        });
        return;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 400, {
          success: false,
          error: "Invalid email address",
        });
        return;
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName.slice(0, 100),
            last_name: lastName.slice(0, 100),
          },
        },
      });

      if (error) {
        sendJson(res, 400, {
          success: false,
          error: error.message,
        });
        return;
      }

      sendJson(res, 201, {
        success: true,
        user: data.user ? formatUser(data.user) : null,
        session: data.session
          ? {
              access_token: data.session.access_token,
              refresh_token: data.session.refresh_token,
            }
          : null,
        message: data.session
          ? "Account created successfully"
          : "Account created. Check your email to confirm your account.",
      });

      return;
    }

    // ========================================================
    // AUTH — LOGIN
    // ========================================================

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await getJsonBody(req);

      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");

      if (!email || !password) {
        sendJson(res, 400, {
          success: false,
          error: "Email and password are required",
        });
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        // Message volontairement générique côté brute-force : on
        // laisse Supabase décider (il ne révèle pas l'existence
        // du compte avec un message unique).
        sendJson(res, 401, {
          success: false,
          error: error.message,
        });
        return;
      }

      sendJson(res, 200, {
        success: true,
        user: data.user ? formatUser(data.user) : null,
        session: data.session
          ? {
              access_token: data.session.access_token,
              refresh_token: data.session.refresh_token,
            }
          : null,
      });

      return;
    }

    // ========================================================
    // AUTH — CHECK EMAIL VERIFICATION
    // ========================================================
    //
    // Cette route est un oracle de credentials : elle est sur le
    // limiter STRICT (10 / 15 min / IP), comme le login.

    if (
      req.method === "POST" &&
      pathname === "/api/auth/check-verification"
    ) {
      const body = await getJsonBody(req);

      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");

      if (!email || !password) {
        sendJson(res, 400, {
          success: false,
          error: "Email and password are required",
        });
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        const notConfirmed =
          error.code === "email_not_confirmed" ||
          error.message.toLowerCase().includes("not confirmed");

        if (notConfirmed) {
          sendJson(res, 200, { success: true, verified: false });
          return;
        }

        sendJson(res, 401, { success: false, error: error.message });
        return;
      }

      sendJson(res, 200, {
        success: true,
        verified: Boolean(data.user?.email_confirmed_at),
        session: data.session
          ? {
              access_token: data.session.access_token,
              refresh_token: data.session.refresh_token,
            }
          : null,
      });

      return;
    }

    // ========================================================
    // AUTH — GOOGLE : URL D'AUTORISATION
    // ========================================================
    //
    // ⚠️ FIX OPEN REDIRECT : redirectTo est validé avec
    // sanitizeRedirectTo() (l'origine doit être dans la liste CORS).
    // N'importe quelle URL non autorisée est remplacée par le défaut.

    if (req.method === "POST" && pathname === "/api/auth/google/url") {
      let body = {};

      try {
        body = await getJsonBody(req);
      } catch {
        body = {};
      }

      const redirectTo = sanitizeRedirectTo(body.redirectTo);

      const { data, error: oauthError } =
        await supabaseOAuth.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo,
            skipBrowserRedirect: true,
            queryParams: {
              access_type: "offline",
              prompt: "select_account",
            },
          },
        });

      if (oauthError || !data?.url) {
        internalErrorResponse(res, requestId, oauthError, "google/url");
        return;
      }

      sendJson(res, 200, {
        success: true,
        url: data.url,
      });

      return;
    }

    // ========================================================
    // AUTH — GITHUB : URL D'AUTORISATION
    // ========================================================

    if (req.method === "POST" && pathname === "/api/auth/github/url") {
      let body = {};

      try {
        body = await getJsonBody(req);
      } catch {
        body = {};
      }

      const redirectTo = sanitizeRedirectTo(body.redirectTo);

      const { data, error: oauthError } =
        await supabaseOAuth.auth.signInWithOAuth({
          provider: "github",
          options: {
            redirectTo,
            skipBrowserRedirect: true,
            scopes: "read:user user:email",
          },
        });

      if (oauthError || !data?.url) {
        internalErrorResponse(res, requestId, oauthError, "github/url");
        return;
      }

      sendJson(res, 200, {
        success: true,
        url: data.url,
      });

      return;
    }

    // ========================================================
    // AUTH — LOGOUT
    // ========================================================

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      sendJson(res, 200, { success: true });
      return;
    }

    // ========================================================
    // AUTH — REFRESH TOKEN
    // ========================================================

    if (req.method === "POST" && pathname === "/api/auth/refresh") {
      const body = await getJsonBody(req);

      const refreshToken = String(
        body.refreshToken ?? body.refresh_token ?? ""
      );

      if (!refreshToken) {
        sendJson(res, 400, {
          success: false,
          error: "Missing refresh token",
        });
        return;
      }

      const { data, error: refreshError } =
        await supabase.auth.refreshSession({
          refresh_token: refreshToken,
        });

      if (refreshError || !data.session) {
        sendJson(res, 401, {
          success: false,
          error: "Invalid or expired refresh token",
          code: "INVALID_REFRESH_TOKEN",
        });

        return;
      }

      sendJson(res, 200, {
        success: true,
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        },
      });

      return;
    }

    // ========================================================
    // AUTH — RESEND VERIFICATION EMAIL
    // ========================================================

    if (
      req.method === "POST" &&
      pathname === "/api/auth/resend-verification"
    ) {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      if (user.email_confirmed_at) {
        sendJson(res, 400, {
          success: false,
          error: "This email is already verified",
        });
        return;
      }

      if (!user.email) {
        sendJson(res, 400, {
          success: false,
          error: "No email associated with this account",
        });
        return;
      }

      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email: user.email,
      });

      if (resendError) {
        internalErrorResponse(res, requestId, resendError, "resend");
        return;
      }

      sendJson(res, 200, {
        success: true,
        message: "Verification email sent",
      });

      return;
    }

    // ========================================================
    // CURRENT USER
    // ========================================================

    if (req.method === "GET" && pathname === "/api/user") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      sendJson(res, 200, {
        success: true,
        user: formatUser(user),
      });

      return;
    }

    // ========================================================
    // USER PROFILE — GET
    // ========================================================

    if (req.method === "GET" && pathname === "/api/user/profile") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      sendJson(res, 200, {
        success: true,
        user: formatUser(user),
      });

      return;
    }

    // ========================================================
    // USER PROFILE — UPDATE
    // ========================================================

    if (
      (req.method === "PUT" || req.method === "PATCH") &&
      pathname === "/api/user/profile"
    ) {
      const { user, token, error, code } = await getAuthenticatedUser(req);

      if (!user || !token) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);

      const metadata = { ...(user.user_metadata || {}) };

      // Limitation des longueurs : user_metadata est borné côté
      // Supabase (1 Ko par défaut) ; sans limite, un body de 1 Mo
      // de JSON pouvait y être copié.
      const MAX_FIELD = 500;

      const limitedString = (value, max) =>
        String(value ?? "").slice(0, max);

      if (
        body.firstName !== undefined ||
        body.first_name !== undefined
      ) {
        metadata.first_name = limitedString(
          body.firstName ?? body.first_name ?? "",
          100
        );
      }

      if (body.lastName !== undefined || body.last_name !== undefined) {
        metadata.last_name = limitedString(
          body.lastName ?? body.last_name ?? "",
          100
        );
      }

      if (body.bio !== undefined) {
        metadata.bio = limitedString(body.bio, MAX_FIELD);
      }

      if (body.avatarUrl !== undefined || body.avatar_url !== undefined) {
        metadata.custom_avatar_url = limitedString(
          body.avatarUrl ?? body.avatar_url ?? "",
          1000
        );
      }

      const { data, error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          user_metadata: metadata,
        });

      if (updateError) {
        internalErrorResponse(res, requestId, updateError, "profile/update");
        return;
      }

      sendJson(res, 200, {
        success: true,
        user: formatUser(data.user),
      });

      return;
    }

    // ========================================================
    // USER PASSWORD — UPDATE
    // ========================================================
    //
    // ⚠️ NOTE : signInWithPassword pour vérifier le mot de passe
    // courant crée une session Supabase supplémentaire. C'est le
    // seul moyen simple avec le client actuel ; l'impact est limité
    // (sessions multiples autorisées par défaut), mais si tu actives
    // une limite de sessions côté Supabase, passe par une vérification
    // dédiée. La route est protégée par le limiter API.

    if (
      (req.method === "PUT" || req.method === "POST") &&
      pathname === "/api/user/password"
    ) {
      const { user, token, error, code } = await getAuthenticatedUser(req);

      if (!user || !token) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);

      const currentPassword = String(
        body.currentPassword ?? body.current_password ?? ""
      );
      const newPassword = String(body.newPassword ?? body.new_password ?? "");

      if (!currentPassword || !newPassword) {
        sendJson(res, 400, {
          success: false,
          error: "Current and new password are required",
        });
        return;
      }

      if (newPassword.length < 8) {
        sendJson(res, 400, {
          success: false,
          error: "New password must contain at least 8 characters",
        });
        return;
      }

      if (!user.email) {
        sendJson(res, 400, {
          success: false,
          error: "No email associated with this account",
        });
        return;
      }

      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });

      if (verifyError) {
        sendJson(res, 401, {
          success: false,
          error: "Current password is incorrect",
        });
        return;
      }

      const { error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          password: newPassword,
        });

      if (updateError) {
        internalErrorResponse(res, requestId, updateError, "password/update");
        return;
      }

      sendJson(res, 200, {
        success: true,
        message: "Password updated successfully",
      });

      return;
    }

    // ========================================================
    // USER AVATAR — UPLOAD
    // ========================================================
    //
    // ⚠️ FIX XSS : le type est validé par MAGIC BYTES
    // (sniffImageType), pas par le Content-Type du client.
    // SVG exclu. Whitelist : PNG / JPEG / WebP / GIF.

    if (req.method === "POST" && pathname === "/api/user/avatar") {
      const { user, token, error, code } = await getAuthenticatedUser(req);

      if (!user || !token) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      let upload;

      try {
        upload = await parseAvatarUpload(req);
      } catch (uploadError) {
        const message =
          uploadError instanceof Error &&
          uploadError.message === "FILE_TOO_LARGE"
            ? "Avatar is too large. Maximum size is 2 MB."
            : uploadError instanceof Error &&
              uploadError.message === "NO_FILE"
            ? "No 'avatar' file was provided."
            : "Could not read the uploaded file.";

        sendJson(res, 400, { success: false, error: message });
        return;
      }

      const sniffedType = sniffImageType(upload.buffer);

      if (!sniffedType || !ALLOWED_AVATAR_TYPES.includes(sniffedType)) {
        sendJson(res, 400, {
          success: false,
          error: "Unsupported image format. Use PNG, JPEG, WebP or GIF.",
        });
        return;
      }

      const EXTENSION_BY_TYPE = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
      };

      // Extension dérivée du type RÉEL, pas du nom de fichier client.
      const extension = EXTENSION_BY_TYPE[sniffedType];

      const storagePath = `${user.id}/${crypto.randomUUID()}.${extension}`;

      const { error: uploadStorageError } = await supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .upload(storagePath, upload.buffer, {
          contentType: sniffedType,
          upsert: true,
        });

      if (uploadStorageError) {
        internalErrorResponse(
          res,
          requestId,
          uploadStorageError,
          "avatar/upload"
        );
        return;
      }

      const { data: publicUrlData } = supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .getPublicUrl(storagePath);

      sendJson(res, 200, {
        success: true,
        avatar_url: publicUrlData.publicUrl,
      });

      return;
    }

    // ========================================================
    // USER AVATAR — DELETE
    // ========================================================

    if (req.method === "DELETE" && pathname === "/api/user/avatar") {
      const { user, token, error, code } = await getAuthenticatedUser(req);

      if (!user || !token) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);

      const filePathOrUrl = String(body.filePathOrUrl || "").trim();

      if (!filePathOrUrl) {
        sendJson(res, 400, {
          success: false,
          error: "Missing filePathOrUrl",
        });
        return;
      }

      const storagePath = extractAvatarStoragePath(filePathOrUrl);

      if (!storagePath) {
        sendJson(res, 200, { success: true });
        return;
      }

      if (!isOwnedAvatarPath(storagePath, user.id)) {
        sendJson(res, 403, {
          success: false,
          error: "You can only delete your own avatar",
        });
        return;
      }

      const { error: removeError } = await supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .remove([storagePath]);

      if (removeError) {
        internalErrorResponse(res, requestId, removeError, "avatar/delete");
        return;
      }

      sendJson(res, 200, { success: true });
      return;
    }

    // ========================================================
    // STRIPE — CRÉER UNE SESSION DE CHECKOUT
    // ========================================================

    if (req.method === "POST" && pathname === "/api/stripe/checkout") {
      if (!stripe) {
        sendJson(res, 500, {
          success: false,
          error: "Stripe is not configured",
        });
        return;
      }

      const { user, token, error, code } = await getAuthenticatedUser(req);

      if (!user || !token) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);
      const plan = String(body.plan || "").toLowerCase();
      const period = body.period === "annual" ? "annual" : "monthly";

      const priceId = STRIPE_PRICES[plan]?.[period];

      if (!priceId) {
        sendJson(res, 400, {
          success: false,
          error: `Unknown plan or period (plan="${plan}", period="${period}")`,
        });
        return;
      }

      try {
        const customerId = await getOrCreateStripeCustomer(user);

        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: customerId,
          line_items: [{ price: priceId, quantity: 1 }],
          allow_promotion_codes: true,
          client_reference_id: user.id,
          success_url: `${APP_URL}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${APP_URL}/pricing?checkout=cancel`,
          subscription_data: {
            metadata: {
              supabase_user_id: user.id,
              plan,
              period,
            },
          },
        });

        sendJson(res, 200, {
          success: true,
          id: session.id,
          url: session.url,
        });
      } catch (stripeError) {
        internalErrorResponse(res, requestId, stripeError, "stripe/checkout");
      }

      return;
    }

    // ========================================================
    // STRIPE — PORTAIL CLIENT
    // ========================================================

    if (req.method === "POST" && pathname === "/api/stripe/portal") {
      if (!stripe) {
        sendJson(res, 500, {
          success: false,
          error: "Stripe is not configured",
        });
        return;
      }

      const { user, token, error, code } = await getAuthenticatedUser(req);

      if (!user || !token) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const customerId = user.user_metadata?.stripe_customer_id;

      if (!customerId) {
        sendJson(res, 400, {
          success: false,
          error: "No Stripe customer associated with this account",
        });
        return;
      }

      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: `${APP_URL}/account`,
        });

        sendJson(res, 200, { success: true, url: session.url });
      } catch (stripeError) {
        internalErrorResponse(res, requestId, stripeError, "stripe/portal");
      }

      return;
    }

    // ========================================================
    // STRIPE — ABONNEMENT COURANT
    // ========================================================

    if (req.method === "GET" && pathname === "/api/stripe/subscription") {
      if (!stripe) {
        sendJson(res, 500, {
          success: false,
          error: "Stripe is not configured",
        });
        return;
      }

      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const customerId = user.user_metadata?.stripe_customer_id;

      if (!customerId) {
        sendJson(res, 200, { success: true, subscription: null });
        return;
      }

      try {
        const list = await stripe.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 1,
        });

        const sub = list.data[0];

        sendJson(res, 200, {
          success: true,
          subscription: sub
            ? {
                id: sub.id,
                status: sub.status,
                price_id: sub.items.data[0]?.price?.id || null,
                current_period_end: sub.current_period_end,
                cancel_at_period_end: sub.cancel_at_period_end,
              }
            : null,
        });
      } catch (stripeError) {
        internalErrorResponse(
          res,
          requestId,
          stripeError,
          "stripe/subscription"
        );
      }

      return;
    }

    // ========================================================
    // STRIPE — WEBHOOK
    // ========================================================

    if (req.method === "POST" && pathname === "/api/stripe/webhook") {
      if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        sendJson(res, 500, {
          success: false,
          error: "Stripe webhook not configured",
        });
        return;
      }

      const signature = req.headers["stripe-signature"];

      if (!signature) {
        sendJson(res, 400, {
          success: false,
          error: "Missing stripe-signature",
        });
        return;
      }

      let event;

      try {
        const rawBody = await getRawBody(req);
        event = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (webhookError) {
        console.warn(
          `[${requestId}] Webhook signature verification failed:`,
          webhookError.message
        );
        sendJson(res, 400, {
          success: false,
          error: "Webhook signature verification failed",
        });
        return;
      }

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            const userId =
              session.client_reference_id ||
              (await resolveUserIdFromCustomer(session.customer));

            if (userId && session.subscription) {
              const subscription = await stripe.subscriptions.retrieve(
                session.subscription
              );
              await syncSubscriptionToUser(userId, subscription);
            }
            break;
          }

          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const subscription = event.data.object;
            const userId = await resolveUserIdFromCustomer(
              subscription.customer
            );

            if (userId) {
              await syncSubscriptionToUser(userId, subscription);
            }
            break;
          }

          case "invoice.payment_failed": {
            const invoice = event.data.object;
            const userId = await resolveUserIdFromCustomer(invoice.customer);

            if (userId) {
              const { data } = await supabaseAdmin.auth.admin.getUserById(
                userId
              );

              const currentMetadata = data?.user?.user_metadata || {};

              const metadata = {
                ...currentMetadata,
                subscription: {
                  ...(currentMetadata.subscription || {}),
                  status: "past_due",
                },
              };

              await supabaseAdmin.auth.admin.updateUserById(userId, {
                user_metadata: metadata,
              });
            }
            break;
          }

          default:
            // Événement ignoré
            break;
        }
      } catch (handlerError) {
        // 500 → Stripe retentera l'événement. Les handlers sont
        // idempotents (upserts), un rejeu est sans risque.
        internalErrorResponse(res, requestId, handlerError, "stripe/webhook");
        return;
      }

      sendJson(res, 200, { received: true });
      return;
    }

    // ========================================================
    // TIKTOK — GARDE : configuration
    // ========================================================

    if (pathname.startsWith("/api/tiktok/") && !tiktokEnabled) {
      sendJson(res, 500, {
        success: false,
        error: "TikTok is not configured",
      });
      return;
    }

    // ========================================================
    // TIKTOK — URL D'AUTORISATION
    // ========================================================

    if (req.method === "POST" && pathname === "/api/tiktok/auth/url") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const params = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        scope: TIKTOK_SCOPES,
        response_type: "code",
        redirect_uri: TIKTOK_REDIRECT_URI,
        state: createOAuthState("tiktok", user.id),
      });

      sendJson(res, 200, {
        success: true,
        url: `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`,
      });

      return;
    }

    // ========================================================
    // TIKTOK — CALLBACK
    // ========================================================

    if (req.method === "POST" && pathname === "/api/tiktok/auth/callback") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);
      const authCode = String(body.code || "");

      if (!authCode || !verifyOAuthState("tiktok", body.state, user.id)) {
        sendJson(res, 400, {
          success: false,
          error: "Invalid or expired state",
        });
        return;
      }

      try {
        const tokens = await tiktokApi("/v2/oauth/token/", {
          form: {
            client_key: TIKTOK_CLIENT_KEY,
            client_secret: TIKTOK_CLIENT_SECRET,
            code: authCode,
            grant_type: "authorization_code",
            redirect_uri: TIKTOK_REDIRECT_URI,
          },
        });

        let profile = {};

        try {
          const info = await tiktokApi(
            "/v2/user/info/?fields=open_id,avatar_url,display_name",
            { method: "GET", token: tokens.access_token }
          );

          profile = info.data?.user || {};
        } catch (profileError) {
          console.warn("TikTok user info error:", profileError.message);
        }

        await saveTikTokTokens(user.id, tokens, {
          display_name: profile.display_name || null,
          avatar_url: profile.avatar_url || null,
        });

        sendJson(res, 200, {
          success: true,
          account: {
            display_name: profile.display_name || null,
            avatar_url: profile.avatar_url || null,
          },
        });
      } catch (tiktokError) {
        sendJson(res, 400, { success: false, error: tiktokError.message });
      }

      return;
    }

    // ========================================================
    // TIKTOK — STATUT
    // ========================================================

    if (req.method === "GET" && pathname === "/api/tiktok/status") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const account = await getTikTokAccount(user.id);

      sendJson(res, 200, {
        success: true,
        connected: Boolean(account),
        account: account
          ? {
              display_name: account.display_name,
              avatar_url: account.avatar_url,
              scope: account.scope,
            }
          : null,
      });

      return;
    }

    // ========================================================
    // TIKTOK — DÉCONNEXION
    // ========================================================

    if (req.method === "DELETE" && pathname === "/api/tiktok/disconnect") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const account = await getTikTokAccount(user.id);

      if (account) {
        try {
          await tiktokApi("/v2/oauth/revoke/", {
            form: {
              client_key: TIKTOK_CLIENT_KEY,
              client_secret: TIKTOK_CLIENT_SECRET,
              token: account.access_token,
            },
          });
        } catch (revokeError) {
          console.warn("TikTok revoke error:", revokeError.message);
        }

        await supabaseAdmin
          .from("tiktok_accounts")
          .delete()
          .eq("user_id", user.id);
      }

      sendJson(res, 200, { success: true });
      return;
    }

    // ========================================================
    // TIKTOK — INFOS CRÉATEUR
    // ========================================================

    if (req.method === "GET" && pathname === "/api/tiktok/creator-info") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      try {
        const accessToken = await getValidTikTokToken(user.id);

        const result = await tiktokApi(
          "/v2/post/publish/creator_info/query/",
          { token: accessToken }
        );

        sendJson(res, 200, { success: true, creator: result.data });
      } catch (tiktokError) {
        sendTikTokError(res, tiktokError);
      }

      return;
    }

    // ========================================================
    // TIKTOK — PUBLIER UNE VIDÉO (upload de fichier)
    // ========================================================
    //
    // ⚠️ FIX OOM : l'upload passe par un sémaphore
    // (MAX_VIDEO_UPLOADS, défaut 2) : au plus 2 vidéos de 100 Mo
    // bufferisées en RAM simultanément ; les autres requêtes
    // attendent en file bornée ou reçoivent 503.

    if (req.method === "POST" && pathname === "/api/tiktok/publish") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      let upload;

      try {
        upload = await parseVideoUpload(req);
      } catch (uploadError) {
        const message =
          uploadError.message === "FILE_TOO_LARGE"
            ? `Video is too large. Maximum size is ${MAX_VIDEO_SIZE / 1024 / 1024} MB.`
            : uploadError.message === "NO_FILE"
            ? "No 'video' file was provided."
            : "Could not read the uploaded file.";

        sendJson(res, 400, { success: false, error: message });
        return;
      }

      if (!ALLOWED_VIDEO_TYPES.includes(upload.mimeType)) {
        sendJson(res, 400, {
          success: false,
          error: "Unsupported format. Use MP4, MOV or WebM.",
        });
        return;
      }

      const mode = upload.fields.mode === "draft" ? "draft" : "direct";

      // Acquiert un slot de concurrence AVANT de consommer de la
      // mémoire ; libéré quoi qu'il arrive (finally).
      let slotAcquired = false;

      try {
        try {
          await acquireVideoSlot();
          slotAcquired = true;
        } catch (slotError) {
          sendJson(res, 503, {
            success: false,
            error: "Server is busy processing uploads. Try again shortly.",
          });
          return;
        }

        const accessToken = await getValidTikTokToken(user.id);
        const chunking = computeChunking(upload.buffer.length);

        const sourceInfo = {
          source: "FILE_UPLOAD",
          video_size: upload.buffer.length,
          chunk_size: chunking.chunkSize,
          total_chunk_count: chunking.totalChunks,
        };

        const init =
          mode === "draft"
            ? await tiktokApi("/v2/post/publish/inbox/video/init/", {
                token: accessToken,
                json: { source_info: sourceInfo },
              })
            : await tiktokApi("/v2/post/publish/video/init/", {
                token: accessToken,
                json: {
                  post_info: buildPostInfo(upload.fields),
                  source_info: sourceInfo,
                },
              });

        await uploadVideoToTikTok(
          init.data.upload_url,
          upload.buffer,
          upload.mimeType,
          chunking
        );

        sendJson(res, 200, {
          success: true,
          mode,
          publish_id: init.data.publish_id,
        });
      } catch (tiktokError) {
        sendTikTokError(res, tiktokError);
      } finally {
        if (slotAcquired) releaseVideoSlot();
        // Libère la référence au buffer pour le GC.
        upload = null;
      }

      return;
    }

    // ========================================================
    // TIKTOK — PUBLIER UNE VIDÉO DEPUIS UNE URL
    // ========================================================

    if (req.method === "POST" && pathname === "/api/tiktok/publish/url") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);
      const videoUrl = String(body.videoUrl || "").trim();

      if (!/^https:\/\//i.test(videoUrl)) {
        sendJson(res, 400, {
          success: false,
          error: "videoUrl must be a valid https URL",
        });
        return;
      }

      const mode = body.mode === "draft" ? "draft" : "direct";

      try {
        const accessToken = await getValidTikTokToken(user.id);

        const sourceInfo = { source: "PULL_FROM_URL", video_url: videoUrl };

        const init =
          mode === "draft"
            ? await tiktokApi("/v2/post/publish/inbox/video/init/", {
                token: accessToken,
                json: { source_info: sourceInfo },
              })
            : await tiktokApi("/v2/post/publish/video/init/", {
                token: accessToken,
                json: {
                  post_info: buildPostInfo(body),
                  source_info: sourceInfo,
                },
              });

        sendJson(res, 200, {
          success: true,
          mode,
          publish_id: init.data.publish_id,
        });
      } catch (tiktokError) {
        sendTikTokError(res, tiktokError);
      }

      return;
    }

    // ========================================================
    // TIKTOK — STATUT D'UNE PUBLICATION
    // ========================================================

    if (req.method === "GET" && pathname === "/api/tiktok/publish/status") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const publishId = url.searchParams.get("publish_id");

      if (!publishId) {
        sendJson(res, 400, { success: false, error: "Missing publish_id" });
        return;
      }

      try {
        const accessToken = await getValidTikTokToken(user.id);

        const result = await tiktokApi("/v2/post/publish/status/fetch/", {
          token: accessToken,
          json: { publish_id: publishId },
        });

        sendJson(res, 200, { success: true, ...result.data });
      } catch (tiktokError) {
        sendTikTokError(res, tiktokError);
      }

      return;
    }

    // ========================================================
    // PINTEREST — GARDE : configuration
    // ========================================================

    if (pathname.startsWith("/api/pinterest/") && !pinterestEnabled) {
      sendJson(res, 500, {
        success: false,
        error: "Pinterest is not configured",
      });
      return;
    }

    // ========================================================
    // PINTEREST — URL D'AUTORISATION
    // ========================================================

    if (req.method === "POST" && pathname === "/api/pinterest/auth/url") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const params = new URLSearchParams({
        client_id: PINTEREST_APP_ID,
        redirect_uri: PINTEREST_REDIRECT_URI,
        response_type: "code",
        scope: PINTEREST_SCOPES,
        state: createOAuthState("pinterest", user.id),
      });

      sendJson(res, 200, {
        success: true,
        url: `${PINTEREST_AUTH_URL}?${params.toString()}`,
      });

      return;
    }

    // ========================================================
    // PINTEREST — CALLBACK
    // ========================================================

    if (
      req.method === "POST" &&
      pathname === "/api/pinterest/auth/callback"
    ) {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);
      const authCode = String(body.code || "");

      if (!authCode || !verifyOAuthState("pinterest", body.state, user.id)) {
        sendJson(res, 400, {
          success: false,
          error: "Invalid or expired state",
        });
        return;
      }

      try {
        const tokens = await pinterestApi("/oauth/token", {
          method: "POST",
          base: PINTEREST_OAUTH_BASE,
          basic: true,
          form: {
            grant_type: "authorization_code",
            code: authCode,
            redirect_uri: PINTEREST_REDIRECT_URI,
          },
        });

        let profile = {};

        try {
          profile = await pinterestApi("/user_account", {
            token: tokens.access_token,
          });
        } catch (profileError) {
          console.warn("Pinterest user_account error:", profileError.message);
        }

        await savePinterestTokens(user.id, tokens, {
          username: profile.username || null,
          avatar_url: profile.profile_image || null,
          account_type: profile.account_type || null,
        });

        sendJson(res, 200, {
          success: true,
          connected: true,
          account: {
            display_name: profile.username || null,
            avatar_url: profile.profile_image || null,
            account_type: profile.account_type || null,
          },
        });
      } catch (pinterestError) {
        sendJson(res, 400, { success: false, error: pinterestError.message });
      }

      return;
    }

    // ========================================================
    // PINTEREST — CONNEXION PAR TOKEN MANUEL (DEV / SANDBOX)
    // ========================================================

    if (req.method === "POST" && pathname === "/api/pinterest/auth/token") {
      if (env("PINTEREST_ALLOW_MANUAL_TOKEN") !== "1") {
        sendJson(res, 403, {
          success: false,
          error: "Manual token connection is disabled",
        });
        return;
      }

      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);
      const accessToken = String(body.access_token || "").trim();

      if (!accessToken) {
        sendJson(res, 400, { success: false, error: "Missing access_token" });
        return;
      }

      let profile;

      try {
        profile = await pinterestApi("/user_account", { token: accessToken });
      } catch (profileError) {
        sendJson(res, 400, {
          success: false,
          error: `Invalid Pinterest token: ${profileError.message}`,
        });
        return;
      }

      try {
        await savePinterestTokens(
          user.id,
          {
            access_token: accessToken,
            refresh_token: null,
            expires_in: 29 * 24 * 60 * 60,
            refresh_token_expires_in: 29 * 24 * 60 * 60,
          },
          {
            username: profile.username || null,
            avatar_url: profile.profile_image || null,
            account_type: profile.account_type || null,
          }
        );
      } catch (saveError) {
        internalErrorResponse(res, requestId, saveError, "pinterest/token");
        return;
      }

      sendJson(res, 200, {
        success: true,
        connected: true,
        account: {
          display_name: profile.username || null,
          avatar_url: profile.profile_image || null,
          account_type: profile.account_type || null,
        },
      });

      return;
    }

    // ========================================================
    // PINTEREST — STATUT
    // ========================================================

    if (req.method === "GET" && pathname === "/api/pinterest/status") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const account = await getPinterestAccount(user.id);

      sendJson(res, 200, {
        success: true,
        connected: Boolean(account),
        account: account
          ? {
              display_name: account.username,
              avatar_url: account.avatar_url,
              account_type: account.account_type,
              scope: account.scope,
            }
          : null,
      });

      return;
    }

    // ========================================================
    // PINTEREST — DÉCONNEXION
    // ========================================================

    if (
      req.method === "DELETE" &&
      pathname === "/api/pinterest/disconnect"
    ) {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const { error: deleteError } = await supabaseAdmin
        .from("pinterest_accounts")
        .delete()
        .eq("user_id", user.id);

      if (deleteError) {
        internalErrorResponse(res, requestId, deleteError, "pinterest/disconnect");
        return;
      }

      sendJson(res, 200, { success: true });
      return;
    }

    // ========================================================
    // YOUTUBE — GARDE : configuration
    // ========================================================

    if (pathname.startsWith("/api/youtube/") && !youtubeEnabled) {
      sendJson(res, 500, {
        success: false,
        error: "YouTube is not configured",
      });
      return;
    }

    // ========================================================
    // YOUTUBE — URL D'AUTORISATION
    // ========================================================

    if (req.method === "POST" && pathname === "/api/youtube/auth/url") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const params = new URLSearchParams({
        client_id: YOUTUBE_CLIENT_ID,
        redirect_uri: YOUTUBE_REDIRECT_URI,
        response_type: "code",
        scope: YOUTUBE_SCOPES,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: createOAuthState("youtube", user.id),
      });

      sendJson(res, 200, {
        success: true,
        url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
      });

      return;
    }

    // ========================================================
    // YOUTUBE — CALLBACK
    // ========================================================
    //
    // ⚠️ FIX : si le lookup de chaîne ÉCHOUE (erreur API, pas
    // "pas de chaîne"), on REFUSE la connexion au lieu de
    // sauvegarder silencieusement un compte sans chaîne.

    if (req.method === "POST" && pathname === "/api/youtube/auth/callback") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);
      const authCode = String(body.code || "");

      if (!authCode || !verifyOAuthState("youtube", body.state, user.id)) {
        sendJson(res, 400, {
          success: false,
          error: "Invalid or expired state",
        });
        return;
      }

      try {
        const tokens = await googleRequest(GOOGLE_TOKEN_URL, {
          method: "POST",
          form: {
            client_id: YOUTUBE_CLIENT_ID,
            client_secret: YOUTUBE_CLIENT_SECRET,
            code: authCode,
            grant_type: "authorization_code",
            redirect_uri: YOUTUBE_REDIRECT_URI,
          },
        });

        let channel = null;

        // Le lookup de chaîne est BLOQUANT : sans chaîne (ou en cas
        // d'erreur de lookup), la connexion est refusée proprement.
        try {
          channel = await fetchYouTubeChannel(tokens.access_token);
        } catch (channelError) {
          console.warn("YouTube channels error:", channelError.message);
        }

        if (!channel) {
          try {
            await googleRequest(GOOGLE_REVOKE_URL, {
              method: "POST",
              form: { token: tokens.refresh_token || tokens.access_token },
            });
          } catch {
            // ignore
          }

          sendJson(res, 400, {
            success: false,
            error:
              "No YouTube channel found on this Google account. Create a channel on youtube.com, then try again.",
          });
          return;
        }

        await saveYouTubeTokens(
          user.id,
          {
            ...tokens,
            refresh_token_expires_in: tokens.refresh_token_expires_in ?? null,
          },
          {
            channel_id: channel.id,
            channel_title: channel.title || null,
            custom_url: channel.customUrl || null,
            avatar_url: channel.avatarUrl || null,
          }
        );

        sendJson(res, 200, {
          success: true,
          connected: true,
          account: {
            display_name: channel.title || null,
            avatar_url: channel.avatarUrl || null,
          },
        });
      } catch (youtubeError) {
        sendJson(res, 400, { success: false, error: youtubeError.message });
      }

      return;
    }

    // ========================================================
    // YOUTUBE — STATUT
    // ========================================================

    if (req.method === "GET" && pathname === "/api/youtube/status") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const account = await getYouTubeAccount(user.id);

      sendJson(res, 200, {
        success: true,
        connected: Boolean(account),
        account: account
          ? {
              display_name: account.channel_title,
              avatar_url: account.avatar_url,
              custom_url: account.custom_url,
              scope: account.scope,
            }
          : null,
      });

      return;
    }

    // ========================================================
    // YOUTUBE — DÉCONNEXION
    // ========================================================

    if (req.method === "DELETE" && pathname === "/api/youtube/disconnect") {
      const { user, error, code } = await getAuthenticatedUser(req);

      if (!user) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const account = await getYouTubeAccount(user.id);

      if (account) {
        try {
          await googleRequest(GOOGLE_REVOKE_URL, {
            method: "POST",
            form: { token: account.refresh_token || account.access_token },
          });
        } catch (revokeError) {
          console.warn("YouTube revoke error:", revokeError.message);
        }

        const { error: deleteError } = await supabaseAdmin
          .from("youtube_accounts")
          .delete()
          .eq("user_id", user.id);

        if (deleteError) {
          internalErrorResponse(res, requestId, deleteError, "youtube/disconnect");
          return;
        }
      }

      sendJson(res, 200, { success: true });
      return;
    }

    // ========================================================
    // 404
    // ========================================================

    sendJson(res, 404, {
      success: false,
      error: "Route not found",
      path: pathname,
      method: req.method,
    });
  } catch (error) {
    // ⚠️ FIX : plus de message d'erreur interne au client en
    // production — seulement un message générique + requestId
    // corrélable aux logs serveur.
    internalErrorResponse(res, requestId, error, "unhandled");
  }
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, () => {
  console.log(`Stone server running on port ${PORT}`);
  console.log(`  NODE_ENV        : ${env("NODE_ENV") || "(non défini)"}`);
  console.log(`  TRUST_PROXY     : ${TRUST_PROXY ? "1" : "0"}`);
  console.log(`  Rate limits     : strict 10/15min · oauth 30/10min · api 120/min`);
  console.log(`  Video uploads   : max ${MAX_VIDEO_UPLOADS} concurrent(s)`);
});

// ============================================================
// SERVER ERRORS
// ============================================================

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Le port ${PORT} est déjà utilisé.`);
  } else {
    console.error("Server error:", error);
  }
});

// ============================================================
// ARRÊT PROPRE
// ============================================================

function shutdown(signal) {
  console.log(`\n${signal} reçu — arrêt du serveur...`);

  server.close(() => {
    console.log("Serveur arrêté proprement.");
    process.exit(0);
  });

  // Force l'arrêt si des connexions persistent.
  setTimeout(() => {
    console.error("Arrêt forcé : connexions encore ouvertes.");
    process.exit(1);
  }, 10_000).unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException");
});