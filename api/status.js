import { NARADAYA_URL, backendHeaders, getTokenFromAuth, json, preflight } from "../lib/common.js";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return preflight();

  const token = getTokenFromAuth(req);
  if (!token) return json({ error: "No token" }, 401);

  // ponytail: forward query params (dari, sampai) to backend
  const queryString = new URL(req.url).search; // includes '?' if params exist

  const res = await fetch(`${NARADAYA_URL}/api/v1/absensi/riwayat${queryString}`, {
    method: "POST",
    headers: backendHeaders(token, req),
  });

  const data = await res.json().catch(() => null);
  return json(data, res.status);
}
