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
//
// - gère les fins de ligne CRLF (\r\n)
// - retire les guillemets autour des valeurs
// - n'écrase JAMAIS une variable déjà définie dans l'environnement
//   (les variables de l'hébergeur ont la priorité)
// - est toujours appelé : un .env absent n'est pas une erreur

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

      // Retire les guillemets simples ou doubles autour de la valeur
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

// ============================================================
// CONFIGURATION
// ============================================================
//
// Backend public (Railway) : https://stoneserv-production.up.railway.app
// Frontend (Vercel)        : https://stone-prod.vercel.app
//
// Le backend n'a pas besoin de connaître sa propre URL publique :
// Railway fournit le host dans chaque requête.
// Le port est TOUJOURS fourni par Railway via process.env.PORT.

const PORT = Number(env("PORT") || 3002);

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

// URL du FRONTEND vers laquelle l'utilisateur est renvoyé après
// Google / GitHub OAuth. Le fallback localhost sert uniquement au
// développement local.
const DEFAULT_OAUTH_REDIRECT =
  env("OAUTH_REDIRECT_URL") || "http://localhost:5173/";

const AVATAR_BUCKET = "avatars";
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

// ============================================================
// CONFIGURATION STRIPE
// ============================================================

const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET");

// URL du FRONTEND de production (ex. https://stone-prod.vercel.app).
// Utilisée pour success_url, cancel_url et return_url Stripe, ainsi que
// pour les redirect_uri TikTok et Pinterest par défaut.
// Ce n'est JAMAIS l'URL Railway du backend.
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
//
// TIKTOK_REDIRECT_URI doit être IDENTIQUE à l'URI déclarée dans
// le portail TikTok for Developers. Elle pointe vers un VRAI chemin
// du FRONTEND, sans "#" :
//   https://stone-prod.vercel.app/tiktok/callback
//
// Le frontend (App.tsx) intercepte ce chemin au chargement et bascule
// sur la route hash /#/tiktok-callback.

const TIKTOK_CLIENT_KEY = env("TIKTOK_CLIENT_KEY");
const TIKTOK_CLIENT_SECRET = env("TIKTOK_CLIENT_SECRET");
const TIKTOK_REDIRECT_URI =
  env("TIKTOK_REDIRECT_URI") || `${APP_URL}/tiktok/callback`;

const TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload";
const TIKTOK_API = "https://open.tiktokapis.com";
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 Mo (le buffer est gardé en mémoire)
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

const tiktokEnabled = Boolean(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET);

// ============================================================
// CONFIGURATION PINTEREST
// ============================================================
//
// PINTEREST_REDIRECT_URI doit être IDENTIQUE à l'URI déclarée dans
// le dashboard développeur Pinterest. Comme pour TikTok, elle pointe
// vers un VRAI chemin du FRONTEND, sans "#" :
//   https://stone-prod.vercel.app/pinterest/callback
//
// Le frontend (App.tsx) intercepte ce chemin au chargement et bascule
// sur la route hash /#/pinterest-callback.
//
// Deux base URLs :
//   - PINTEREST_OAUTH_BASE : échange / rafraîchissement des tokens
//                            (toujours api.pinterest.com)
//   - PINTEREST_API_BASE   : appels API (user_account, boards, pins...)
//                            sandbox par défaut (accès Trial).
//                            En production : https://api.pinterest.com/v5

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
// SECRET DE SIGNATURE DU STATE OAUTH (TikTok + Pinterest)
// ============================================================
//
// OAUTH_STATE_SECRET est optionnel : à défaut, on utilise le secret
// TikTok, puis le secret Pinterest.

const OAUTH_STATE_SECRET =
  env("OAUTH_STATE_SECRET") || TIKTOK_CLIENT_SECRET || PINTEREST_APP_SECRET;

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

// Valide que SUPABASE_URL est une vraie URL http(s)
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

// Un redirect_uri TikTok contenant un "#" est invalide (TikTok refuse
// les fragments) : on prévient clairement au démarrage.
if (TIKTOK_REDIRECT_URI.includes("#")) {
  console.warn(
    `⚠️  TIKTOK_REDIRECT_URI contient un "#" (${TIKTOK_REDIRECT_URI}) — c'est invalide. Utilise https://<frontend>/tiktok/callback.`
  );
}

// Idem pour Pinterest : les fragments sont interdits dans une redirect URI OAuth.
if (PINTEREST_REDIRECT_URI.includes("#")) {
  console.warn(
    `⚠️  PINTEREST_REDIRECT_URI contient un "#" (${PINTEREST_REDIRECT_URI}) — c'est invalide. Utilise https://<frontend>/pinterest/callback.`
  );
}

if (pinterestEnabled && PINTEREST_API_BASE.includes("sandbox")) {
  console.warn(
    "ℹ️  Pinterest en mode SANDBOX (PINTEREST_API_BASE = " +
      PINTEREST_API_BASE +
      ")."
  );
}

// Avertissements utiles en production (Railway) : sans ces variables,
// les redirections Stripe et OAuth pointeraient vers localhost.
if (!env("APP_URL")) {
  console.warn(
    "⚠️  APP_URL manquant — fallback http://localhost:5173 (à définir en production avec l'URL du frontend)."
  );
}

if (!env("OAUTH_REDIRECT_URL")) {
  console.warn(
    "⚠️  OAUTH_REDIRECT_URL manquant — fallback http://localhost:5173/ (à définir en production avec l'URL du frontend)."
  );
}

// ============================================================
// CLIENT SUPABASE
// ============================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// CLIENT SUPABASE ADMIN (Service Role)
// ============================================================

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
// CLIENT SUPABASE OAUTH (flow implicite)
// ============================================================

const supabaseOAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: "implicit",
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// ============================================================
// CORS (système unique)
// ============================================================
//
// CORS concerne les origines des FRONTENDS qui appellent l'API.
// L'URL Railway du backend n'est donc PAS ajoutée ici.
//
// Origines autorisées :
//   1. les origines codées en dur ci-dessous (dev local + frontend Vercel)
//   2. APP_URL (URL du frontend de production)
//   3. ALLOWED_ORIGINS (liste séparée par des virgules,
//      ex. "https://app.stone.com,https://stone.com")
//   4. les URLs de déploiement Vercel du projet (motif strict ci-dessous)
//
// Comme les credentials sont activés, on ne renvoie JAMAIS "*" :
// on renvoie l'origine exacte du navigateur, uniquement si elle est
// autorisée.

function normalizeOrigin(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

// Origines fixes : développement local + frontend Vercel.
// "https://stone-prod.vercel.app" est le domaine de production : c'est
// là que TikTok / Pinterest renvoient l'utilisateur, il DOIT être autorisé.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://stone-prod.vercel.app",
  "https://stone-prod-2fpb2146e-xsdevs-projects.vercel.app",
];

// Les URLs de déploiement Vercel changent à chaque build
// (stone-prod-<hash>-xsdevs-projects.vercel.app). Ce motif strict
// n'accepte que les URLs du scope "xsdevs-projects" pour le projet
// "stone-prod", en HTTPS uniquement.
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

// Origines refusées déjà signalées (évite de spammer les logs Railway).
const warnedRejectedOrigins = new Set();

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  // Le résultat dépend de l'en-tête Origin : les caches doivent le savoir,
  // que l'origine soit autorisée ou non.
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

  // Si le navigateur annonce les headers de sa requête (preflight),
  // on les accepte ; sinon valeur par défaut.
  const requestedHeaders = req.headers["access-control-request-headers"];

  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requestedHeaders === "string" && requestedHeaders
      ? requestedHeaders
      : "Content-Type, Authorization"
  );

  // Le navigateur peut mettre le preflight en cache 24 h.
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ============================================================
// JSON BODY
// ============================================================

async function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 10 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
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
// RAW BODY (nécessaire pour vérifier la signature Stripe)
// ============================================================

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
      mimeType =
        info?.mimeType || info?.mimetype || "application/octet-stream";

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
    // On retire aussi un éventuel query string (?t=...)
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

// Vérifie que le fichier appartient bien à l'utilisateur
// (chemin de la forme "<user.id>/<fichier>") et n'essaie pas
// de remonter dans l'arborescence.
function isOwnedAvatarPath(storagePath, userId) {
  if (typeof storagePath !== "string") return false;
  if (storagePath.includes("..")) return false;
  if (storagePath.startsWith("/")) return false;

  return storagePath.startsWith(`${userId}/`);
}

// ============================================================
// RESPONSE
// ============================================================
//
// Les headers CORS sont posés avec res.setHeader() au tout début de
// chaque requête : res.writeHead() les conserve, donc toutes les
// réponses (succès, 4xx, 5xx, 404) portent les headers CORS.

function sendJson(res, statusCode, data) {
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
//
// AVATAR : Supabase écrase `user_metadata.avatar_url` à CHAQUE
// connexion Google (il mappe le champ `picture` de Google vers
// `avatar_url`). Idem pour GitHub (`avatar_url`). On stocke donc
// la photo choisie par l'utilisateur dans une clé protégée
// `custom_avatar_url` qui n'est jamais touchée par l'OAuth, et on
// la lit en priorité.
//
// Priorité :  custom_avatar_url  >  avatar_url  >  picture
//
// Si `custom_avatar_url` est une string (même vide), on l'utilise
// telle quelle, ce qui permet aussi de "supprimer" l'avatar sans
// que la photo du provider ne réapparaisse.

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
// STATE OAUTH SIGNÉ (TikTok + Pinterest, stateless, anti-CSRF)
// ============================================================
//
// Le state contient le provider, l'id utilisateur, une expiration
// (10 min) et un aléa, le tout signé en HMAC. Le provider est inclus
// dans la signature : un state TikTok ne peut pas être rejoué sur
// Pinterest, et inversement.

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

  // Format des endpoints /v2/oauth/* : { error: "invalid_grant", error_description }
  if (typeof data.error === "string") {
    throw new Error(data.error_description || data.error);
  }

  // Format des autres endpoints : { error: { code: "ok" | "...", message } }
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
//
// Les tokens sont stockés dans la table `tiktok_accounts`
// (RLS activé, aucune policy : seul le service role y accède).

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

// Retourne un access_token valide (le rafraîchit si nécessaire).
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

// Règles TikTok : chunk entre 5 et 64 Mo, le dernier chunk peut
// absorber le reste. Sous 64 Mo, un seul chunk suffit.
function computeChunking(size) {
  const MB = 1024 * 1024;

  if (size <= 64 * MB) {
    return { chunkSize: size, totalChunks: 1 };
  }

  const chunkSize = 10 * MB;
  return { chunkSize, totalChunks: Math.floor(size / chunkSize) };
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
//
// - `base`  : PINTEREST_API_BASE (sandbox par défaut) ou
//             PINTEREST_OAUTH_BASE pour les endpoints /oauth/token
// - `basic` : true pour l'authentification Basic app_id:app_secret
//             (requise par /oauth/token)
//
// Pinterest renvoie les erreurs sous la forme { code, message }
// avec un statut HTTP non 2xx ; les erreurs OAuth peuvent aussi
// utiliser { error, error_description }.

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
//
// Les tokens sont stockés dans la table `pinterest_accounts`
// (RLS activé, aucune policy : seul le service role y accède).

async function savePinterestTokens(userId, t, extra = {}) {
  const now = Date.now();

  // access_token : ~30 jours. refresh_token : ~1 an.
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

// Retourne un access_token valide (le rafraîchit si nécessaire).
// Pas encore utilisé par une route : prêt pour la publication de pins.
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

  // Si Pinterest ne renvoie pas de nouveau refresh_token, on garde l'ancien.
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
// SERVER
// ============================================================

const server = createServer(async (req, res) => {
  // ----------------------------------------------------------
  // CORS — TOUJOURS EN PREMIER
  // ----------------------------------------------------------
  //
  // Exécuté avant toute lecture de body, toute authentification et
  // toute route : aucune exception de la logique métier ne peut
  // survenir avant que les headers CORS soient posés.

  try {
    setCorsHeaders(req, res);
  } catch (corsError) {
    console.error("CORS error:", corsError);
  }

  // ----------------------------------------------------------
  // PREFLIGHT (OPTIONS) — répondu immédiatement
  // ----------------------------------------------------------
  //
  // Un OPTIONS n'atteint jamais les routes, l'authentification
  // ni le 404.

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Length": "0" });
    res.end();
    return;
  }

  try {
    // ----------------------------------------------------------
    // URL
    // ----------------------------------------------------------
    //
    // Le host de la requête est fourni correctement par Railway
    // (ex. stoneserv-production.up.railway.app). Il ne sert ici
    // qu'à parser le chemin et les paramètres.

    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || `localhost:${PORT}`}`
    );

    // ==========================================================
    // HEALTH
    // ==========================================================

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        success: true,
        server: "Stone",
        supabase: true,
        stripe: Boolean(stripe),
        tiktok: tiktokEnabled,
        pinterest: pinterestEnabled,
      });

      return;
    }

    // ==========================================================
    // AUTH — SIGN UP
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
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

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name: firstName,
            last_name: lastName,
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

    // ==========================================================
    // AUTH — LOGIN
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
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

    // ==========================================================
    // AUTH — CHECK EMAIL VERIFICATION (polling sans 401)
    // ==========================================================

    if (
      req.method === "POST" &&
      url.pathname === "/api/auth/check-verification"
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
      });

      return;
    }

    // ==========================================================
    // AUTH — GOOGLE : URL D'AUTORISATION
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/auth/google/url") {
      let body = {};

      try {
        body = await getJsonBody(req);
      } catch {
        body = {};
      }

      const redirectTo =
        typeof body.redirectTo === "string" && body.redirectTo
          ? body.redirectTo
          : DEFAULT_OAUTH_REDIRECT;

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
        sendJson(res, 500, {
          success: false,
          error:
            oauthError?.message || "Could not generate Google OAuth URL",
        });

        return;
      }

      sendJson(res, 200, {
        success: true,
        url: data.url,
      });

      return;
    }

    // ==========================================================
    // AUTH — GITHUB : URL D'AUTORISATION
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/auth/github/url") {
      let body = {};

      try {
        body = await getJsonBody(req);
      } catch {
        body = {};
      }

      const redirectTo =
        typeof body.redirectTo === "string" && body.redirectTo
          ? body.redirectTo
          : DEFAULT_OAUTH_REDIRECT;

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
        sendJson(res, 500, {
          success: false,
          error:
            oauthError?.message || "Could not generate GitHub OAuth URL",
        });

        return;
      }

      sendJson(res, 200, {
        success: true,
        url: data.url,
      });

      return;
    }

    // ==========================================================
    // AUTH — LOGOUT
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      sendJson(res, 200, { success: true });
      return;
    }

    // ==========================================================
    // AUTH — REFRESH TOKEN
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/auth/refresh") {
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

    // ==========================================================
    // AUTH — RESEND VERIFICATION EMAIL
    // ==========================================================

    if (
      req.method === "POST" &&
      url.pathname === "/api/auth/resend-verification"
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
        sendJson(res, 500, {
          success: false,
          error: resendError.message,
        });
        return;
      }

      sendJson(res, 200, {
        success: true,
        message: "Verification email sent",
      });

      return;
    }

    // ==========================================================
    // CURRENT USER
    // ==========================================================

    if (req.method === "GET" && url.pathname === "/api/user") {
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

    // ==========================================================
    // USER PROFILE — GET
    // ==========================================================

    if (req.method === "GET" && url.pathname === "/api/user/profile") {
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

    // ==========================================================
    // USER PROFILE — UPDATE
    // ==========================================================
    //
    // IMPORTANT : on écrit l'avatar dans `custom_avatar_url` (clé
    // custom, jamais touchée par l'OAuth) au lieu de `avatar_url`
    // (que Supabase écrase à chaque login Google/GitHub).

    if (
      (req.method === "PUT" || req.method === "PATCH") &&
      url.pathname === "/api/user/profile"
    ) {
      const { user, token, error, code } = await getAuthenticatedUser(req);

      if (!user || !token) {
        sendJson(res, 401, { success: false, error, code });
        return;
      }

      const body = await getJsonBody(req);

      const metadata = { ...(user.user_metadata || {}) };

      if (
        body.firstName !== undefined ||
        body.first_name !== undefined
      ) {
        metadata.first_name = String(
          body.firstName ?? body.first_name ?? ""
        );
      }

      if (body.lastName !== undefined || body.last_name !== undefined) {
        metadata.last_name = String(body.lastName ?? body.last_name ?? "");
      }

      if (body.bio !== undefined) {
        metadata.bio = String(body.bio);
      }

      // ⚠️ Écrit dans custom_avatar_url, PAS dans avatar_url.
      if (body.avatarUrl !== undefined || body.avatar_url !== undefined) {
        metadata.custom_avatar_url = String(
          body.avatarUrl ?? body.avatar_url ?? ""
        );
      }

      const { data, error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          user_metadata: metadata,
        });

      if (updateError) {
        sendJson(res, 500, {
          success: false,
          error: updateError.message,
        });
        return;
      }

      sendJson(res, 200, {
        success: true,
        user: formatUser(data.user),
      });

      return;
    }

    // ==========================================================
    // USER PASSWORD — UPDATE
    // ==========================================================

    if (
      (req.method === "PUT" || req.method === "POST") &&
      url.pathname === "/api/user/password"
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
        sendJson(res, 500, {
          success: false,
          error: updateError.message,
        });
        return;
      }

      sendJson(res, 200, {
        success: true,
        message: "Password updated successfully",
      });

      return;
    }

    // ==========================================================
    // USER AVATAR — UPLOAD
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/user/avatar") {
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

      if (!upload.mimeType.startsWith("image/")) {
        sendJson(res, 400, {
          success: false,
          error: "The uploaded file must be an image.",
        });
        return;
      }

      const extension =
        (upload.fileName.split(".").pop() || "png")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "png";

      const storagePath = `${user.id}/${crypto.randomUUID()}.${extension}`;

      const { error: uploadStorageError } = await supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .upload(storagePath, upload.buffer, {
          contentType: upload.mimeType,
          upsert: true,
        });

      if (uploadStorageError) {
        sendJson(res, 500, {
          success: false,
          error: uploadStorageError.message,
        });
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

    // ==========================================================
    // USER AVATAR — DELETE
    // ==========================================================
    //
    // SÉCURITÉ : on ne supprime que les fichiers situés dans le
    // dossier de l'utilisateur authentifié (`<user.id>/...`).

    if (req.method === "DELETE" && url.pathname === "/api/user/avatar") {
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

      // URL externe (avatar Google/GitHub) : rien à supprimer
      // dans notre bucket.
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
        sendJson(res, 500, {
          success: false,
          error: removeError.message,
        });
        return;
      }

      sendJson(res, 200, { success: true });
      return;
    }

    // ==========================================================
    // STRIPE — CRÉER UNE SESSION DE CHECKOUT
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/stripe/checkout") {
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
        sendJson(res, 500, {
          success: false,
          error: stripeError?.message || "Could not create checkout session",
        });
      }

      return;
    }

    // ==========================================================
    // STRIPE — PORTAIL CLIENT (gérer / annuler l'abonnement)
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/stripe/portal") {
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
        sendJson(res, 500, {
          success: false,
          error: stripeError?.message || "Could not open billing portal",
        });
      }

      return;
    }

    // ==========================================================
    // STRIPE — ABONNEMENT COURANT
    // ==========================================================

    if (
      req.method === "GET" &&
      url.pathname === "/api/stripe/subscription"
    ) {
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
        sendJson(res, 500, {
          success: false,
          error: stripeError?.message || "Could not fetch subscription",
        });
      }

      return;
    }

    // ==========================================================
    // STRIPE — WEBHOOK
    // ==========================================================
    //
    // URL à configurer dans le dashboard Stripe :
    // https://stoneserv-production.up.railway.app/api/stripe/webhook
    //
    // Les webhooks viennent des serveurs Stripe (pas d'en-tête Origin) :
    // ils ne sont pas concernés par CORS, seule la signature compte.

    if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
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
        sendJson(res, 400, {
          success: false,
          error: `Webhook signature verification failed: ${webhookError.message}`,
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
        console.error("Stripe webhook handler error:", handlerError);
        sendJson(res, 500, { success: false });
        return;
      }

      sendJson(res, 200, { received: true });
      return;
    }

    // ==========================================================
    // TIKTOK — GARDE : configuration
    // ==========================================================

    if (url.pathname.startsWith("/api/tiktok/") && !tiktokEnabled) {
      sendJson(res, 500, {
        success: false,
        error: "TikTok is not configured",
      });
      return;
    }

    // ==========================================================
    // TIKTOK — URL D'AUTORISATION
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/tiktok/auth/url") {
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

    // ==========================================================
    // TIKTOK — CALLBACK (échange code -> tokens)
    // ==========================================================
    //
    // Appelé par le frontend (TikTokCallback.tsx) avec { code, state }
    // récupérés depuis sessionStorage après l'interception de
    // /tiktok/callback?code=...&state=... par App.tsx.

    if (req.method === "POST" && url.pathname === "/api/tiktok/auth/callback") {
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

        // Profil TikTok (scope user.info.basic)
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

    // ==========================================================
    // TIKTOK — STATUT DE LA CONNEXION
    // ==========================================================

    if (req.method === "GET" && url.pathname === "/api/tiktok/status") {
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

    // ==========================================================
    // TIKTOK — DÉCONNEXION
    // ==========================================================

    if (req.method === "DELETE" && url.pathname === "/api/tiktok/disconnect") {
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

    // ==========================================================
    // TIKTOK — INFOS CRÉATEUR (privacy options, durée max...)
    // ==========================================================
    //
    // À appeler avant d'afficher le formulaire de publication :
    // privacy_level_options liste les valeurs autorisées.

    if (req.method === "GET" && url.pathname === "/api/tiktok/creator-info") {
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

    // ==========================================================
    // TIKTOK — PUBLIER UNE VIDÉO (upload de fichier)
    // ==========================================================
    //
    // multipart/form-data :
    //   video          (fichier)  mp4 / mov / webm
    //   mode           "direct" (video.publish) | "draft" (video.upload)
    //   title          légende (direct uniquement)
    //   privacy_level  PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS |
    //                  FOLLOWER_OF_CREATOR | SELF_ONLY
    //   disable_comment / disable_duet / disable_stitch  "true" | "false"

    if (req.method === "POST" && url.pathname === "/api/tiktok/publish") {
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

      try {
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
      }

      return;
    }

    // ==========================================================
    // TIKTOK — PUBLIER UNE VIDÉO DEPUIS UNE URL
    // ==========================================================
    //
    // JSON : { mode, videoUrl, title, privacy_level, ... }
    // ⚠️ Le domaine de videoUrl doit être vérifié dans le portail
    // TikTok for Developers (URL properties).

    if (req.method === "POST" && url.pathname === "/api/tiktok/publish/url") {
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

    // ==========================================================
    // TIKTOK — STATUT D'UNE PUBLICATION
    // ==========================================================

    if (
      req.method === "GET" &&
      url.pathname === "/api/tiktok/publish/status"
    ) {
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

        // status : PROCESSING_UPLOAD | PROCESSING_DOWNLOAD |
        //          SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED
        sendJson(res, 200, { success: true, ...result.data });
      } catch (tiktokError) {
        sendTikTokError(res, tiktokError);
      }

      return;
    }

    // ==========================================================
    // PINTEREST — GARDE : configuration
    // ==========================================================

    if (url.pathname.startsWith("/api/pinterest/") && !pinterestEnabled) {
      sendJson(res, 500, {
        success: false,
        error: "Pinterest is not configured",
      });
      return;
    }

    // ==========================================================
    // PINTEREST — URL D'AUTORISATION
    // ==========================================================

    if (req.method === "POST" && url.pathname === "/api/pinterest/auth/url") {
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

    // ==========================================================
    // PINTEREST — CALLBACK (échange code -> tokens)
    // ==========================================================
    //
    // Appelé par le frontend (PinterestCallback.tsx) avec { code, state }
    // récupérés depuis sessionStorage après l'interception de
    // /pinterest/callback?code=...&state=... par App.tsx.

    if (
      req.method === "POST" &&
      url.pathname === "/api/pinterest/auth/callback"
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

        // Profil Pinterest (scope user_accounts:read).
        // Non bloquant : en sandbox, le profil peut être incomplet.
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

    // ==========================================================
    // PINTEREST — STATUT DE LA CONNEXION
    // ==========================================================

    if (req.method === "GET" && url.pathname === "/api/pinterest/status") {
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

    // ==========================================================
    // PINTEREST — DÉCONNEXION
    // ==========================================================
    //
    // On supprime simplement les tokens stockés (pas d'endpoint de
    // révocation utilisé ici).

    if (
      req.method === "DELETE" &&
      url.pathname === "/api/pinterest/disconnect"
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
        sendJson(res, 500, { success: false, error: deleteError.message });
        return;
      }

      sendJson(res, 200, { success: true });
      return;
    }

    // ==========================================================
    // 404
    // ==========================================================

    sendJson(res, 404, {
      success: false,
      error: "Route not found",
      path: url.pathname,
      method: req.method,
    });
  } catch (error) {
    // Les headers CORS ont déjà été posés plus haut : cette réponse
    // d'erreur reste lisible par le navigateur.
    if (!res.headersSent) {
      sendJson(res, 500, {
        success: false,
        error:
          error instanceof Error ? error.message : "Internal server error",
      });
    }
  }
});

// ============================================================
// START SERVER
// ============================================================

server.listen(PORT, () => {
  console.log(`Stone server running on port ${PORT}`);
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