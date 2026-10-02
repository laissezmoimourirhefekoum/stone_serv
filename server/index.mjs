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
// Frontend (Vercel)        : https://stone-prod-2fpb2146e-xsdevs-projects.vercel.app
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

// URL du FRONTEND de production (ex. https://mon-frontend.vercel.app).
// Utilisée pour success_url, cancel_url et return_url Stripe.
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
}

if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️  Stripe non configuré (STRIPE_SECRET_KEY manquant).");
}

if (!STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "⚠️  STRIPE_WEBHOOK_SECRET manquant — les webhooks ne seront pas vérifiés."
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

// Origines fixes : développement local + frontend Vercel actuel.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
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