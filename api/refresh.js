import { NARADAYA_URL, json, preflight } from "../lib/common.js";

export const config = { runtime: "edge" };

// Refresh token endpoint
export default async function handler(req) {
  if (req.method === "OPTIONS") return preflight();

  const { refresh_token } = await req.json().catch(() => ({}));
  if (!refresh_token) return json({ error: "No refresh token" }, 400);

  const res = await fetch(`${NARADAYA_URL}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const errors = Array.isArray(data?.detail)
      ? data.detail.map((d) => ({ loc: d.loc, msg: d.msg, type: d.type }))
      : data?.detail ?? data?.message ?? null;
    console.log("[REFRESH-ERR]", res.status, JSON.stringify(errors));
  } else {
    console.log("[REFRESH]", {
      status: res.status,
      has_access_token: !!data?.access_token,
      has_refresh_token: !!data?.refresh_token,
    });
  }
  return json(data, res.status);
}
