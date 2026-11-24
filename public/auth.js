/**
 * auth.js — modul autentikasi sisi-browser (ES module, tanpa dependensi).
 *
 * Yang ditangani:
 *  - Single-flight refresh: banyak request/tab yang butuh token baru bersamaan
 *    hanya memicu SATU panggilan refresh (penting jika refresh token dirotasi).
 *  - authFetch(): pasang Authorization, refresh proaktif sebelum kedaluwarsa,
 *    dan jika server membalas 401 -> refresh lalu ulangi request tepat SATU kali.
 *  - Pembedaan error: AuthError (sesi benar-benar tidak valid -> sesi diakhiri)
 *    vs TransientError (jaringan putus / server 5xx -> sesi dipertahankan).
 *  - Refresh terjadwal mengikuti `exp` JWT, dicek ulang saat tab kembali aktif
 *    atau koneksi pulih (timer di tab background bisa tertunda atau berhenti).
 *
 * ⚠️ SECURITY WARNING:
 *  - localStorage vulnerable to XSS (malicious script can steal tokens)
 *  - Production: move refresh_token to HttpOnly cookie (backend change needed)
 *  - CSP headers applied but 'unsafe-inline' still allowed (legacy inline script)
 *
 * Contoh pemakaian:
 *   import { startSession, login, authFetch, logout, onSessionEnd } from "./auth.js";
 *
 *   onSessionEnd((reason) => { location.href = "/"; });   // satu-satunya tempat redirect
 *   if (!(await startSession())) location.href = "/";     // di halaman yang butuh login
 *   const res = await authFetch("/api/hari-ini");
 *
 * Catatan:
 *  - authFetch mengulang request saat 401, jadi body harus bisa dikirim ulang
 *    (string, JSON, FormData, Blob). ReadableStream tidak bisa.
 *  - Token disimpan di localStorage agar bertahan saat reload. Untuk keamanan
 *    lebih baik, simpan refresh token di cookie HttpOnly yang diatur server.
 */

const DEFAULTS = {
  loginUrl: "/api/login",
  refreshUrl: "/api/refresh",
  logoutUrl: null, // isi jika backend punya endpoint pencabutan refresh token
  skewSeconds: 60, // refresh ketika sisa umur access token <= nilai ini
  retryDelayMs: 30_000, // jeda coba ulang jika refresh gagal karena gangguan sementara
  storagePrefix: "auth_",
};

const MIN_TIMER_MS = 5_000; // cegah loop rapat bila jam client tidak akurat
const MAX_TIMER_MS = 2 ** 31 - 1; // batas maksimum setTimeout

let cfg = { ...DEFAULTS };

export function configureAuth(options = {}) {
  cfg = { ...cfg, ...options };
}

// ---------------------------------------------------------------- error types

/** Sesi tidak valid (refresh ditolak, tidak ada token, kredensial salah). */
export class AuthError extends Error {
  constructor(message, code = "unauthorized") {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Gangguan sementara (jaringan putus, timeout, 5xx). Sesi TIDAK diakhiri. */
export class TransientError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "TransientError";
    this.cause = cause;
  }
}

// -------------------------------------------------------------------- storage

const mem = new Map(); // cadangan bila localStorage tidak bisa dipakai (mode privat, dll.)
const key = (k) => cfg.storagePrefix + k;

const store = {
  get(k) {
    try {
      return localStorage.getItem(key(k));
    } catch {
      return mem.get(key(k)) ?? null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(key(k), v);
    } catch {
      mem.set(key(k), v);
    }
  },
  remove(k) {
    try {
      localStorage.removeItem(key(k));
    } catch {
      mem.delete(key(k));
    }
  },
};

const getAccessToken = () => store.get("access_token");
const getRefreshToken = () => store.get("refresh_token");

function setTokens({ access_token, refresh_token }) {
  store.set("access_token", access_token);
  if (refresh_token) store.set("refresh_token", refresh_token); // simpan hasil rotasi
}

function clearSession() {
  store.remove("access_token");
  store.remove("refresh_token");
  store.remove("profile");
}

export const isLoggedIn = () => !!(getAccessToken() || getRefreshToken());

export function getProfile() {
  try {
    return JSON.parse(store.get("profile") || "null");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------ JWT

/** Decode payload JWT (base64url + UTF-8). Mengembalikan null jika tidak valid. */
export function decodeJwt(token) {
  try {
    const part = String(token).split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function secondsLeft(token) {
  const p = decodeJwt(token);
  return p && typeof p.exp === "number" ? p.exp - Date.now() / 1000 : null;
}

/** Berapa detik lagi sampai token perlu di-refresh (<= 0 berarti sekarang). */
function refreshInSeconds(token) {
  const p = decodeJwt(token);
  if (!p || typeof p.exp !== "number") return null; // bukan JWT / tanpa exp: andalkan 401
  const lifetime = typeof p.iat === "number" ? p.exp - p.iat : Infinity;
  const skew = Math.min(cfg.skewSeconds, lifetime * 0.25); // aman untuk token berumur pendek
  return p.exp - skew - Date.now() / 1000;
}

const needsRefresh = (t) => {
  const s = refreshInSeconds(t);
  return s !== null && s <= 0;
};

const isExpired = (t) => {
  const s = secondsLeft(t);
  return s !== null && s <= 0;
};

// --------------------------------------------------------------------- events

const listeners = new Set();

/** Daftarkan callback yang dipanggil saat sesi berakhir. Mengembalikan fungsi unsubscribe. */
export function onSessionEnd(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function endSession(reason) {
  clearTimeout(timer);
  const hadSession = isLoggedIn();
  clearSession();
  if (!hadSession) return; // request lain sudah mengakhiri sesi, jangan emit dua kali
  for (const cb of listeners) {
    try {
      cb(reason);
    } catch {
      /* callback pengguna tidak boleh merusak alur */
    }
  }
}

// -------------------------------------------------------------- refresh logic

const safeJson = (res) => res.json().catch(() => null);

let inflight = null;

/**
 * Single-flight: semua pemanggil yang datang saat refresh berjalan menunggu
 * promise yang sama. `staleToken` adalah token yang dipakai request yang gagal;
 * jika token di storage sudah berbeda, berarti sudah ada yang me-refresh.
 */
function refreshSession(staleToken = getAccessToken()) {
  if (!inflight) {
    inflight = (async () => {
      try {
        return await withLock(() => doRefresh(staleToken));
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

/** Kunci lintas-tab (Web Locks) agar dua tab tidak me-refresh bersamaan. */
function withLock(fn) {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks?.request ? locks.request("auth-refresh", fn) : fn();
}

async function doRefresh(staleToken) {
  // Mungkin tab lain sudah me-refresh saat kita menunggu kunci.
  const current = getAccessToken();
  if (current && current !== staleToken && !needsRefresh(current)) return current;

  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new AuthError("Refresh token tidak ada", "no_refresh_token");

  let res;
  try {
    res = await fetch(cfg.refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      credentials: "include",
    });
  } catch (e) {
    throw new TransientError("Tidak bisa menghubungi server saat refresh", e);
  }

  // Hanya penolakan eksplisit yang berarti sesi sudah tidak valid.
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    throw new AuthError("Refresh token ditolak", "refresh_rejected");
  }
  if (!res.ok) throw new TransientError(`Refresh gagal (HTTP ${res.status})`);

  const data = await safeJson(res);
  if (!data?.access_token) throw new TransientError("Respons refresh tidak valid");

  setTokens(data);
  
  // ponytail: fetch complete profile on refresh to keep localStorage up-to-date
  // (user data may change: jabatan promoted, no_hp updated, etc)
  try {
    const profileRes = await fetch('/api/profile', {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${data.access_token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (profileRes.ok) {
      const profileData = await profileRes.json();
      const apiProfile = profileData.data || profileData;
      const currentProfile = getProfile() || {};
      
      // Merge with existing profile (preserve fields not in API response)
      const updatedProfile = {
        ...currentProfile,
        id: apiProfile.employee_id || currentProfile.id,
        nama_karyawan: apiProfile.nama || currentProfile.nama_karyawan,
        unit_kerja: apiProfile.unit_kerja || currentProfile.unit_kerja,
        penugasan: apiProfile.penugasan || currentProfile.penugasan,
        jabatan: apiProfile.jabatan,
        no_hp: apiProfile.no_hp,
        email: apiProfile.email
      };
      
      store.set("profile", JSON.stringify(updatedProfile));
    }
  } catch (e) {
    console.warn('Failed to refresh profile data:', e);
    // Continue - token refresh succeeded, profile update is optional
  }
  
  schedule();
  return data.access_token;
}

/** Refresh; jika ditolak server, akhiri sesi. Error jaringan tidak mengakhiri sesi. */
async function refreshOrEnd(staleToken) {
  try {
    return await refreshSession(staleToken);
  } catch (e) {
    if (e instanceof AuthError) endSession(e.code);
    throw e;
  }
}

/**
 * Kembalikan access token yang siap dipakai, refresh dulu bila hampir habis.
 * Jika refresh gagal karena gangguan sementara dan token lama belum kedaluwarsa,
 * token lama tetap dipakai.
 */
export async function getValidAccessToken() {
  const token = getAccessToken();

  if (!token) {
    if (!getRefreshToken()) throw new AuthError("Belum login", "no_session");
    return refreshOrEnd(token);
  }
  if (!needsRefresh(token)) return token;

  try {
    return await refreshOrEnd(token);
  } catch (e) {
    if (e instanceof TransientError && !isExpired(token)) return token;
    throw e;
  }
}

// ------------------------------------------------------------------ authFetch

async function send(input, init, token) {
  const headers = new Headers(
    init.headers || (input instanceof Request ? input.headers : undefined)
  );
  headers.set("Authorization", `Bearer ${token}`);
  const target = input instanceof Request ? input.clone() : input;
  try {
    return await fetch(target, { ...init, headers });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new TransientError("Gagal terhubung ke server", e);
  }
}

/**
 * fetch dengan autentikasi. Alur:
 *  1. ambil token valid (refresh proaktif bila hampir habis),
 *  2. kirim request,
 *  3. jika 401 -> refresh (single-flight) lalu ulangi SATU kali,
 *  4. jika masih 401 -> akhiri sesi dan kembalikan respons 401 apa adanya.
 *
 * Melempar AuthError (sesi berakhir) atau TransientError (gangguan jaringan/server).
 * Status HTTP lain dikembalikan ke pemanggil seperti fetch biasa.
 */
export async function authFetch(input, init = {}) {
  const token = await getValidAccessToken();
  const res = await send(input, init, token);
  if (res.status !== 401) return res;

  const fresh = await refreshOrEnd(token);
  const retry = await send(input, init, fresh);
  if (retry.status === 401) endSession("unauthorized");
  return retry;
}

// ---------------------------------------------------------- login & logout

export async function login(username, password) {
  let res;
  try {
    res = await fetch(cfg.loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: username, password }),
      credentials: "include",
    });
  } catch (e) {
    throw new TransientError("Tidak bisa menghubungi server", e);
  }

  const data = await safeJson(res);
  if (res.ok && data?.access_token) {
    setTokens(data);
    
    // ponytail: login response data incomplete (missing jabatan, no_hp)
    // fetch complete profile from /api/profile
    let completeProfile = data.data ?? null;
    try {
      const profileRes = await fetch('/api/profile', {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${data.access_token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        // Merge complete profile data (API returns nested: { status, data })
        const apiProfile = profileData.data || profileData;
        completeProfile = {
          id: apiProfile.employee_id || data.data?.employee_id,
          username: data.data?.username,
          nama_karyawan: apiProfile.nama || data.data?.nama_karyawan,
          unit_kerja: apiProfile.unit_kerja || data.data?.unit_kerja,
          penugasan: apiProfile.penugasan || data.data?.penugasan,
          jabatan: apiProfile.jabatan,
          no_hp: apiProfile.no_hp,
          email: apiProfile.email
        };
      }
    } catch (e) {
      console.warn('Failed to fetch complete profile:', e);
      // Continue with partial profile from login response
    }
    
    store.set("profile", JSON.stringify(completeProfile));
    schedule();
    return completeProfile;
  }
  if (res.status >= 500) throw new TransientError(`Server error (HTTP ${res.status})`);
  throw new AuthError(data?.message || "Login gagal", "invalid_credentials");
}

export async function logout() {
  const refreshToken = getRefreshToken();
  const accessToken = getAccessToken();
  if (cfg.logoutUrl && refreshToken) {
    try {
      await fetch(cfg.logoutUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        credentials: "include",
      });
    } catch {
      /* pencabutan di server bersifat best-effort */
    }
  }
  endSession("logout");
}

// -------------------------------------------------------- refresh terjadwal

let timer = null;
let listening = false;

function schedule() {
  clearTimeout(timer);
  const token = getAccessToken();
  const secs = token ? refreshInSeconds(token) : null;
  if (secs === null) return;
  const ms = Math.min(Math.max(secs * 1000, MIN_TIMER_MS), MAX_TIMER_MS);
  timer = setTimeout(tick, ms);
}

async function tick() {
  clearTimeout(timer);
  if (!isLoggedIn()) return;
  try {
    await getValidAccessToken();
    schedule();
  } catch (e) {
    if (e instanceof AuthError) return; // sesi sudah diakhiri
    timer = setTimeout(tick, cfg.retryDelayMs); // gangguan sementara: coba lagi nanti
  }
}

function attachListeners() {
  if (listening || typeof window === "undefined") return;
  listening = true;

  // Timer bisa tertunda saat tab di background atau perangkat tidur.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
  window.addEventListener("online", tick);

  // Sinkronisasi antar tab: logout atau token baru dari tab lain.
  window.addEventListener("storage", (e) => {
    if (e.key !== key("access_token")) return;
    if (e.newValue === null) endSession("logout_other_tab");
    else schedule();
  });
}

/**
 * Panggil sekali saat halaman dimuat. Memastikan token valid (refresh bila perlu),
 * menyalakan refresh terjadwal, dan mengembalikan true jika sesi masih aktif.
 */
export async function startSession() {
  attachListeners();
  if (!isLoggedIn()) return false;

  try {
    await getValidAccessToken();
    schedule();
    return true;
  } catch (e) {
    if (e instanceof AuthError) return false;
    timer = setTimeout(tick, cfg.retryDelayMs); // offline saat load: sesi lokal tetap, coba lagi
    return true;
  }
}
