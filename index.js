// CTGMovies Stremio addon (Vercel). Reads data.json made by the scraper,
// so it never needs to connect to ctgmovies.com from Vercel.
const fs = require("fs");
const zlib = require("zlib");
const pathMod = require("path");
function loadData() {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(pathMod.join(__dirname, "..", "data.json.gz"))).toString()); } catch {}
  try { return require("../data.json"); } catch {}
  return { items: [] };
}
const DATA = loadData();
let LIVE = null;
try { LIVE = require("../live.js"); } catch (e) { LIVE = null; }
const LIVE_ON = process.env.CTG_LIVE === "1";
const ITEMS = DATA.items || [];
const PAGE = 100;

const manifest = {
  id: "com.mhthe1.ctgmovies.bridge",
  version: "2.0.0",
  name: "CTGMovies Bridge",
  description: "High-speed ISP/BDIX direct streams for Movies, TV Shows and Anime from CTGMovies.",
  logo: "https://dhakastremio.mehedihtanvir.me/icon.svg",
  background: "https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?q=80&w=1920&auto=format&fit=crop",
  contactEmail: "mhthe1.dev@gmail.com",
  resources: [
    "catalog",
    { name: "meta", types: ["movie", "series"], idPrefixes: ["ctg:"] },
    { name: "stream", types: ["movie", "series"], idPrefixes: ["ctg:", "tt"] }
  ],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "ctg_movies", name: "CTGMovies Movies", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "ctg_tv", name: "CTGMovies TV Shows", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "ctg_anime", name: "CTGMovies Anime", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

const CAT_KIND = { ctg_movies: "movies", ctg_tv: "tv", ctg_anime: "anime" };
const REFERER = "https://ctgmovies.com/";
const byId = new Map(ITEMS.map((i) => [i.id, i]));
const byImdb = new Map(ITEMS.filter((i) => i.imdb).map((i) => [i.imdb, i]));
const byTmdb = new Map(ITEMS.filter((i) => i.tmdb).map((i) => [String(i.tmdb), i]));
const normName = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const byName = new Map();
for (const i of ITEMS) { const k = normName(i.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(i); }
const stype = (k) => (k === "movies" ? "movie" : "series");
const norm = (s) => String(s || "").toLowerCase();

const cacheLive = new Map();
async function cached(key, ttl, fn) {
  const h = cacheLive.get(key);
  if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn();
  cacheLive.set(key, { t: Date.now(), v });
  return v;
}
async function liveCards(kind, query) {
  if (!LIVE || !LIVE_ON) return [];
  try {
    const url = query ? `${LIVE.MAIN}/search?q=${encodeURIComponent(query)}` : `${LIVE.MAIN}/${kind === "movies" ? "movies" : kind}?page=1`;
    const html = await cached("list:" + url, 5 * 60 * 1000, () => LIVE.getText(url));
    return LIVE.parseCards(html).filter((c) => c.kind === kind).map((c) => ({ id: LIVE.idOf(c), kind: c.kind, name: c.name, poster: c.poster, year: c.year }));
  } catch { return []; }
}
async function liveItem(kind, slug) {
  if (!LIVE || !LIVE_ON) return null;
  try {
    return await cached(`item:${kind}:${slug}`, 10 * 60 * 1000, () => LIVE.buildItem({ kind, slug, name: slug }));
  } catch { return null; }
}

function card(i) {
  return { id: i.id, type: stype(i.kind), name: i.name, poster: i.poster, releaseInfo: i.year ? String(i.year) : undefined };
}

async function matchByCinemeta(type, rawId) {
  const [imdb, s, e] = rawId.split(":");
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`, { signal: AbortSignal.timeout(4500) });
    if (!r.ok) return { item: null };
    const { meta } = await r.json();
    if (!meta) return { item: null };
    const want = type === "movie" ? "movies" : null;
    const cands = (byName.get(normName(meta.name)) || []).filter((i) => (want ? i.kind === "movies" : i.kind !== "movies"));
    const y = parseInt(String(meta.releaseInfo || meta.year || "").slice(0, 4), 10);
    const item = cands.find((i) => !y || !i.year || i.year === y) || cands.find((i) => !y || !i.year || Math.abs(i.year - y) <= 1) || cands[0] || null;
    return { item, s: +s || null, e: +e || null };
  } catch { return { item: null }; }
}

function findItem(rawId) {
  const parts = rawId.split(":");
  if (rawId.startsWith("ctg:")) return { item: byId.get(parts.slice(0, 3).join(":")), s: +parts[3] || null, e: +parts[4] || null };
  if (rawId.startsWith("tmdb:")) return { item: byTmdb.get(parts[1]), s: +parts[2] || null, e: +parts[3] || null };
  return { item: byImdb.get(parts[0]), s: +parts[1] || null, e: +parts[2] || null };
}

function toStreams(links) {
  return (links || []).filter((l) => l.url).map((l) => ({
    name: `CTGMovies\n${l.quality || "Direct"}`,
    title: `${l.quality || "Direct"} (${l.source || "Server"})`,
    url: l.url,
    subtitles: l.subs && l.subs.length ? l.subs.map((t, i) => ({ id: String(i), url: t.url, lang: t.label || "English" })) : undefined,
    behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: REFERER } } }
  }));
}

async function catalog(id, extra) {
  const kind = CAT_KIND[id];
  if (!kind) return { metas: [] };
  let list = ITEMS.filter((i) => i.kind === kind);
  const skip = parseInt(extra.skip || "0", 10) || 0;
  if (extra.search) {
    const q = norm(extra.search);
    list = list.filter((i) => norm(i.name).includes(q));
    const fresh = (await liveCards(kind, extra.search)).filter((c) => !byId.has(c.id) && !list.some((l) => l.id === c.id));
    return { metas: [...list, ...fresh].slice(0, PAGE).map(card) };
  }
  if (skip === 0) {
    const fresh = (await liveCards(kind)).filter((c) => !byId.has(c.id));
    list = [...fresh, ...list];
  }
  return { metas: list.slice(skip, skip + PAGE).map(card) };
}

async function meta(id) {
  let { item } = findItem(id);
  if (id.startsWith("ctg:")) {
    const [, kind, slug] = id.split(":");
    if (!item || item.kind !== "movies") {
      const fresh = await liveItem(kind, (slug || "").replace(/~/g, "/"));
      if (fresh && (!item || (fresh.episodes || []).length >= (item.episodes || []).length)) item = fresh;
    }
  }
  if (!item) return { meta: null };
  const m = {
    id: item.id, type: stype(item.kind), name: item.name, poster: item.poster, background: item.backdrop,
    description: item.overview, releaseInfo: item.year ? String(item.year) : undefined,
    imdbRating: item.rating ? String(item.rating) : undefined, genres: item.genres, runtime: item.runtime ? `${item.runtime} min` : undefined
  };
  if (item.trailer) m.trailers = [{ source: item.trailer, type: "Trailer" }];
  if (item.kind !== "movies") {
    m.videos = (item.episodes || []).map((ep) => ({
      id: `${item.id}:${ep.s}:${ep.e}`, title: ep.name || `Episode ${ep.e}`, season: ep.s, episode: ep.e,
      overview: ep.overview, thumbnail: ep.still,
      released: ep.air ? new Date(ep.air).toISOString() : new Date(0).toISOString()
    }));
  }
  return { meta: m };
}

async function stream(id, type) {
  let { item, s, e } = findItem(id);
  if (!item && !id.startsWith("ctg:")) ({ item, s, e } = await matchByCinemeta(type === "movie" ? "movie" : "series", id));
  const findEp = (it) => (it.episodes || []).find((x) => x.s === (s || 1) && x.e === (e || 1));
  const need = !item || (item.kind === "movies" ? !(item.links || []).length : !(findEp(item) || {}).links);
  if (need && id.startsWith("ctg:")) {
    const [, kind, slug] = id.split(":");
    const fresh = await liveItem(kind, (slug || "").replace(/~/g, "/"));
    if (fresh) item = fresh;
  }
  if (!item) return { streams: [] };
  if (item.kind === "movies") return { streams: toStreams(item.links) };
  const ep = findEp(item);
  return { streams: toStreams(ep && ep.links) };
}

function parseExtra(str) {
  const out = {};
  if (!str) return out;
  for (const p of str.split("&")) {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(204).end();
  const parts = decodeURIComponent((req.url || "/").split("?")[0]).replace(/\.json$/, "").split("/").filter(Boolean);
  const [resource, type, id, extraStr] = parts;
  const out = (o) => res.status(200).send(JSON.stringify(o));
  try {
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    if (!resource || resource === "manifest") return out(manifest);
    if (resource === "status") {
      const c = (k) => ITEMS.filter((i) => i.kind === k).length;
      return out({ updated: DATA.updated || null, items: ITEMS.length, movies: c("movies"), tv: c("tv"), anime: c("anime") });
    }
    if (resource === "ping") {
      if (!LIVE) return out({ ok: false, error: "live.js nai" });
      try {
        const n = await LIVE.getText(`${LIVE.MAIN}/movies?page=1`).then((h) => LIVE.parseCards(h).filter((c) => c.kind === "movies"));
        return out({ ok: true, liveWorks: true, moviesFound: n.length, first: n[0] && n[0].name, region: process.env.VERCEL_REGION || null });
      } catch (err) {
        return out({ ok: false, liveWorks: false, error: String(err.message || err) + (err.cause ? " | " + (err.cause.code || err.cause.message) : ""), region: process.env.VERCEL_REGION || null, note: "Site Vercel theke khole na. Naya movie PC theke (4-UPDATE-NOW) ashbe." });
      }
    }
    if (resource === "catalog") return out(await catalog(id, parseExtra(extraStr)));
    if (resource === "meta") return out(await meta(id));
    if (resource === "stream") return out(await stream(id, type));
    return res.status(404).send(JSON.stringify({ error: "not found" }));
  } catch (err) {
    console.error(err);
    res.setHeader("Cache-Control", "no-store");
    if (resource === "catalog") return out({ metas: [] });
    if (resource === "stream") return out({ streams: [] });
    return out({ meta: null });
  }
};
