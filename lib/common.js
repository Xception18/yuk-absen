// Helper bersama untuk semua API function (porting dari src/worker.js Cloudflare Worker)

export const NARADAYA_URL = "https://naradaya.adhimix.web.id";

// ponytail: simple rate limiter (in-memory, hilang saat cold start / per instance)
// production: pakai Vercel WAF Rate Limiting atau Upstash/KV
const rateLimiter = new Map();
const RATE_LIMIT = { requests: 10, window: 60000 }; // 10 req/min

export function checkRateLimit(ip, endpoint) {
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  const record = rateLimiter.get(key) || { count: 0, reset: now + RATE_LIMIT.window };

  if (now > record.reset) {
    record.count = 0;
    record.reset = now + RATE_LIMIT.window;
  }

  record.count++;
  rateLimiter.set(key, record);

  // Cleanup old entries (prevent memory leak)
  if (rateLimiter.size > 10000) {
    for (const [k, v] of rateLimiter.entries()) {
      if (now > v.reset) rateLimiter.delete(k);
    }
  }

  return record.count <= RATE_LIMIT.requests;
}

// Pengganti `cf-connecting-ip` di Cloudflare. Vercel mengisi x-real-ip / x-forwarded-for.
export function getClientIp(req) {
  return (
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown"
  );
}

// ponytail: extract token from Authorization header
export function getTokenFromAuth(req) {
  return req.headers.get("authorization")?.split(" ")[1] || null;
}

// ponytail: decode JWT payload, return null if invalid
// ⚠️ WARNING: Does NOT validate signature! Only for structure check.
export function decodeJWT(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Preflight CORS (sama seperti worker: berlaku untuk semua route API)
export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// Header yang diteruskan ke backend: Bearer token + cookie klien
export function backendHeaders(token, req) {
  const headers = { Authorization: `Bearer ${token}` };
  const clientCookie = req.headers.get("cookie");
  if (clientCookie) headers.Cookie = clientCookie;
  return headers;
}

export async function getAddress(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": "AbsensiWeb/1.0" } }
    );
    const data = await res.json();
    // ponytail: sanitize display_name (max 200 chars, strip control chars)
    let addr = data.display_name || `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;
    addr = addr.replace(/[\x00-\x1F\x7F-\x9F]/g, "").substring(0, 200);
    return addr;
  } catch {
    return `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;
  }
}
