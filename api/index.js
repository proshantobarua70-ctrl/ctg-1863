
const API = "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";
const PAGE_SIZE = 100;
const CACHE_MS = 60_000;

let cache = [];
let cacheTime = 0;
let loading = null;

function parseJSON(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalize(item) {
  return {
    ...item,
    kind: String(item.kind || item.type || "").toLowerCase(),
    name: item.name || item.title || "Unknown",
    episodes: parseJSON(item.episodes, []),
    links: parseJSON(item.links, []),
    genres: parseJSON(item.genres, [])
  };
}

async function workerPage(page) {
  const response = await fetch(
    `${API}/movies?page=${page}&limit=${PAGE_SIZE}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    }
  );

  if (!response.ok) {
    throw new Error(`Worker API HTTP ${response.status}, page ${page}`);
  }

  const data = await response.json();
  const items = Array.isArray(data) ? data : data.items;

  if (!Array.isArray(items)) {
    throw new Error(`Invalid Worker response on page ${page}`);
  }

  return items.map(normalize);
}

async function getItems() {
  if (cache.length && Date.now() - cacheTime < CACHE_MS) {
    return cache;
  }

  if (loading) return loading;

  loading = (async () => {
    const all = [];
    const seen = new Set();

    // Fetch pages in small parallel groups.
    // Stop when the Worker returns a short or empty page.
    for (let start = 1; start <= 200; start += 4) {
      const pages = await Promise.all(
        [start, start + 1, start + 2, start + 3].map(workerPage)
      );

      let finished = false;

      for (const items of pages) {
        if (!items.length) {
          finished = true;
          break;
        }

        for (const item of items) {
          if (item.id && !seen.has(String(item.id))) {
            seen.add(String(item.id));
            all.push(item);
          }
        }

        if (items.length < PAGE_SIZE) {
          finished = true;
          break;
        }
      }

      if (finished) break;
    }

    if (!all.length) {
      throw new Error("Worker returned no catalog items");
    }

    cache = all;
    cacheTime = Date.now();
    return all;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function isSeries(item) {
  return ["tv", "series", "anime"].includes(item.kind);
}

function toMeta(item) {
  return {
    id: String(item.id),
    type: isSeries(item) ? "series" : "movie",
    name: item.name,
    poster: item.poster || undefined,
    background: item.backdrop || undefined,
    description: item.overview || item.description || undefined,
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: Array.isArray(item.genres)
      ? item.genres
      : undefined,
    imdbRating: item.rating != null
      ? String(item.rating)
      : undefined
  };
}

function toStreams(links) {
  return (Array.isArray(links) ? links : [])
    .filter(link => link && (link.url || link.streamUrl))
    .map(link => ({
      name: link.source || link.server || "CTGMovies",
      title: link.quality || link.title || "Direct",
      url: link.url || link.streamUrl,
      subtitles: Array.isArray(link.subs)
        ? link.subs
            .filter(sub => sub && sub.url)
            .map((sub, i) => ({
              id: String(i),
              url: sub.url,
              lang: sub.label || sub.lang || "English"
            }))
        : undefined,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: { Referer: "https://ctgmovies.com/" }
        }
      }
    }));
}

function getCatalogKind(path) {
  if (path.includes("/catalog/movie/ctg_movies")) return "movies";
  if (path.includes("/catalog/series/ctg_tv")) return "tv";
  if (path.includes("/catalog/series/ctg_anime")) return "anime";
  return null;
}

module.exports = async function (req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const url = new URL(req.url, "https://example.com");
    const path = url.pathname.replace(/\/+$/, "");

    if (path.endsWith("/manifest.json")) {
      return res.status(200).json({
        id: "com.mhthe1.ctgmovies.bridge",
        version: "3.2.0",
        name: "CTGMovies",
        description: "CTGMovies catalog and streams",
        resources: ["catalog", "meta", "stream"],
        types: ["movie", "series"],
        catalogs: [
          {
            type: "movie",
            id: "ctg_movies",
            name: "CTGMovies Movies",
            extra: [{ name: "skip", isRequired: false }]
          },
          {
            type: "series",
            id: "ctg_tv",
            name: "CTGMovies TV",
            extra: [{ name: "skip", isRequired: false }]
          },
          {
            type: "series",
            id: "ctg_anime",
            name: "CTGMovies Anime",
            extra: [{ name: "skip", isRequired: false }]
          }
        ]
      });
    }

    const catalogKind = getCatalogKind(path);
    const metaMatch = path.match(/\/meta\/(movie|series)\/(.+)\.json$/);
    const streamMatch = path.match(/\/stream\/(movie|series)\/(.+)\.json$/);

    if (!catalogKind && !metaMatch && !streamMatch) {
      return res.status(200).json({
        ok: true,
        service: "CTGMovies Vercel API"
      });
    }

    const items = await getItems();

    if (catalogKind) {
      const skip = Math.max(
        0,
        Number.parseInt(url.searchParams.get("skip") || "0", 10) || 0
      );

      const filtered = items.filter(item => {
        if (catalogKind === "anime") return item.kind === "anime";
        if (catalogKind === "tv") return ["tv", "series"].includes(item.kind);
        return !["tv", "series", "anime"].includes(item.kind);
      });

      return res.status(200).json({
        metas: filtered.slice(skip, skip + PAGE_SIZE).map(toMeta)
      });
    }

    if (metaMatch) {
      const id = decodeURIComponent(metaMatch[2]);
      const item = items.find(x => String(x.id) === id);

      if (!item) return res.status(200).json({ meta: null });

      const meta = toMeta(item);

      if (isSeries(item)) {
        meta.videos = item.episodes.map(ep => ({
          id: `${item.id}:${ep.s || ep.season || 1}:${ep.e || ep.episode || 1}`,
          title: ep.name || ep.title ||
            `Episode ${ep.e || ep.episode || 1}`,
          season: Number(ep.s || ep.season || 1),
          episode: Number(ep.e || ep.episode || 1),
          thumbnail: ep.still || undefined
        }));
      }

      return res.status(200).json({ meta });
    }

    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[2]);
      const parts = id.split(":");
      const itemId = parts[0];
      const item = items.find(x => String(x.id) === itemId);

      if (!item) return res.status(200).json({ streams: [] });

      let links = item.links;

      if (parts.length >= 3 && isSeries(item)) {
        const season = Number(parts[1]);
        const episode = Number(parts[2]);

        const ep = item.episodes.find(x =>
          Number(x.s || x.season || 1) === season &&
          Number(x.e || x.episode || 1) === episode
        );

        links = ep ? parseJSON(ep.links, []) : [];
      }

      return res.status(200).json({
        streams: toStreams(links)
      });
    }

    return res.status(404).json({ error: "Route not found" });
  } catch (error) {
    console.error("CTGMovies API error:", error);

    return res.status(503).json({
      error: "CTGMovies API failed",
      message: error.message
    });
  }
};
