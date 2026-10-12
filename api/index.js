/*
  CTGMovies Stremio addon (Vercel).
  Data source: ONLY the Cloudflare Worker / D1 database below.
  This file never contacts the CTGMovies website itself.
*/

const WORKER =
  (process.env.CTG_WORKER_URL ||
    "https://ctgmovies-api.proshantobarua70-4a5.workers.dev").replace(/\/+$/, "");

const PREFIX = "ctg:";
const PAGE_SIZE = 100; // Stremio catalog page size

const SERIES_KINDS = new Set([
  "tv", "series", "tvshow", "tv_show", "tv-show", "tvseries",
  "tv-series", "tv_series", "show", "shows", "web-series", "anime"
]);

// Settings are read each time, so they can be overridden with Vercel env vars
function cfg(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const TIMEOUT_MS = () => cfg("TIMEOUT_MS", 8000);
const RETRIES = () => cfg("RETRIES", 2);
const CACHE_MS = () => cfg("CACHE_MS", 60000);               // item/meta/stream
const PAGE_CACHE_MS = () => cfg("PAGE_CACHE_MS", 300000);    // /movies pages
const CATALOG_TTL_MS = () => cfg("CATALOG_TTL_MS", 300000);  // full catalog
const STALE_MS = () => cfg("STALE_MS", 3600000);
const WORKER_LIMIT = () => cfg("WORKER_LIMIT", 100);
const BATCH = () => Math.max(1, cfg("BATCH", 8));
const MAX_PAGES = () => cfg("MAX_PAGES", 1000);
const LOAD_BUDGET_MS = () => cfg("LOAD_BUDGET_MS", 25000);
const EXPECTED_MIN_ITEMS = () => cfg("EXPECTED_MIN_ITEMS", 0);

const cache = new Map();
let snapshot = null;   // last COMPLETE catalog only
let inflight = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ---------------- helpers ---------------- */

function parseJSON(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Always returns an array
function parseArray(value) {
  const parsed = parseJSON(value, []);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

function parseGenres(value) {
  if (typeof value === "string" && value.trim() && !/^\s*[\[{]/.test(value)) {
    return value.split(/[,|]/).map(s => s.trim()).filter(Boolean);
  }
  return parseArray(value)
    .map(g => (g && typeof g === "object" ? g.name || g.title : g))
    .filter(Boolean)
    .map(String);
}

function normalize(raw = {}) {
  const item = { ...raw };
  item.id = String(item.id ?? "");
  item.name = item.name || item.title || "Unknown";
  item.episodes = parseArray(item.episodes);
  item.links = parseArray(item.links || item.streams || item.sources);
  item.genres = parseGenres(item.genres);

  const kind = item.kind || item.type;
  item.kind = String(
    kind || (item.episodes.length ? "series" : "movie")
  ).toLowerCase();

  return item;
}

function withPrefix(id) {
  id = String(id || "");
  return id.startsWith(PREFIX) ? id : PREFIX + id;
}

function withoutPrefix(id) {
  id = String(id || "");
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id;
}

function isAnime(item) {
  return item.kind === "anime";
}

function isSeries(item) {
  return SERIES_KINDS.has(item.kind);
}

function matchesCatalog(item, type, catalogId) {
  if (catalogId === "ctg_anime") return isAnime(item);
  if (catalogId === "ctg_tv") return isSeries(item) && !isAnime(item);
  if (catalogId === "ctg_movies") return !isSeries(item);
  return type === "series" ? isSeries(item) : !isSeries(item);
}

/* ---------------- Worker access ---------------- */

async function getJSON(path, ttl = CACHE_MS()) {
  const cached = cache.get(path);
  if (cached && Date.now() - cached.time < ttl) {
    return cached.data;
  }

  let lastError = null;
  const retries = RETRIES();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());

    try {
      const response = await fetch(WORKER + path, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      if (!response.ok) {
        const err = new Error("Worker HTTP " + response.status);
        err.status = response.status;
        throw err;
      }

      const data = await response.json();

      if (cache.size > 1000) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(path, { data, time: Date.now() });
      return data;
    } catch (error) {
      if (error && error.name === "AbortError") {
        error = new Error("Worker timeout after " + TIMEOUT_MS() + "ms");
      }
      lastError = error;
      const retryable = !error.status || error.status >= 500;
      if (!retryable) break;
      if (attempt < retries) await sleep(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  // Worker failing: use older cached data for single items only
  if (cached && Date.now() - cached.time < STALE_MS()) {
    return cached.data;
  }

  throw lastError || new Error("Worker request failed");
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;

  for (const key of ["items", "results", "data", "movies", "rows"]) {
    const value = data[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray(value.items)) {
      return value.items;
    }
  }
  return null;
}

function pickNumber(...values) {
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

async function fetchPage(page) {
  const path = "/movies?page=" + page + "&limit=" + WORKER_LIMIT();
  const data = await getJSON(path, PAGE_CACHE_MS());
  const list = extractList(data);

  if (!list) {
    throw new Error("Invalid Worker response for page " + page);
  }

  const meta = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const pag = meta.pagination && typeof meta.pagination === "object" ? meta.pagination : {};

  return {
    items: list.map(normalize),
    total: pickNumber(
      meta.total, meta.totalItems, meta.total_items, meta.totalCount,
      meta.total_count, pag.total, pag.totalItems, pag.total_items
    )
  };
}

/*
  Builds the whole catalog from /movies?page=N&limit=100.
  The result is "complete" ONLY IF:
    - the end was reached (an empty page, or the Worker's reported total), and
    - no page failed, no page repeated, the time budget was not exceeded, and
    - the number of records matches the Worker's total (when it reports one).
*/
async function buildCatalog() {
  const started = Date.now();
  const budget = LOAD_BUDGET_MS();
  const maxPages = MAX_PAGES();
  const batch = BATCH();

  const items = [];
  const seen = new Set();
  const state = { total: null, ended: false, reason: null, pages: 0 };

  function absorb(pageData, number) {
    state.pages++;

    if (!pageData.items.length) {
      state.ended = true;
      return false;
    }

    let added = 0;
    for (const item of pageData.items) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
      added++;
    }

    if (added === 0) {
      state.reason =
        "page " + number + " repeated existing records (Worker may ignore the page parameter)";
      return false;
    }

    if (state.total !== null && items.length >= state.total) {
      state.ended = true;
      return false;
    }

    return true;
  }

  const first = await fetchPage(1); // throws if the Worker is failing
  state.total = first.total;

  let keepGoing = absorb(first, 1);
  let next = 2;

  while (keepGoing && next <= maxPages) {
    if (Date.now() - started > budget) {
      state.reason = "time budget exceeded before page " + next;
      break;
    }

    const numbers = [];
    for (let n = next; n < next + batch && n <= maxPages; n++) numbers.push(n);

    const results = await Promise.all(
      numbers.map(n =>
        fetchPage(n).then(
          value => ({ value }),
          error => ({ error })
        )
      )
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].error) {
        state.reason =
          "Worker error on page " + numbers[i] + ": " + results[i].error.message;
        keepGoing = false;
        break;
      }
      if (!absorb(results[i].value, numbers[i])) {
        keepGoing = false;
        break;
      }
    }

    next += batch;
  }

  if (!state.ended && !state.reason) {
    state.reason = "MAX_PAGES (" + maxPages + ") reached before the end";
  }

  let complete = state.ended && !state.reason;

  if (complete && state.total !== null && items.length < state.total) {
    complete = false;
    state.reason = "loaded " + items.length + " of " + state.total + " records";
  }

  if (complete && items.length === 0) {
    complete = false;
    state.reason = "Worker returned no records";
  }

  if (complete && items.length < EXPECTED_MIN_ITEMS()) {
    complete = false;
    state.reason =
      "loaded " + items.length + " records, expected at least " + EXPECTED_MIN_ITEMS();
  }

  return {
    items,
    complete,
    reason: complete ? null : state.reason,
    total: state.total,
    pages: state.pages,
    ms: Date.now() - started
  };
}

/*
  Returns { items, complete, ... }.
  Only a COMPLETE catalog is stored. If a rebuild fails or is incomplete,
  the last complete catalog (if recent) is used; otherwise the partial result
  is served for this one request only and is never cached as complete.
*/
async function loadAll(force = false) {
  if (!force && snapshot && Date.now() - snapshot.time < CATALOG_TTL_MS()) {
    return snapshot;
  }

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const built = await buildCatalog();

      if (built.complete) {
        snapshot = { ...built, time: Date.now() };
        return snapshot;
      }

      if (snapshot && Date.now() - snapshot.time < STALE_MS()) {
        return { ...snapshot, stale: true, refreshError: built.reason };
      }

      return { ...built, time: Date.now() };
    } catch (error) {
      if (snapshot && Date.now() - snapshot.time < STALE_MS()) {
        return { ...snapshot, stale: true, refreshError: error.message };
      }
      throw error;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

async function findInCatalog(id) {
  const { items } = await loadAll();
  const bare = withoutPrefix(id);
  return items.find(item => withoutPrefix(item.id) === bare) || null;
}

// Try the id with and without the "ctg:" prefix
async function fetchFromWorker(endpoint, stremioId) {
  const candidates = [...new Set([stremioId, withoutPrefix(stremioId)])];
  let lastError = null;

  for (const id of candidates) {
    try {
      const data = await getJSON(
        "/" + endpoint + "?id=" + encodeURIComponent(id)
      );

      const ok =
        data &&
        ((Array.isArray(data.streams) && data.streams.length) ||
          data.item ||
          data.meta ||
          data.id ||
          data.name ||
          data.title);

      if (ok) return data;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}

/*
  Look an item up from several sources in order; if one fails
  (e.g. Worker HTTP 500) the next is used. The catalog is the last resort.
*/
async function loadItem(baseId, order, strict, lenient) {
  let lastError = null;
  let reached = false;
  let fallback = null;

  for (const name of order) {
    try {
      const raw =
        name === "catalog"
          ? await findInCatalog(baseId)
          : await fetchFromWorker(name, baseId);

      reached = true;
      if (!raw) continue;

      const src = raw.item || raw.meta || raw;
      const result = { raw, src, item: normalize(src) };

      if (strict(result)) return result;
      if (lenient && !fallback && lenient(result)) fallback = result;
    } catch (error) {
      lastError = error;
    }
  }

  if (fallback) return fallback;
  if (!reached && lastError) throw lastError;
  return null;
}

/* ---------------- meta / episodes / streams ---------------- */

function epNumbers(ep, index) {
  const season = Number(ep.s ?? ep.season ?? 1);
  const episode = Number(ep.e ?? ep.episode ?? index + 1);

  return {
    season: Number.isFinite(season) ? season : 1,
    episode: Number.isFinite(episode) ? episode : index + 1
  };
}

function epLinks(ep) {
  let links = parseArray(ep.links);
  if (!links.length) links = parseArray(ep.streams);
  if (!links.length && (ep.url || ep.streamUrl)) links = [ep];
  return links;
}

function toMeta(raw, full = false) {
  const item = normalize(raw);
  const series = isSeries(item);

  const meta = {
    id: withPrefix(item.id),
    type: series ? "series" : "movie",
    name: item.name,
    poster: item.poster || item.poster_url || item.posterUrl || item.image || undefined,
    background: item.backdrop || item.background || item.backdrop_url || undefined,
    description: item.overview || item.description || item.plot || undefined,
    releaseInfo: item.year != null && item.year !== "" ? String(item.year) : undefined,
    genres: item.genres,
    imdbRating: item.rating != null && item.rating !== "" ? String(item.rating) : undefined
  };

  // Episode list only on the meta page (keeps catalog responses small)
  if (full && series && item.episodes.length) {
    meta.videos = item.episodes
      .map((ep, index) => {
        const { season, episode } = epNumbers(ep, index);

        return {
          id: meta.id + ":" + season + ":" + episode,
          title: ep.name || ep.title || "Episode " + episode,
          season,
          episode,
          released: ep.air_date || ep.released || undefined,
          thumbnail: ep.still || ep.thumbnail || undefined
        };
      })
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
  }

  return meta;
}

// Accepts: [{url,lang}], ["https://..."], {en: "https://..."}, JSON strings
function subList(value) {
  const parsed = parseJSON(value, []);
  let entries = [];

  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === "object") {
    if (parsed.url || parsed.src || parsed.file) {
      entries = [parsed];
    } else {
      entries = Object.entries(parsed)
        .filter(([, v]) => typeof v === "string")
        .map(([lang, url]) => ({ lang, url }));
    }
  }

  return entries
    .map(sub => (typeof sub === "string" ? { url: sub } : sub))
    .filter(sub => sub && typeof sub === "object")
    .map(sub => ({
      url: sub.url || sub.src || sub.file,
      lang: sub.lang || sub.language || sub.label || "und",
      id: sub.id
    }))
    .filter(sub => sub.url);
}

function streamList(links, extraSubs = []) {
  const streams = [];
  const seenUrls = new Set();

  for (let link of parseArray(links)) {
    if (typeof link === "string") link = { url: link };
    if (!link || typeof link !== "object") continue;

    const url = link.url || link.streamUrl || link.link || link.href;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const subs = [
      ...subList(link.subs),
      ...subList(link.subtitles),
      ...subList(link.subtitle),
      ...extraSubs
    ];

    const seenSubs = new Set();
    const subtitles = [];
    for (const sub of subs) {
      if (seenSubs.has(sub.url)) continue;
      seenSubs.add(sub.url);
      subtitles.push({
        id: String(sub.id || sub.lang + ":" + sub.url),
        url: sub.url,
        lang: sub.lang
      });
    }

    const stream = {
      name: link.source || link.quality || "CTGMovies",
      title: [link.quality, link.source].filter(Boolean).join(" • ") || "Play",
      url
    };

    if (subtitles.length) stream.subtitles = subtitles;
    if (/^http:\/\//i.test(url)) stream.behaviorHints = { notWebReady: true };

    streams.push(stream);
  }

  return streams;
}

function itemSubs(source) {
  return [...subList(source.subs), ...subList(source.subtitles)];
}

function sendJSON(res, body, status = 200, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  return res.end(JSON.stringify(body));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* ---------------- handler ---------------- */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") {
    return sendJSON(res, { error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url, "https://ctgmovies-stremio-100.vercel.app");
  const pathname = url.pathname;

  try {
    if (pathname === "/" || pathname === "/manifest.json") {
      const extra = [{ name: "search" }, { name: "skip" }];

      return sendJSON(res, {
        id: "com.mhthe1.ctgmovies.bridge",
        version: "4.0.0",
        name: "CTGMovies",
        description: "CTGMovies catalog and streams",
        resources: ["catalog", "meta", "stream"],
        types: ["movie", "series"],
        catalogs: [
          { type: "movie", id: "ctg_movies", name: "CTGMovies Movies", extra },
          { type: "series", id: "ctg_tv", name: "CTGMovies TV", extra },
          { type: "series", id: "ctg_anime", name: "CTGMovies Anime", extra }
        ],
        idPrefixes: [PREFIX]
      });
    }

    if (pathname === "/health") {
      try {
        return sendJSON(res, {
          ok: true,
          service: "CTGMovies Vercel API",
          worker: await getJSON("/", 0)
        });
      } catch (error) {
        return sendJSON(res, {
          ok: false,
          service: "CTGMovies Vercel API",
          message: error.message
        });
      }
    }

    // Use this to verify the real Worker pagination:
    //   /debug            -> loads (or reuses) the catalog and reports
    //   /debug?refresh=1  -> forces a fresh load from the Worker
    if (pathname === "/debug") {
      if (url.searchParams.get("refresh")) {
        snapshot = null;
        for (const key of [...cache.keys()]) {
          if (key.startsWith("/movies")) cache.delete(key);
        }
      }

      const result = await loadAll();
      const byKind = {};
      let movies = 0, tv = 0, anime = 0;

      for (const item of result.items) {
        byKind[item.kind] = (byKind[item.kind] || 0) + 1;
        if (isAnime(item)) anime++;
        else if (isSeries(item)) tv++;
        else movies++;
      }

      return sendJSON(res, {
        complete: result.complete,
        reason: result.reason || result.refreshError || null,
        stale: Boolean(result.stale),
        loaded: result.items.length,
        workerReportedTotal: result.total,
        pagesFetched: result.pages,
        loadMs: result.ms,
        catalogs: { movies, tv, anime },
        byKind,
        firstId: result.items[0] && result.items[0].id,
        lastId: result.items.length && result.items[result.items.length - 1].id
      });
    }

    if (pathname === "/status") {
      try {
        return sendJSON(res, { ok: true, database: await getJSON("/db") });
      } catch (error) {
        return sendJSON(res, { ok: false, message: error.message });
      }
    }

    // /catalog/movie/ctg_movies.json
    // /catalog/movie/ctg_movies/skip=100.json
    // /catalog/movie/ctg_movies/search=abc.json
    // /catalog/movie/ctg_movies/search=abc&skip=100.json
    const catalogMatch = pathname.match(
      /^\/catalog\/(movie|series)\/([^/]+)(?:\/([^/]+))?\.json$/
    );

    if (catalogMatch) {
      const type = catalogMatch[1];
      const catalogId = safeDecode(catalogMatch[2]);

      const extra = new URLSearchParams(safeDecode(catalogMatch[3] || ""));
      const param = name => extra.get(name) ?? url.searchParams.get(name);

      const rawSkip = Number(param("skip") || 0);
      const skip = Number.isFinite(rawSkip) ? Math.max(0, rawSkip) : 0;
      const search = String(param("search") || "").trim().toLowerCase();

      const result = await loadAll();

      const filtered = result.items.filter(item => {
        if (!item.id || !matchesCatalog(item, type, catalogId)) return false;
        if (search) {
          const haystack = [item.name, item.title, item.original_title, item.year]
            .filter(v => v != null)
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });

      return sendJSON(
        res,
        { metas: filtered.slice(skip, skip + PAGE_SIZE).map(item => toMeta(item)) },
        200,
        { "X-Catalog-Complete": String(Boolean(result.complete)) }
      );
    }

    const metaMatch = pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    const streamMatch = pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);

    if (metaMatch || streamMatch) {
      const match = metaMatch || streamMatch;
      const requestedId = safeDecode(match[2]);
      const parts = requestedId.split(":");

      // Episode id: ctg:123:1:2  (prefix : id : season : episode)
      const episodeRequest =
        match[1] === "series" &&
        parts.length >= 3 &&
        /^\d+$/.test(parts[parts.length - 2]) &&
        /^\d+$/.test(parts[parts.length - 1]);

      const baseId = episodeRequest
        ? parts.slice(0, -2).join(":")
        : requestedId;

      /* ----- META ----- */
      if (metaMatch) {
        const hasIdentity = r =>
          Boolean(r.src && (r.src.id || r.src.name || r.src.title));

        const result = await loadItem(
          baseId,
          ["meta", "stream", "catalog"],
          r =>
            hasIdentity(r) &&
            (!isSeries(r.item) || r.item.episodes.length > 0),
          hasIdentity
        );

        if (!result) {
          return sendJSON(res, { error: "Item not found" }, 404);
        }

        return sendJSON(res, { meta: toMeta(result.src, true) });
      }

      /* ----- STREAM ----- */
      const result = await loadItem(
        baseId,
        ["stream", "meta", "catalog"],
        r =>
          episodeRequest
            ? r.item.episodes.length > 0
            : r.item.links.length > 0 ||
              r.item.episodes.length > 0 ||
              (Array.isArray(r.raw.streams) && r.raw.streams.length > 0),
        null
      );

      if (!result) {
        return sendJSON(res, { streams: [] });
      }

      if (
        !episodeRequest &&
        Array.isArray(result.raw.streams) &&
        result.raw.streams.length
      ) {
        return sendJSON(res, { streams: result.raw.streams });
      }

      const item = result.item;
      let links = item.links;
      let subs = itemSubs(item);

      if (episodeRequest) {
        const season = Number(parts[parts.length - 2]);
        const episode = Number(parts[parts.length - 1]);

        let selected = item.episodes.find((ep, index) => {
          const n = epNumbers(ep, index);
          return n.season === season && n.episode === episode;
        });

        // Data without season info: use position in the list
        if (!selected && season === 1 && item.episodes[episode - 1]) {
          selected = item.episodes[episode - 1];
        }

        links = selected ? epLinks(selected) : [];
        if (selected) subs = [...itemSubs(selected), ...subs];
      } else if (item.episodes.length && !links.length) {
        links = item.episodes.flatMap(ep => epLinks(ep));
      }

      return sendJSON(res, { streams: streamList(links, subs) });
    }

    return sendJSON(res, { error: "Not found", path: pathname }, 404);
  } catch (error) {
    console.error("CTGMovies API error:", error);

    return sendJSON(res, {
      error: "CTGMovies API failed",
      message: error && error.message ? error.message : "Unknown error"
    }, 503);
  }
};
