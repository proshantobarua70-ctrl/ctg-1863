
const API = "https://ctgmovies-api-new.proshantobarua041.workers.dev";
const PAGE = 100;

const manifest = {
  id: "com.mhthe1.ctgmovies.bridge",
  version: "3.1.0",
  name: "CTGMovies Bridge",
  description: "CTGMovies Stremio Addon",
  logo: "https://dhakastremio.mehedihtanvir.me/icon.svg",
  resources: [
    "catalog",
    { name: "meta", types: ["movie", "series"], idPrefixes: ["ctg:"] },
    { name: "stream", types: ["movie", "series"], idPrefixes: ["ctg:"] }
  ],
  types: ["movie", "series"],
  catalogs: [
    { type: "movie", id: "ctg_movies", name: "CTGMovies Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "ctg_tv", name: "CTGMovies TV Shows",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "ctg_anime", name: "CTGMovies Anime",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

const kinds = {
  ctg_movies: "movies",
  ctg_tv: "tv",
  ctg_anime: "anime"
};

let cache;
let cacheTime = 0;

async function getItems() {
  if (cache && Date.now() - cacheTime < 60000) return cache;

  const all = [];
  const seen = new Set();
  const pageSize = 50;

  for (let skip = 0; skip < 100000; skip += pageSize) {
    const r = await fetch(`${API}/movies?skip=${skip}`);
    if (!r.ok) throw new Error(`Worker HTTP ${r.status}`);

    const data = await r.json();
    const page = Array.isArray(data.items) ? data.items : [];

    for (const item of page) {
      if (item.id && !seen.has(item.id)) {
        seen.add(item.id);
        all.push(item);
      }
    }

    if (page.length < pageSize) break;
  }

  cache = all;
  cacheTime = Date.now();
  return cache;
}

function parseExtra(s) {
  const out = {};
  for (const part of (s || "").split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try {
      out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
    } catch {}
  }
  return out;
}

function card(item) {
  return {
    id: item.id,
    type: item.kind === "movies" ? "movie" : "series",
    name: item.name,
    poster: item.poster || undefined,
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

async function catalog(id, extra) {
  const kind = kinds[id];
  if (!kind) return { metas: [] };

  let items = (await getItems()).filter(x => x.kind === kind);

  if (extra.search) {
    const q = extra.search.toLowerCase();
    items = items.filter(x => String(x.name || "").toLowerCase().includes(q));
  }

  const skip = Math.max(0, parseInt(extra.skip || "0", 10) || 0);
  return { metas: items.slice(skip, skip + PAGE).map(card) };
}

async function meta(id) {
  const item = (await getItems()).find(x => x.id === id);
  if (!item) return { meta: null };

  const result = {
    id: item.id,
    type: item.kind === "movies" ? "movie" : "series",
    name: item.name,
    poster: item.poster || undefined,
    background: item.backdrop || undefined,
    description: item.overview || undefined,
    releaseInfo: item.year ? String(item.year) : undefined,
    imdbRating: item.rating ? String(item.rating) : undefined
  };

  if (item.kind !== "movies") {
    result.videos = (item.episodes || []).map(ep => ({
      id: `${item.id}:${ep.s}:${ep.e}`,
      title: ep.name || `Episode ${ep.e}`,
      season: ep.s,
      episode: ep.e,
      overview: ep.overview,
      thumbnail: ep.still,
      released: ep.air ? new Date(ep.air).toISOString() : new Date(0).toISOString()
    }));
  }

  return { meta: result };
}

function makeStreams(links) {
  return (Array.isArray(links) ? links : [])
    .filter(x => x && typeof x.url === "string" && x.url)
    .map(x => ({
      name: `CTGMovies\n${x.quality || "Direct"}`,
      title: `${x.quality || "Direct"} (${x.source || "Server"})`,
      url: x.url,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: { Referer: "https://ctgmovies.com/" }
        }
      }
    }));
}

async function stream(id) {
  const items = await getItems();

  const movie = items.find(x => x.id === id && x.kind === "movies");
  if (movie) return { streams: makeStreams(movie.links) };

  for (const item of items) {
    if (item.kind === "movies") continue;
    const ep = (item.episodes || []).find(
      x => `${item.id}:${x.s}:${x.e}` === id
    );
    if (ep) return { streams: makeStreams(ep.links) };
  }

  return { streams: [] };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(204).end();

  const parts = decodeURIComponent((req.url || "/").split("?")[0])
    .replace(/\.json$/, "").split("/").filter(Boolean);

  const resource = parts[0];
  const type = parts[1];
  const id = parts[2];
  const extra = parseExtra(parts[3]);

  try {
    if (!resource || resource === "manifest") {
      return res.status(200).json(manifest);
    }
    if (resource === "status") {
      const items = await getItems();
      return res.status(200).json({
        api: API,
        items: items.length,
        movies: items.filter(x => x.kind === "movies").length,
        tv: items.filter(x => x.kind === "tv").length,
        anime: items.filter(x => x.kind === "anime").length
      });
    }
    if (resource === "catalog") return res.status(200).json(await catalog(id, extra));
    if (resource === "meta") return res.status(200).json(await meta(id));
    if (resource === "stream") return res.status(200).json(await stream(id, type));

    return res.status(404).json({ error: "not found" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: e.message,
      ...(resource === "stream" ? { streams: [] } : {})
    });
  }
};
