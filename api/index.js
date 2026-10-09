
const API = "https://ctgmovies-api-new.proshantobarua041.workers.dev";

let cache = null;
let cacheTime = 0;

async function getItems() {
  if (cache && Date.now() - cacheTime < 60000) {
    return cache;
  }

  const all = [];
  const seen = new Set();

  for (let skip = 0; skip < 100000; skip += 50) {
    const response = await fetch(
      `${API}/movies?skip=${skip}`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      throw new Error(`Catalog API error: ${response.status}`);
    }

    const data = await response.json();
    const items = Array.isArray(data) ? data : data.items;

    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      if (item.id && !seen.has(item.id)) {
        seen.add(item.id);
        all.push(item);
      }
    }

    if (items.length < 50) break;
  }

  cache = all;
  cacheTime = Date.now();
  return all;
}

function toMeta(item) {
  const isSeries =
    item.kind === "series" ||
    item.type === "series" ||
    item.kind === "tv";

  return {
    id: item.id,
    type: isSeries ? "series" : "movie",
    name: item.title || item.name || "Unknown",
    poster: item.poster || item.image || undefined,
    description: item.description || undefined,
    releaseInfo: item.year ? String(item.year) : undefined
  };
}

module.exports = async function (req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  try {
    const url = new URL(req.url, "https://example.com");
    const p = url.pathname.replace(/\/+$/, "");

    if (p.endsWith("/manifest.json")) {
      return res.status(200).json({
        id: "com.mhthe1.ctgmovies.bridge",
        version: "3.1.0",
        name: "CTGMovies",
        description: "CTGMovies catalog and streams",
        resources: ["catalog", "meta", "stream"],
        types: ["movie", "series"],
        catalogs: [
          { type: "movie", id: "ctg_movies", name: "CTGMovies" },
          { type: "series", id: "ctg_tv", name: "CTGMovies TV" }
        ]
      });
    }

    const items = await getItems();

    if (p.endsWith("/catalog/movie/ctg_movies.json") ||
        p.endsWith("/catalog/series/ctg_tv.json")) {
      const series = p.includes("/series/");
      const filtered = items.filter(item =>
        series
          ? ["series", "tv"].includes(item.kind || item.type)
          : !["series", "tv"].includes(item.kind || item.type)
      );

      return res.status(200).json({
        metas: filtered.map(toMeta)
      });
    }

    const metaMatch = p.match(/\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const id = decodeURIComponent(metaMatch[2]);
      const item = items.find(x => String(x.id) === id);

      if (!item) return res.status(404).json({ meta: null });

      const meta = toMeta(item);

      if (meta.type === "series" && Array.isArray(item.episodes)) {
        meta.videos = item.episodes.map(ep => ({
          id: `${item.id}:${ep.s || ep.season || 1}:${ep.e || ep.episode || 1}`,
          title: ep.title || `Episode ${ep.e || ep.episode || 1}`,
          season: ep.s || ep.season || 1,
          episode: ep.e || ep.episode || 1
        }));
      }

      return res.status(200).json({ meta });
    }

    const streamMatch = p.match(/\/stream\/(movie|series)\/(.+)\.json$/);
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[2]);
      const parts = id.split(":");
      const item = items.find(x => String(x.id) === parts[0]);

      if (!item) return res.status(200).json({ streams: [] });

      let links = item.links || [];

      if (parts.length >= 3 && Array.isArray(item.episodes)) {
        const season = Number(parts[1]);
        const episode = Number(parts[2]);
        const ep = item.episodes.find(x =>
          Number(x.s || x.season || 1) === season &&
          Number(x.e || x.episode || 1) === episode
        );
        links = ep?.links || [];
      }

      const streams = links
        .filter(link => link && (link.url || link.streamUrl))
        .map(link => ({
          name: link.name || link.server || "CTGMovies",
          title: link.title || link.name || "Play",
          url: link.url || link.streamUrl
        }));

      return res.status(200).json({ streams });
    }

    return res.status(200).json({
      ok: true,
      message: "CTGMovies API running",
      catalogItems: items.length
    });
  } catch (error) {
    return res.status(500).json({
      error: "CTGMovies API failed",
      message: error.message
    });
  }
};
