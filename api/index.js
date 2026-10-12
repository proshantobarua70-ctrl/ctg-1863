```js
const WORKER = "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";
const PAGE_SIZE = 100;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 8000;

const cache = new Map();

function parseJSON(value, fallback = []) {
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalize(item) {
  return {
    ...item,
    name: item.name || item.title || "Unknown",
    kind: String(item.kind || item.type || "movie").toLowerCase(),
    episodes: parseJSON(item.episodes, []),
    links: parseJSON(item.links, []),
    genres: parseJSON(item.genres, [])
  };
}

async function getJSON(path) {
  const key = path;
  const cached = cache.get(key);

  if (cached && Date.now() - cached.time < CACHE_MS) {
    return cached.data;
  }

  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${WORKER}${path}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Worker HTTP ${response.status}`);
      }

      const data = await response.json();
      cache.set(key, { data, time: Date.now() });
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
    `/movies?page=${page}&limit=${PAGE_SIZE}`
  );

  if (!Array.isArray(data.items)) {
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

function matchesCatalog(item, type, id) {
  if (id === "ctg_anime") return isAnime(item);
  if (id === "ctg_tv") return isSeries(item) && !isAnime(item);
  if (id === "ctg_movies") return !isSeries(item);
  return type === "series" ? isSeries(item) : !isSeries(item);
}

function toMeta(item) {
  const series = isSeries(item);

  const meta = {
    id: item.id,
    type: series ? "series" : "movie",
    name: item.name,
    poster: item.poster || undefined,
    background: item.backdrop || item.background || undefined,
    description: item.overview || item.description || undefined,
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: Array.isArray(item.genres) ? item.genres : [],
    imdbRating: item.rating != null ? String(item.rating) : undefined
  };

  if (series && item.episodes.length) {
    meta.videos = item.episodes.map(ep => ({
      id: `${item.id}:${ep.s || 1}:${ep.e || 1}`,
      title: ep.name || `Episode ${ep.e || 1}`,
      season: Number(ep.s || 1),
      episode: Number(ep.e || 1),
      thumbnail: ep.still || undefined
    }));
  }

  return meta;
}

function extractStreams(item, season, episode) {
  let links = parseJSON(item.links, []);

  if (season != null && episode != null) {
    const ep = item.episodes.find(
      e =>
        Number(e.s || 1) === Number(season) &&
        Number(e.e || 1) === Number(episode)
    );

    if (!ep) return [];
    links = parseJSON(ep.links, []);
  } else if (item.episodes.length && !links.length) {
    links = item.episodes.flatMap(ep =>
      parseJSON(ep.links, [])
    );
  }

  return links
    .filter(link => link && (link.url || link.streamUrl))
    .map(link => ({
      name: link.source || link.quality || "CTGMovies",
      title:
        [link.quality, link.source].filter(Boolean).join(" • ") ||
        "Play",
      url: link.url || link.streamUrl,
      subtitles: Array.isArray(link.subs)
        ? link.subs
            .filter(sub => sub && sub.url)
            .map(sub => ({
              id: sub.id || sub.lang || sub.url,
              url: sub.url,
              lang: sub.lang || sub.language || "Unknown"
            }))
        : []
    }));
}

function sendJSON(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30");
  res.end(JSON.stringify(body));
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

  const url = new URL(
    req.url,
    "https://ctgmovies-stremio-100.vercel.app"
  );
  const pathname = url.pathname;

  try {
    if (pathname === "/" || pathname === "/manifest.json") {
      return sendJSON(res, {
        id: "com.mhthe1.ctgmovies.bridge",
        version: "3.4.0",
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
      return sendJSON(res, { ok: true, worker: data });
    }

    const catalogMatch = pathname.match(
      /^\/catalog\/(movie|series)\/([^/]+)\.json$/
    );

    if (catalogMatch) {
      const type = catalogMatch[1];
      const catalogId = catalogMatch[2];
      const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));

      // Fetch only the source page corresponding to this request.
      // This avoids scanning the entire database on every catalog request.
      const page = Math.floor(skip / PAGE_SIZE) + 1;
      const items = await workerPage(page);

      const metas = items
        .filter(item => item.id && matchesCatalog(item, type, catalogId))
        .map(toMeta);

      return sendJSON(res, { metas });
    }

    const metaMatch = pathname.match(
      /^\/meta\/(movie|series)\/(.+)\.json$/
    );

    const streamMatch = pathname.match(
      /^\/stream\/(movie|series)\/(.+)\.json$/
    );

    if (metaMatch || streamMatch) {
      const match = metaMatch || streamMatch;
      const requestedId = decodeURIComponent(match[2]);
      const parts = requestedId.split(":");
      const episodeRequest = parts.length >= 3;
      const baseId = episodeRequest
        ? parts.slice(0, -2).join(":")
        : requestedId;

      // Use the Worker detail endpoints rather than scanning up to
      // 15,000 catalog records to find one item.
      const endpoint = metaMatch ? "meta" : "stream";
      const data = await getJSON(
        `/${endpoint}?id=${encodeURIComponent(baseId)}`
      );

      if (metaMatch) {
        const item = data.item || data.meta || data;
        if (!item || !(item.id || item.name)) {
          return sendJSON(res, { error: "Item not found" }, 404);
        }
        return sendJSON(res, { meta: toMeta(normalize(item)) });
      }

      const item = normalize(data.item || data);
      const season = episodeRequest ? Number(parts[parts.length - 2]) : null;
      const episode = episodeRequest ? Number(parts[parts.length - 1]) : null;

      // If Worker returns ready-made streams, use them.
      if (Array.isArray(data.streams)) {
        return sendJSON(res, { streams: data.streams });
      }

      return sendJSON(res, {
        streams: extractStreams(item, season, episode)
      });
    }

    return sendJSON(res, { error: "Not found", path: pathname }, 404);
  } catch (error) {
    return sendJSON(res, {
      error: "CTGMovies API failed",
      message: error && error.message
        ? error.message
        : "Unknown error"
    }, 503);
  }
};
```
