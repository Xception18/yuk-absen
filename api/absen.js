import {
  NARADAYA_URL,
  backendHeaders,
  checkRateLimit,
  decodeJWT,
  getAddress,
  getClientIp,
  json,
  preflight,
} from "../lib/common.js";

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return preflight();

  // ponytail: rate limit absen (prevent spam)
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, "absen")) {
    return json({ error: "Too many requests" }, 429);
  }

  const body = await req.formData();
  const foto = body.get("foto");
  const token = body.get("token");
  const lat = body.get("latitude");
  const lon = body.get("longitude");

  if (!token || !lat || !lon || !foto) {
    return json({ error: "Missing fields" }, 400);
  }

  // ponytail: validate coordinates range
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (isNaN(latNum) || isNaN(lonNum) || latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
    return json({ error: "Invalid coordinates" }, 400);
  }

  // ponytail: validate file size (5MB limit)
  if (foto.size > 5 * 1024 * 1024) {
    return json({ error: "File too large (max 5MB)" }, 400);
  }

  const addr = await getAddress(lat, lon);

  const formData = new FormData();
  formData.append("foto", foto, "selfie.jpg");
  formData.append("latitude", lat);
  formData.append("longitude", lon);
  formData.append("accuracy", "35");
  formData.append("alamat", addr);
  formData.append("timezone", "Asia/Jakarta");

  // ponytail: forward client cookies to backend
  const res = await fetch(`${NARADAYA_URL}/api/v1/absensi/hit`, {
    method: "POST",
    headers: backendHeaders(token, req),
    body: formData,
  });

  const responseText = await res.text();

  // Parse response
  let parsedResponse = {};
  try {
    parsedResponse = JSON.parse(responseText);
  } catch {
    // Response not JSON
  }

  // Get user info from token payload
  const userInfo = decodeJWT(token) || {};
  console.log("[ABSEN]", {
    status: res.status,
    user_id: userInfo.id || userInfo.user_id || body.get("user_id"),
    username: userInfo.username || body.get("username"),
    nama: userInfo.nama_karyawan || body.get("nama"),
    unit: userInfo.unit_kerja || body.get("unit"),
    penugasan: userInfo.penugasan || body.get("penugasan"),
    jabatan: userInfo.jabatan || body.get("jabatan"),
    no_hp: userInfo.no_hp || body.get("no_hp"),
    latitude: lat,
    longitude: lon,
    response_status: parsedResponse.status,
    keterangan: parsedResponse.keterangan,
    detail: parsedResponse.detail, // ponytail: include API detail field
  });

  return new Response(
    JSON.stringify({
      status: res.status,
      response: parsedResponse,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
