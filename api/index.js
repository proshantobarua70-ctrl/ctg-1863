// CTGMovies Stremio Bridge v7.0.0
// Architecture: Cloudflare Worker -> D1 -> Vercel -> Stremio

const WORKER = (
  process.env.CTG_WORKER_URL ||
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev"
).replace(/\/+$/, "");

const ADDON_ID = "com.mhthe1.ctgmovies.bridge";
const PAGE_SIZE = 100;
const WORKER_PAGE_SIZE = 100;
const MAX_WORKER_PAGES = 125;
const MAX_PAGES_PER_REQUEST = 20;
const CACHE_TTL = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 5000;

let itemsCache = [];
let itemsCacheTime = 0;
let nextWorkerPage = 1;
let exhausted = false;
let loadPromise = null;
let lastLoadError = null;

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(status).json(data);
}

function cleanId(value) {
  try {
    return decodeURIComponent(String(value || ""))
      .replace(/\.json$/i, "")
      .trim();
  } catch {
    return String(value || "")
      .replace(/\.json$/i, "")
      .trim();
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeKind(item) {
  const kind = String(item?.kind || item?.type || "")
    .trim()
    .toLowerCase();

  if (["movie", "movies", "film", "films"].includes(kind)) {
    return "movie";
  }

  if (
    [
      "tv",
      "series",
      "show",
      "shows",
      "tv_show",
      "tv-shows"
    ].includes(kind)
  ) {
    return "tv";
  }

  if (["anime", "animes"].includes(kind)) {
    return "anime";
  }

  return kind;
}

async function workerFetch(path) {
  const response = await fetch(`${WORKER}${path}`, {
    headers: {
      "User-Agent": "CTGMovies-Stremio-Bridge/7.0"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Worker returned invalid JSON (HTTP ${response.status}): ${text.slice(0, 180)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      `Worker HTTP ${response.status}: ${text.slice(0, 180)}`
    );
  }

  return data;
}

// Load only the pages needed for the requested catalog.
async function fetchNextWorkerPage() {
  if (exhausted || nextWorkerPage > MAX_WORKER_PAGES) {
    exhausted = true;
    return false;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    const page = nextWorkerPage;

    const data = await workerFetch(
      `/movies?page=${page}&limit=${WORKER_PAGE_SIZE}`
    );

    const batch = Array.isArray(data?.items)
      ? data.items
      : [];

    const seen = new Set(
      itemsCache.map(item => String(item?.id || ""))
    );

    for (const item of batch) {
      const id = String(item?.id || "");

      if (!id || seen.has(id)) continue;

      seen.add(id);
      itemsCache.push(item);
    }

    nextWorkerPage = page + 1;
    lastLoadError = null;
    itemsCacheTime = Date.now();

    if (
      batch.length < WORKER_PAGE_SIZE ||
      data?.hasMore === false
    ) {
      exhausted = true;
    }

    return batch.length > 0;
  })();

  try {
    return await loadPromise;
  } catch (error) {
    lastLoadError = error?.message || String(error);
    throw error;
  } finally {
    loadPromise = null;
  }
}

function catalogMatches(item, catalog, type) {
  const kind = normalizeKind(item);

  const matchesCatalog =
    (catalog === "ctg_movies" && kind === "movie") ||
    (catalog === "ctg_tv" && kind === "tv") ||
    (catalog === "ctg_anime" && kind === "anime");

  if (!matchesCatalog) return false;

  return kind === "movie"
    ? type === "movie"
    : type === "series";
}

async function ensureCatalogItems(
  catalog,
  type,
  search,
  wantedCount
) {
  let pagesThisRequest = 0;

  const getMatches = () =>
    itemsCache.filter(item =>
      catalogMatches(item, catalog, type) &&
      (
        !search ||
        String(item?.name || "")
          .toLowerCase()
          .includes(search)
      )
    );

  while (
    getMatches().length < wantedCount &&
    !exhausted &&
    pagesThisRequest < MAX_PAGES_PER_REQUEST
  ) {
    await fetchNextWorkerPage();
    pagesThisRequest++;
  }

  const items = getMatches();

  return {
    items,
    partial: items.length < wantedCount && !exhausted,
    pagesThisRequest,
    error: lastLoadError
  };
}

function makeManifest() {
  return {
    id: ADDON_ID,
    version: "7.0.0",
    name: "CTGMovies Bridge",
    description:
      "CTGMovies movies, TV shows and anime via Cloudflare Worker",

    logo: "https://dhakastremio.mehedihtanvir.me/icon.svg",

    resources: [
      "catalog",
      {
        name: "meta",
        types: ["movie", "series"],
        idPrefixes: ["ctg:"]
      },
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["ctg:"]
      }
    ],

    types: ["movie", "series"],

    catalogs: [
      {
        type: "movie",
        id: "ctg_movies",
        name: "CTGMovies Movies",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      },
      {
        type: "series",
        id: "ctg_tv",
        name: "CTGMovies TV Shows",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      },
      {
        type: "series",
        id: "ctg_anime",
        name: "CTGMovies Anime",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      }
    ],

    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

function toCatalogMeta(item) {
  const kind = normalizeKind(item);

  const meta = {
    id: item.id,
    type: kind === "movie" ? "movie" : "series",
    name: item.name || "Unknown"
  };

  if (item.poster) meta.poster = item.poster;
  if (item.backdrop) meta.background = item.backdrop;
  if (item.overview) meta.description = item.overview;

  if (item.year) {
    meta.releaseInfo = String(item.year);
  }

  if (item.rating != null) {
    meta.imdbRating = String(item.rating);
  }

  const genres = parseJsonArray(item.genres);

  if (genres.length) {
    meta.genres = genres;
  }

  return meta;
}

async function handleCatalog(path, url, res) {
  const parts = path.split("/").filter(Boolean);

  const type = parts[1] || "";
  const catalog = cleanId(parts[2] || "");

  const skip = Math.max(
    0,
    Math.min(
      100000,
      Number(url.searchParams.get("skip") || 0)
    )
  );

  const search = String(
    url.searchParams.get("search") || ""
  )
    .trim()
    .toLowerCase();

  if (
    !["movie", "series"].includes(type) ||
    !["ctg_movies", "ctg_tv", "ctg_anime"].includes(catalog)
  ) {
    return sendJson(res, 200, { metas: [] });
  }

  const result = await ensureCatalogItems(
    catalog,
    type,
    search,
    skip + PAGE_SIZE
  );

  const metas = result.items
    .slice(skip, skip + PAGE_SIZE)
    .map(toCatalogMeta);

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=60, stale-while-revalidate=300"
  );

  const output = { metas };

  if (url.searchParams.get("debug") === "1") {
    output._debug = {
      loaded: itemsCache.length,
      pagesFetched: nextWorkerPage - 1,
      exhausted,
      partial: result.partial,
      pagesThisRequest: result.pagesThisRequest,
      error: result.error
    };
  }

  return sendJson(res, 200, output);
}

function convertMeta(data, requestedId) {
  const id = data.id || requestedId;
  const kind = normalizeKind(data);

  const isMovie =
    kind === "movie" ||
    id.includes(":movie:") ||
    id.includes(":movies:");

  const type = isMovie ? "movie" : "series";

  const meta = {
    id,
    type,
    name: data.name || "CTGMovies"
  };

  if (data.poster) meta.poster = data.poster;
  if (data.backdrop) meta.background = data.backdrop;
  if (data.overview) meta.description = data.overview;

  if (data.year) {
    meta.releaseInfo = String(data.year);
  }

  if (data.rating != null) {
    meta.imdbRating = String(data.rating);
  }

  const genres = parseJsonArray(data.genres);

  if (genres.length) {
    meta.genres = genres;
  }

  if (type === "series") {
    meta.videos = parseJsonArray(data.episodes)
      .filter(ep =>
        Number.isFinite(Number(ep.s)) &&
        Number.isFinite(Number(ep.e))
      )
      .map(ep => ({
        id: `${id}:${Number(ep.s)}:${Number(ep.e)}`,
        title: ep.name || `Episode ${Number(ep.e)}`,
        season: Number(ep.s),
        episode: Number(ep.e),

        ...(ep.overview
          ? { overview: ep.overview }
          : {}),

        ...(ep.still
          ? { thumbnail: ep.still }
          : {}),

        ...(ep.air
          ? { released: `${ep.air}T00:00:00.000Z` }
          : {})
      }));
  }

  return { meta };
}

function parseStreamRequest(path, url) {
  const parts = path.split("/").filter(Boolean);
  const index = parts.indexOf("stream");

  const type = index >= 0
    ? parts[index + 1] || ""
    : "";

  let id = cleanId(parts[index + 2] || "");

  let season = null;
  let episode = null;

  const match = id.match(
    /^(ctg:(?:tv|anime|movie|movies):.+):(\d+):(\d+)$/
  );

  if (match) {
    id = match[1];
    season = Number(match[2]);
    episode = Number(match[3]);
  }

  if (url.searchParams.has("id")) {
    id = cleanId(url.searchParams.get("id"));
  }

  if (/^\d+$/.test(url.searchParams.get("season") || "")) {
    season = Number(url.searchParams.get("season"));
  }

  if (/^\d+$/.test(url.searchParams.get("episode") || "")) {
    episode = Number(url.searchParams.get("episode"));
  }

  return { type, id, season, episode };
}

function makeStreams(links) {
  return parseJsonArray(links)
    .filter(link =>
      link &&
      typeof link.url === "string" &&
      link.url
    )
    .map(link => {
      const stream = {
        name: "CTGMovies",

        title:
          `${link.quality || "Direct"}` +
          `${link.source ? ` • ${link.source}` : ""}`,

        url: link.url,

        behaviorHints: {
          bingeGroup: "ctgmovies"
        }
      };

      const subs = parseJsonArray(link.subs);

      if (subs.length) {
        stream.subtitles = subs
          .filter(sub => sub?.url)
          .map(sub => ({
            url: sub.url,
            lang: sub.label || "Unknown",
            label: sub.label || "Subtitle"
          }));
      }

      return stream;
    });
}

async function handleStream(path, url, res) {
  const request = parseStreamRequest(path, url);

  if (!request.id) {
    return sendJson(res, 200, { streams: [] });
  }

  const data = await workerFetch(
    `/stream?id=${encodeURIComponent(request.id)}`
  );

  const episodes = parseJsonArray(data.episodes);
  let links = [];

  if (request.type === "movie" || episodes.length === 0) {
    links = parseJsonArray(data.links);
  } else {
    const selected = episodes.find(ep =>
      Number(ep.s) === request.season &&
      Number(ep.e) === request.episode
    );

    links = parseJsonArray(selected?.links);
  }

  return sendJson(res, 200, {
    streams: makeStreams(links)
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const url = new URL(
      req.url,
      `https://${req.headers.host}`
    );

    const path = url.pathname;

    if (path === "/ping") {
      return sendJson(res, 200, {
        ok: true,
        service: "CTGMovies Vercel Bridge",
        version: "7.0.0",
        worker: WORKER,

        cache: {
          loaded: itemsCache.length,
          pagesFetched: nextWorkerPage - 1,
          exhausted,
          lastError: lastLoadError
        }
      });
    }

    if (path === "/manifest.json") {
      return sendJson(res, 200, makeManifest());
    }

    if (path.includes("/catalog/")) {
      return await handleCatalog(path, url, res);
    }

    if (path.includes("/meta/")) {
      const id = cleanId(
        path.split("/").filter(Boolean).pop()
      );

      const data = await workerFetch(
        `/stream?id=${encodeURIComponent(id)}`
      );

      return sendJson(res, 200, convertMeta(data, id));
    }

    if (path === "/stream" || path.includes("/stream/")) {
      return await handleStream(path, url, res);
    }

    if (
      path === "/movies" ||
      path === "/search" ||
      path === "/meta"
    ) {
      const data = await workerFetch(
        `${path}${url.search}`
      );

      return sendJson(res, 200, data);
    }

    if (path === "/debug") {
      return sendJson(res, 200, {
        ok: true,
        version: "7.0.0",
        worker: WORKER,
        loaded: itemsCache.length,
        pagesFetched: nextWorkerPage - 1,
        exhausted,
        lastError: lastLoadError,

        catalogs: {
          movies: itemsCache.filter(
            item => normalizeKind(item) === "movie"
          ).length,

          tv: itemsCache.filter(
            item => normalizeKind(item) === "tv"
          ).length,

          anime: itemsCache.filter(
            item => normalizeKind(item) === "anime"
          ).length
        }
      });
    }

    return sendJson(res, 404, {
      error: "Not found",
      path
    });
  } catch (error) {
    console.error("CTGMovies bridge error:", error);

    return sendJson(res, 502, {
      error: "Worker request failed",
      message: error?.message || String(error),
      streams: [],
      metas: []
    });
  }
};
