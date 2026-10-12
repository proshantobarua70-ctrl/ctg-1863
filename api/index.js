```js
const WORKER = "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";
const PAGE_SIZE = 100;
const CACHE_MS = 60000;
const TIMEOUT_MS = 10000;
const cache = new Map();

function parseJSON(value, fallback = []) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalize(raw = {}) {
  const item = { ...raw };
  item.id = item.id == null ? "" : String(item.id);
  item.name = item.name || item.title || "Unknown";
  item.kind = String(item.kind || item.type || "movie").toLowerCase();
  item.episodes = parseJSON(item.episodes, []);
  item.links = parseJSON(item.links, []);
  item.genres = parseJSON(item.genres, []);
  return item;
}

async function getJSON(path) {
  const cached = cache.get(path);
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.data;

  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(WORKER + path, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      if (!response.ok) throw new Error("Worker HTTP " + response.status);

      const data = await response.json();
      cache.set(path, { data, time: Date.now() });
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Worker request failed");
}

async function workerPage(page) {
  const data = await getJSON(
    "/movies?page=" + page + "&limit=" + PAGE_SIZE
  );

  if (!data || !Array.isArray(data.items)) {
    throw new Error("Invalid Worker movies response");
  }

  return data.items.map(normalize);
}

function isAnime(item) {
  return item.kind === "anime";
}

function isSeries(item) {
  return ["tv", "series", "anime"].includes(item.kind);
}

function matchesCatalog(item, type, catalogId) {
  if (catalogId === "ctg_anime") return isAnime(item);
  if (catalogId === "ctg_tv") return isSeries(item) && !isAnime(item);
  if (catalogId === "ctg_movies") return !isSeries(item);
  return type === "series" ? isSeries(item) : !isSeries(item);
}

function toMeta(raw) {
  const item = normalize(raw);
  const series = isSeries(item);

  const meta = {
    id: item.id,
    type: series ? "series" : "movie",
    name: item.name,
    poster: item.poster || undefined,
    background: item.backdrop || item.background || undefined,
    description: item.overview || item.description || undefined,
    releaseInfo: item.year != null ? String(item.year) : undefined,
    genres: Array.isArray(item.genres) ? item.genres : [],
    imdbRating: item.rating != null ? String(item.rating) : undefined
  };

  if (series && item.episodes.length) {
    meta.videos = item.episodes.map((ep, index) => {
      const season = Number(ep.s || 1);
      const episode = Number(ep.e || index + 1);

      return {
        id: item.id + ":" + season + ":" + episode,
        title: ep.name || "Episode " + episode,
        season: season,
        episode: episode,
        thumbnail: ep.still || undefined
      };
    });
  }

  return meta;
}

function streamList(links) {
  return parseJSON(links, [])
    .filter(link => link && (link.url || link.streamUrl))
    .map(link => ({
      name: link.source || link.quality || "CTGMovies",
      title: [link.quality, link.source].filter(Boolean).join(" • ") || "Play",
      url: link.url || link.streamUrl,
      subtitles: parseJSON(link.subs, [])
        .filter(sub => sub && sub.url)
        .map(sub => ({
          id: String(sub.id || sub.lang || sub.url),
          url: sub.url,
          lang: sub.lang || sub.language || "Unknown"
        }))
    }));
}

function sendJSON(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30");
  return res.end(JSON.stringify(body));
}

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
      return sendJSON(res, {
        id: "com.mhthe1.ctgmovies.bridge",
        version: "3.6.0",
        name: "CTGMovies",
        description: "CTGMovies catalog and streams",
        resources: ["catalog", "meta", "stream"],
        types: ["movie", "series"],
        catalogs: [
          { type: "movie", id: "ctg_movies", name: "CTGMovies Movies" },
          { type: "series", id: "ctg_tv", name: "CTGMovies TV" },
          { type: "series", id: "ctg_anime", name: "CTGMovies Anime" }
        ],
        idPrefixes: ["ctg:"]
      });
    }

    if (pathname === "/health") {
      const data = await getJSON("/ping");
      return sendJSON(res, { ok: true, service: "CTGMovies Vercel API", worker: data });
    }

    const catalogMatch = pathname.match(
      /^\/catalog\/(movie|series)\/([^/]+)\.json$/
    );

    if (catalogMatch) {
      const type = catalogMatch[1];
      const catalogId = catalogMatch[2];
      const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));

      if (!Number.isFinite(skip)) return sendJSON(res, { metas: [] });

      const wanted = skip + PAGE_SIZE;
      const found = [];
      const seen = new Set();

      // Read sequential pages because each Worker page may mix content types.
      // Limit requests per invocation to avoid Vercel timeouts.
      for (let page = 1; page <= 15 && found.length < wanted; page++) {
        const items = await workerPage(page);
        if (!items.length) break;

        for (const item of items) {
          if (!item.id || !matchesCatalog(item, type, catalogId)) continue;
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          found.push(toMeta(item));
        }

        if (items.length < PAGE_SIZE) break;
      }

      return sendJSON(res, { metas: found.slice(skip, wanted) });
    }

    const metaMatch = pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    const streamMatch = pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);

    if (metaMatch || streamMatch) {
      const match = metaMatch || streamMatch;
      const requestedId = decodeURIComponent(match[2]);
      const parts = requestedId.split(":");
      const episodeRequest = parts.length >= 4 &&
        /^\d+$/.test(parts[parts.length - 2]) &&
        /^\d+$/.test(parts[parts.length - 1]);

      const baseId = episodeRequest ? parts.slice(0, -2).join(":") : requestedId;
      const endpoint = metaMatch ? "meta" : "stream";
      const data = await getJSON(
        "/" + endpoint + "?id=" + encodeURIComponent(baseId)
      );

      if (metaMatch) {
        const rawItem = data.meta || data.item || data;
        if (!rawItem || !(rawItem.id || rawItem.name || rawItem.title)) {
          return sendJSON(res, { error: "Item not found" }, 404);
        }
        return sendJSON(res, { meta: toMeta(rawItem) });
      }

      // The tested Worker /stream response contains the item's episodes.
      const rawItem = normalize(data.item || data.meta || data);
      let links = rawItem.links;

      if (episodeRequest) {
        const season = Number(parts[parts.length - 2]);
        const episode = Number(parts[parts.length - 1]);
        const selected = rawItem.episodes.find(ep =>
          Number(ep.s || 1) === season && Number(ep.e || 1) === episode
        );

        links = selected ? parseJSON(selected.links, []) : [];
      } else if (rawItem.episodes.length && !links.length) {
        links = rawItem.episodes.flatMap(ep => parseJSON(ep.links, []));
      }

      // Also support Workers that return a ready-made streams array.
      if (Array.isArray(data.streams)) {
        return sendJSON(res, { streams: data.streams });
      }

      return sendJSON(res, { streams: streamList(links) });
    }

    return sendJSON(res, { error: "Not found", path: pathname }, 404);
  } catch (error) {
    return sendJSON(res, {
      error: "CTGMovies API failed",
      message: error && error.message ? error.message : "Unknown error"
    }, 503);
  }
};
```
