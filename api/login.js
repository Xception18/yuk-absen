import { NARADAYA_URL, checkRateLimit, getClientIp, json, preflight } from "../lib/common.js";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return preflight();

  // ponytail: rate limit login attempts (prevent brute force)
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, "login")) {
    return json({ error: "Too many requests" }, 429);
  }

  const body = await req.json();
  const res = await fetch(`${NARADAYA_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: body.login, password: body.password }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: "Backend error" }, 502);
  }

  if (!res.ok) {
    return json(data, res.status);
  }

  console.log("[LOGIN]", {
    status: data.status,
    has_access_token: !!data.access_token,
    has_refresh_token: !!data.refresh_token,
    username: body.login,
    nama: data.data?.nama_karyawan,
    unit: data.data?.unit_kerja,
    penugasan: data.data?.penugasan,
  });

  const headers = { "Content-Type": "application/json" };
  const cookies = res.headers.get("set-cookie");
  if (cookies) headers["Set-Cookie"] = cookies;

  return new Response(JSON.stringify(data), { headers });
}
