const API =
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

const PAGE = 100;

const manifest = {
  id: "com.mhthe1.ctgmovies.bridge",
  version: "3.0.0",
  name: "CTGMovies Bridge",
  description:
    "CTGMovies Stremio addon powered by Cloudflare D1.",
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

const CAT_KIND = {
  ctg_movies: "movies",
  ctg_tv: "tv",
  ctg_anime: "anime"
};

let cache = null;
let cacheTime = 0;

async function getItems() {
  if (cache && Date.now() - cacheTime < 60000) {
    return cache;
  }

  const r = await fetch(`${API}/movies`, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`Cloudflare API HTTP ${r.status}`);
  }

  const data = await r.json();

  cache = data.items || [];
  cacheTime = Date.now();

  return cache;
}

function typeOf(kind) {
  return kind === "movies" ? "movie" : "series";
}

function card(item) {
  return {
    id: item.id,
    type: typeOf(item.kind),
    name: item.name,
    poster: item.poster || undefined,
    releaseInfo:
      item.year != null ? String(item.year) : undefined
  };
}

function parseExtra(str) {
  const out = {};

  if (!str) return out;

  for (const part of str.split("&")) {
    const i = part.indexOf("=");

    if (i === -1) continue;

    const key = part.slice(0, i);
    const value = part.slice(i + 1);

    out[key] = decodeURIComponent(value);
  }

  return out;
}

async function catalog(id, extra) {
  const kind = CAT_KIND[id];

  if (!kind) {
    return { metas: [] };
  }

  let items = await getItems();

  items = items.filter(
    (item) => item.kind === kind
  );

  if (extra.search) {
    const q = extra.search.toLowerCase();

    items = items.filter((item) =>
      String(item.name || "")
        .toLowerCase()
        .includes(q)
    );
  }

  const skip =
    parseInt(extra.skip || "0", 10) || 0;

  return {
    metas: items
      .slice(skip, skip + PAGE)
      .map(card)
  };
}

async function meta(id) {
  const items = await getItems();

  const item = items.find(
    (x) => x.id === id
  );

  if (!item) {
    return { meta: null };
  }

  const result = {
    id: item.id,
    type: typeOf(item.kind),
    name: item.name,
    poster: item.poster || undefined,
    background: item.backdrop || undefined,
    description: item.overview || undefined,
    releaseInfo:
      item.year != null
        ? String(item.year)
        : undefined,
    imdbRating:
      item.rating != null
        ? String(item.rating)
        : undefined
  };

  if (item.kind !== "movies") {
    result.videos = (item.episodes || []).map(
      (ep) => ({
        id: `${item.id}:${ep.s}:${ep.e}`,
        title:
          ep.name ||
          `Episode ${ep.e}`,
        season: ep.s,
        episode: ep.e,
        overview: ep.overview,
        thumbnail: ep.still,
        released: ep.air
          ? new Date(ep.air).toISOString()
          : new Date(0).toISOString()
      })
    );
  }

  return {
    meta: result
  };
}

async function stream(id) {
  const items = await getItems();

  const item = items.find(
    (x) => x.id === id
  );

  if (!item) {
    return { streams: [] };
  }

  if (
    item.kind === "movies" &&
    Array.isArray(item.links)
  ) {
    return {
      streams: item.links
        .filter((x) => x.url)
        .map((x) => ({
          name:
            `CTGMovies\n${x.quality || "Direct"}`,
          title:
            `${x.quality || "Direct"} (${x.source || "Server"})`,
          url: x.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                Referer:
                  "https://ctgmovies.com/"
              }
            }
          }
        }))
    };
  }

  return {
    streams: []
  };
}

module.exports = async (req, res) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "*"
  );

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const parts = decodeURIComponent(
    (req.url || "/")
      .split("?")[0]
  )
    .replace(/\.json$/, "")
    .split("/")
    .filter(Boolean);

  const resource = parts[0];
  const type = parts[1];
  const id = parts[2];
  const extra = parseExtra(parts[3]);

  try {
    if (
      !resource ||
      resource === "manifest"
    ) {
      return res.status(200).json(
        manifest
      );
    }

    if (resource === "status") {
      const items = await getItems();

      const movies = items.filter(
        (x) => x.kind === "movies"
      ).length;

      const tv = items.filter(
        (x) => x.kind === "tv"
      ).length;

      const anime = items.filter(
        (x) => x.kind === "anime"
      ).length;

      return res.status(200).json({
        source: "Cloudflare D1",
        api: API,
        items: items.length,
        movies,
        tv,
        anime
      });
    }

    if (resource === "catalog") {
      return res.status(200).json(
        await catalog(id, extra)
      );
    }

    if (resource === "meta") {
      return res.status(200).json(
        await meta(id)
      );
    }

    if (resource === "stream") {
      return res.status(200).json(
        await stream(id, type)
      );
    }

    return res.status(404).json({
      error: "not found"
    });

  } catch (error) {
    console.error(error);

    if (resource === "catalog") {
      return res.status(200).json({
        metas: [],
        error: error.message
      });
    }

    if (resource === "stream") {
      return res.status(200).json({
        streams: [],
        error: error.message
      });
    }

    return res.status(500).json({
      error: error.message
    });
  }
};
