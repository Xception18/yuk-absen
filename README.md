# Yuk Absen — versi Vercel

Porting dari Cloudflare Workers (`src/worker.js`) ke Vercel. Logika, validasi, pesan error, log, dan
header keamanan sama dengan Worker asli.

## Struktur

```
public/                 Halaman statis (tidak diubah)
api/login.js            POST /api/login
api/absen.js            POST /api/absen
api/status.js           GET  /api/status?dari=&sampai=
api/hari-ini.js         GET  /api/hari-ini
api/refresh.js          POST /api/refresh
api/profile.js          GET  /api/profile
api/notfound.js         404 polos untuk /favicon.ico & apple-touch-icon
api/maintenance.js      Halaman maintenance (opsional)
lib/common.js           Rate limiter, JWT decode, geocoding, helper
vercel.json             cleanUrls, CSP & security headers
vercel.maintenance.json Konfigurasi mode maintenance (opsional)
```

## Deploy

Lewat dashboard: push folder ini ke GitHub → **Add New Project** di vercel.com → Import → **Deploy**
(Framework Preset: Other; setting lain sudah diatur di `vercel.json`).

Lewat CLI:

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Tidak ada environment variable atau secret yang diperlukan.

## Mode maintenance

Di Worker asli: `MAINTENANCE_MODE = true`. Di Vercel, deploy dengan konfigurasi maintenance:

```bash
vercel --prod --local-config vercel.maintenance.json
```

Semua path mengembalikan 503 + halaman maintenance (`/health` mengembalikan JSON 503).
Untuk kembali normal, deploy ulang tanpa `--local-config`.

## Perbedaan dengan Cloudflare yang perlu diketahui

- IP klien untuk rate limit diambil dari `x-real-ip` / `x-forwarded-for` (pengganti `cf-connecting-ip`).
- Rate limiter tetap in-memory (10 req/menit per IP per endpoint), jadi per instance dan reset saat cold start,
  sama seperti di Worker. Untuk yang ketat, pakai Vercel WAF Rate Limiting.
- Log (`[LOGIN]`, `[ABSEN]`, `[REFRESH]`) ada di Vercel dashboard → Logs, bukan Workers Observability.
- Batas ukuran request body Vercel sekitar 4,5 MB. Frontend sudah mengompres foto ke JPEG, jadi aman.
  Batas 5 MB di kode tetap dipertahankan.
