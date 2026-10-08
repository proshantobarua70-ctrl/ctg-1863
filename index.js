// CTGMovies Stremio addon
// Vercel -> Cloudflare Worker -> D1

const WORKER_API =
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev/movies";

const fs = require("fs");
const zlib = require("zlib");
const pathMod = require("path");

function loadLocalData() {
  try {
    return JSON.parse(
      zlib
        .gunzipSync(
          fs.readFileSync(
            pathMod.join(__dirname, "..", "data.json.gz")
          )
        )
        .toString()
    );
  } catch {}

  try {
    return require("../data.json");
  } catch {}

  return { items: [] };
}

let DATA = { items: [] };

async function loadData() {
  try {
    const r = await fetch(WORKER_API, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!r.ok) throw new Error(`Worker HTTP ${r.status}`);

    const json = await r.json();

    if (json && Array.isArray(json.items)) {
      return {
        items: json.items,
        updated: new Date().toISOString()
      };
    }
  } catch (e) {
    console.error("Worker API failed:", e.message);
  }

  // Temporary fallback
  return loadLocalData();
}

const LIVE_ON = false;
let LIVE = null;

try {
  LIVE = require("../live.js");
} catch {
  LIVE = null;
}

const PAGE = 100;

const manifest = {
  id: "com.mhthe1.ctgmovies.bridge",
  version: "2.1.0",
  name: "CTGMovies Bridge",
  description:
    "High-speed ISP/BDIX direct streams for Movies, TV Shows and Anime from CTGMovies.",
  logo: "https://dhakastremio.mehedihtanvir.me/icon.svg",
  background:
    "https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?q=80&w=1920&auto=format&fit=crop",
  contactEmail: "mhthe1.dev@gmail.com",

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
      idPrefixes: ["ctg:", "tt"]
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

const REFERER = "https://ctgmovies.com/";

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function norm(s) {
  return String(s || "").toLowerCase();
}

function stype(k) {
  return k === "movies" ? "movie" : "series";
}

function buildIndexes(items) {
  const byId = new Map();
  const byImdb = new Map();
  const byTmdb = new Map();
  const byName = new Map();

  for (const i of items) {
    if (i.id) byId.set(i.id, i);

    if (i.imdb) byImdb.set(i.imdb, i);

    if (i.tmdb) byTmdb.set(String(i.tmdb), i);

    const k = normName(i.name);

    if (!byName.has(k)) {
      byName.set(k, []);
    }

    byName.get(k).push(i);
  }

  return {
    byId,
    byImdb,
    byTmdb,
    byName
  };
}

function card(i) {
  return {
    id: i.id,
    type: stype(i.kind),
    name: i.name,
    poster: i.poster,
    releaseInfo: i.year ? String(i.year) : undefined
  };
}

function toStreams(links) {
  return (links || [])
    .filter((l) => l.url)
    .map((l) => ({
      name: `CTGMovies\n${l.quality || "Direct"}`,
      title: `${l.quality || "Direct"} (${l.source || "Server"})`,
      url: l.url,

      subtitles:
        l.subs && l.subs.length
          ? l.subs.map((t, i) => ({
              id: String(i),
              url: t.url,
              lang: t.label || "English"
            }))
          : undefined,

      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            Referer: REFERER
          }
        }
      }
    }));
}

async function matchByCinemeta(
  type,
  rawId,
  indexes
) {
  const [imdb, s, e] = rawId.split(":");

  try {
    const r = await fetch(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`,
      {
        signal: AbortSignal.timeout(4500)
      }
    );

    if (!r.ok) return { item: null };

    const { meta } = await r.json();

    if (!meta) return { item: null };

    const want =
      type === "movie" ? "movies" : null;

    const cands = (
      indexes.byName.get(
        normName(meta.name)
      ) || []
    ).filter((i) =>
      want
        ? i.kind === "movies"
        : i.kind !== "movies"
    );

    const y = parseInt(
      String(
        meta.releaseInfo ||
          meta.year ||
          ""
      ).slice(0, 4),
      10
    );

    const item =
      cands.find(
        (i) =>
          !y ||
          !i.year ||
          i.year === y
      ) ||
      cands.find(
        (i) =>
          !y ||
          !i.year ||
          Math.abs(i.year - y) <= 1
      ) ||
      cands[0] ||
      null;

    return {
      item,
      s: +s || null,
      e: +e || null
    };
  } catch {
    return {
      item: null
    };
  }
}

function findItem(rawId, indexes) {
  const parts = rawId.split(":");

  if (rawId.startsWith("ctg:")) {
    return {
      item: indexes.byId.get(
        parts.slice(0, 3).join(":")
      ),
      s: +parts[3] || null,
      e: +parts[4] || null
    };
  }

  if (rawId.startsWith("tmdb:")) {
    return {
      item: indexes.byTmdb.get(parts[1]),
      s: +parts[2] || null,
      e: +parts[3] || null
    };
  }

  return {
    item: indexes.byImdb.get(parts[0]),
    s: +parts[1] || null,
    e: +parts[2] || null
  };
}

async function catalog(
  id,
  extra,
  items,
  indexes
) {
  const kind = CAT_KIND[id];

  if (!kind) {
    return {
      metas: []
    };
  }

  let list = items.filter(
    (i) => i.kind === kind
  );

  const skip =
    parseInt(extra.skip || "0", 10) || 0;

  if (extra.search) {
    const q = norm(extra.search);

    list = list.filter((i) =>
      norm(i.name).includes(q)
    );
  }

  return {
    metas: list
      .slice(skip, skip + PAGE)
      .map(card)
  };
}

async function meta(id, indexes) {
  const { item } = findItem(
    id,
    indexes
  );

  if (!item) {
    return {
      meta: null
    };
  }

  const m = {
    id: item.id,
    type: stype(item.kind),
    name: item.name,
    poster: item.poster,
    background: item.backdrop,
    description: item.overview,
    releaseInfo: item.year
      ? String(item.year)
      : undefined,
    imdbRating: item.rating
      ? String(item.rating)
      : undefined,
    genres: item.genres,
    runtime: item.runtime
      ? `${item.runtime} min`
      : undefined
  };

  if (item.trailer) {
    m.trailers = [
      {
        source: item.trailer,
        type: "Trailer"
      }
    ];
  }

  if (item.kind !== "movies") {
    m.videos = (
      item.episodes || []
    ).map((ep) => ({
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
    }));
  }

  return {
    meta: m
  };
}

async function stream(
  id,
  type,
  indexes
) {
  let {
    item,
    s,
    e
  } = findItem(
    id,
    indexes
  );

  if (
    !item &&
    !id.startsWith("ctg:")
  ) {
    ({
      item,
      s,
      e
    } = await matchByCinemeta(
      type === "movie"
        ? "movie"
        : "series",
      id,
      indexes
    ));
  }

  if (!item) {
    return {
      streams: []
    };
  }

  if (item.kind === "movies") {
    return {
      streams: toStreams(
        item.links
      )
    };
  }

  const ep = (
    item.episodes || []
  ).find(
    (x) =>
      x.s === (s || 1) &&
      x.e === (e || 1)
  );

  return {
    streams: toStreams(
      ep && ep.links
    )
  };
}

function parseExtra(str) {
  const out = {};

  if (!str) return out;

  for (const p of str.split("&")) {
    const i = p.indexOf("=");

    if (i > 0) {
      out[p.slice(0, i)] =
        decodeURIComponent(
          p.slice(i + 1)
        );
    }
  }

  return out;
}

module.exports = async (
  req,
  res
) => {
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
    return res
      .status(204)
      .end();
  }

  const parts = decodeURIComponent(
    (req.url || "/")
      .split("?")[0]
  )
    .replace(/\.json$/, "")
    .split("/")
    .filter(Boolean);

  const [
    resource,
    type,
    id,
    extraStr
  ] = parts;

  const out = (o) =>
    res
      .status(200)
      .send(JSON.stringify(o));

  try {
    DATA = await loadData();

    const ITEMS =
      DATA.items || [];

    const indexes =
      buildIndexes(ITEMS);

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=1800"
    );

    if (
      !resource ||
      resource === "manifest"
    ) {
      return out(manifest);
    }

    if (resource === "status") {
      const c = (k) =>
        ITEMS.filter(
          (i) => i.kind === k
        ).length;

      return out({
        updated:
          DATA.updated || null,
        items: ITEMS.length,
        movies: c("movies"),
        tv: c("tv"),
        anime: c("anime"),
        source: "Cloudflare D1"
      });
    }

    if (resource === "catalog") {
      return out(
        await catalog(
          id,
          parseExtra(extraStr),
          ITEMS,
          indexes
        )
      );
    }

    if (resource === "meta") {
      return out(
        await meta(
          id,
          indexes
        )
      );
    }

    if (resource === "stream") {
      return out(
        await stream(
          id,
          type,
          indexes
        )
      );
    }

    return res
      .status(404)
      .send(
        JSON.stringify({
          error: "not found"
        })
      );
  } catch (err) {
    console.error(err);

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    if (resource === "catalog") {
      return out({
        metas: []
      });
    }

    if (resource === "stream") {
      return out({
        streams: []
      });
    }

    return out({
      meta: null
    });
  }
};
