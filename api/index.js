
const WORKER = "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";
const PAGE_SIZE = 100;
const CACHE_MS = 60_000;

let pageCache = new Map();
let cacheTime = 0;

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

async function workerPage(page) {
  const cached = pageCache.get(page);
  if (cached && Date.now() - cacheTime < CACHE_MS) return cached;

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      let response;
      try {
        response = await fetch(
          `${WORKER}/movies?page=${page}&limit=${PAGE_SIZE}`,
          {
            headers: { Accept: "application/json" },
            signal: controller.signal
          }
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`Worker HTTP ${response.status}, page ${page}`);
      }

      const data = await response.json();
      if (!Array.isArray(data.items)) {
        throw new Error(`Invalid Worker response on page ${page}`);
      }

      const items = data.items.map(normalize);
      pageCache.set(page, items);
      cacheTime = Date.now();
      return items;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }

  throw lastError || new Error(`Worker failed on page ${page}`);
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
      title: ep.name || `Episode ${ep.e || ""}`,
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
      e => Number(e.s || 1) === Number(season) &&
           Number(e.e || 1) === Number(episode)
    );
    if (!ep) return [];
    links = parseJSON(ep.links, []);
  } else if (item.episodes.length && !links.length) {
    links = item.episodes.flatMap(ep => parseJSON(ep.links, []));
  }

  return links
    .filter(link => link && (link.url || link.streamUrl))
    .map(link => ({
      name: link.source || link.quality || "CTGMovies",
      title: [link.quality, link.source].filter(Boolean).join(" • ") || "Play",
      url: link.url || link.streamUrl,
      subtitles: Array.isArray(link.subs)
        ? link.subs
            .filter(sub => sub && (sub.url || sub.url))
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

  const pathname = new URL(
    req.url,
    "https://ctgmovies-stremio-100.vercel.app"
  ).pathname;

  try {
    if (pathname === "/" || pathname === "/manifest.json") {
      return sendJSON(res, {
        id: "com.mhthe1.ctgmovies.bridge",
        version: "3.3.0",
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
      const items = await workerPage(1);
      return sendJSON(res, {
        ok: true,
        worker: "connected",
        firstPageItems: items.length
      });
    }

    const catalogMatch = pathname.match(
      /^\/catalog\/(movie|series)\/([^/]+)\.json$/
    );

    if (catalogMatch) {
      const type = catalogMatch[1];
      const catalogId = catalogMatch[2];
      const url = new URL(req.url, "https://local.invalid");
      const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));
      const requested = Math.min(PAGE_SIZE, 100);
      const wanted = skip + requested;

      const matches = [];
      const seen = new Set();

      // Fetch sequentially to avoid simultaneous Worker requests.
      // Stop once this catalog page has enough matching records.
      for (let page = 1; page <= 150 && matches.length < wanted; page++) {
        const items = await workerPage(page);

        if (!items.length) break;

        for (const item of items) {
          if (
            item.id &&
            !seen.has(item.id) &&
            matchesCatalog(item, type, catalogId)
          ) {
            seen.add(item.id);
            matches.push(item);
          }
        }

        if (items.length < PAGE_SIZE) break;
      }

      return sendJSON(res, {
        metas: matches.slice(skip, skip + requested).map(toMeta)
      });
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
      const baseId = parts.length >= 4
        ? parts.slice(0, -2).join(":")
        : requestedId;

      let found = null;

      // Search cached/remote pages without concurrent requests.
      for (let page = 1; page <= 150 && !found; page++) {
        const items = await workerPage(page);
        if (!items.length) break;

        found = items.find(item =>
          item.id === requestedId || item.id === baseId
        );

        if (items.length < PAGE_SIZE) break;
      }

      if (!found) {
        return sendJSON(res, { error: "Item not found", id: requestedId }, 404);
      }

      if (metaMatch) {
        return sendJSON(res, { meta: toMeta(found) });
      }

      const season = parts.length >= 3 ? parts[parts.length - 2] : null;
      const episode = parts.length >= 3 ? parts[parts.length - 1] : null;

      return sendJSON(res, {
        streams: extractStreams(
          found,
          season != null ? Number(season) : null,
          episode != null ? Number(episode) : null
        )
      });
    }

    return sendJSON(res, {
      error: "Not found",
      path: pathname
    }, 404);
  } catch (error) {
    return sendJSON(res, {
      error: "CTGMovies API failed",
      message: error && error.message ? error.message : "Unknown error"
    }, 503);
  }
};
