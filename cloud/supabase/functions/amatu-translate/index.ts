// amatu-translate — gateway from Amatu Translator (amatu-id.github.io/translator) to the Cloudflare Worker amatu-ai
// (Workers AI: Gemma 4 / SEA-LION translation, Whisper speech recognition). The page can't call *.workers.dev
// itself: some Indonesian ISPs hijack that domain's DNS.
//   POST …/amatu-translate/tr | …/amatu-translate/stt   header x-amatu: <portal session token>   JSON body passed on
//   POST …/amatu-translate/tts {tl, q, s?}   → audio/mpeg of Google's voice (≤ 240 chars). Google's audio has no CORS
//        header, and an iPhone must play speech through the page's own audio context during live listening.
// Deploy: supabase functions deploy amatu-translate --project-ref ieyqxmzztoxgpvwexbkj --no-verify-jwt --use-api
// Secrets: AMATU_AI_URL (https://amatu-ai.liemyo.workers.dev), AMATU_AI_KEY (= Worker secret KEY)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-amatu',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const SB = Deno.env.get('SUPABASE_URL')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const AI = (Deno.env.get('AMATU_AI_URL') || '').replace(/\/$/, ''), KEY = Deno.env.get('AMATU_AI_KEY') || '';
const LIMIT: Record<string, [number, number]> = { tr: [60, 20e3], stt: [40, 4.5e6], tts: [150, 2e3] };   // per user per minute, max body bytes
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36';

async function tts(body: string) {
  let j: { tl?: string; q?: string; s?: number };
  try { j = JSON.parse(body); } catch { return out({ error: 'data' }, 400); }
  const tl = String(j.tl || ''), q = String(j.q || '').trim(), s = Number(j.s) || 1;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(tl) || !q || q.length > 240) return out({ error: 'data' }, 400);
  const u = 'https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=' + encodeURIComponent(tl) + '&q=' + encodeURIComponent(q) +
    (s < 0.95 ? '&ttsspeed=' + Math.max(0.3, s).toFixed(2) : '');
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10e3) });
  if (!r.ok || !/audio/.test(r.headers.get('content-type') || '')) return out({ error: 'tts' }, 502);
  return new Response(r.body, { headers: { ...CORS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' } });
}

const out = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// signed-in portal users only; a good token is remembered for 10 minutes so a conversation costs no database calls
const seen = new Map<string, { u: string; until: number }>();
async function who(token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) return '';
  const c = seen.get(token);
  if (c && c.until > Date.now()) return c.u;
  const r = await fetch(`${SB}/rest/v1/rpc/amt_status`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => null);
  const u = (r.ok && j && j.user) || '';
  if (u) {
    if (seen.size > 500) seen.clear();
    seen.set(token, { u, until: Date.now() + 10 * 60e3 });
  }
  return u;
}

const hits = new Map<string, number[]>();
function busy(key: string, max: number) {
  const now = Date.now(), h = (hits.get(key) || []).filter((t) => now - t < 60e3);
  if (h.length >= max) return true;
  h.push(now);
  hits.set(key, h);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return out({ error: 'method' }, 405);
  const path = new URL(req.url).pathname.split('/').pop() || '';
  const lim = LIMIT[path];
  if (!lim) return out({ error: 'path' }, 404);
  if ((!AI || !KEY) && path !== 'tts') return out({ error: 'ai' });
  try {
    const u = await who(req.headers.get('x-amatu') || '');
    if (!u) return out({ error: 'auth' }, 401);
    if (busy(u + '|' + path, lim[0])) return out({ error: 'cepat' });
    const body = await req.text();
    if (body.length > lim[1]) return out({ error: 'besar' });
    if (path === 'tts') return await tts(body);
    const r = await fetch(`${AI}/${path}`, {
      method: 'POST',
      headers: { 'x-key': KEY, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(path === 'stt' ? 45e3 : 25e3),
    });
    return new Response(await r.text(), { status: r.ok ? 200 : 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return out({ error: (e as Error).name === 'TimeoutError' ? 'lambat' : 'ai' });
  }
});
