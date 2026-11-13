# Amatu Translator

Terjemahan suara langsung ke semua bahasa — https://amatu-id.github.io/translator/ (aplikasi Portal AMATU).

- **Live**: tombol bahasa (Web Speech, kata muncul saat bicara) atau **Auto** (perekam + Whisper, bahasa dikenali sendiri).
- **Terjemahan**: Google untuk hasil instan, lalu AI (Gemma 4 / SEA-LION v4 di Cloudflare Workers AI) yang paham konteks
  percakapan mengganti dengan kalimat yang natural seperti penutur asli.
- **Ketik** bila perlu, terjemahan bisa **dibacakan** (suara perangkat, atau suara Google bila perangkat tak punya).
- **Riwayat** percakapan tersimpan di akun Portal AMATU (sinkron antar perangkat lewat `/amatu.js`).

## Susunan

| Berkas | Isi |
| --- | --- |
| `index.html`, `app.css`, `app.js`, `langs.js` | halaman (tanpa build) |
| `cloud/supabase/functions/amatu-translate` | gerbang: cek login portal, teruskan ke Worker |
| `cloud/worker` | Worker `amatu-ai`: terjemahan AI + Whisper |

Halaman → edge function Supabase (project amatu-id) → Worker `amatu-ai.liemyo.workers.dev`. Halaman tidak memanggil
`*.workers.dev` langsung karena DNS domain itu dibelokkan sebagian ISP Indonesia.

## Deploy

```bash
git push                                   # halaman (GitHub Pages, branch main)
cd cloud/worker && npx wrangler@4 deploy   # Worker (rahasia KEY)
cd cloud && supabase functions deploy amatu-translate --project-ref ieyqxmzztoxgpvwexbkj --no-verify-jwt --use-api
```

Rahasia: Worker `KEY` = Supabase `AMATU_AI_KEY` (+ `AMATU_AI_URL`). Kalau hilang, buat yang baru dan pasang di keduanya.
