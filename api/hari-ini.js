import { NARADAYA_URL, backendHeaders, getTokenFromAuth, json, preflight } from "../lib/common.js";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return preflight();

  const token = getTokenFromAuth(req);
  if (!token) return json({ error: "No token" }, 401);

  const res = await fetch(`${NARADAYA_URL}/api/v1/absensi/hari-ini?timezone=Asia%2FJakarta`, {
    method: "POST",
    headers: backendHeaders(token, req),
  });

  const data = await res.json().catch(() => null);
  return json(data, res.status);
}
