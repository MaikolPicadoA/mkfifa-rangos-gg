import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const METADATA_FILE = path.join(DATA_DIR, "metadata.json");
const FUTGG_API = "https://www.fut.gg/api/fut/players/v2/26/";
const MANIFEST_URL = "https://r2.fut.gg/26/manifest.json";
const OVERALL_BUCKETS = [
  [90, 99],
  [80, 89],
  [70, 79],
  [65, 69],
  [60, 64],
  [50, 59],
  [1, 49],
];

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "application/json",
  referer: "https://www.fut.gg/players/new/",
};

await mkdir(DATA_DIR, { recursive: true });

const previousPlayers = await readJson(PLAYERS_FILE, []);
const previousMetadata = await readJson(METADATA_FILE, {});
const previousByEaId = new Map(previousPlayers.map((player) => [Number(player.eaId), player]));

const [players, priceMaps] = await Promise.all([
  fetchAllPlayers(),
  fetchPriceMaps(),
]);

const mappedPlayers = players
  .map((player) => normalizePlayer(player, previousByEaId, priceMaps))
  .filter((player) => player.prices.console > 0 || player.prices.pc > 0);

const metadata = {
  source: "FUT.GG",
  sourceUrl: "https://www.fut.gg/players/new/",
  totalPlayers: mappedPlayers.length,
  totalRanges: mappedPlayers.filter((player) => hasUsableRange(player.priceRange)).length,
  pricesUpdatedAtUtc: new Date().toISOString(),
  rangesUpdatedAtUtc: previousMetadata.rangesUpdatedAtUtc ?? null,
  version: versionStamp(),
};

await writeJson(PLAYERS_FILE, mappedPlayers);
await writeJson(METADATA_FILE, metadata);

console.log(`Updated ${mappedPlayers.length} players.`);
console.log(`Ranges kept: ${metadata.totalRanges}.`);
console.log(`Prices UTC: ${metadata.pricesUpdatedAtUtc}.`);

async function fetchAllPlayers() {
  const playersByEaId = new Map();
  for (const [minOverall, maxOverall] of OVERALL_BUCKETS) {
    const bucketPlayers = await fetchPlayerBucket(minOverall, maxOverall);
    bucketPlayers.forEach((player) => playersByEaId.set(Number(player.eaId), player));
    console.log(`Accumulated unique players: ${playersByEaId.size}.`);
  }

  return [...playersByEaId.values()];
}

async function fetchPlayerBucket(minOverall, maxOverall) {
  const firstPage = await fetchPlayerPage(1, minOverall, maxOverall);
  const totalPages = Math.ceil(firstPage.total / firstPage.data.length);
  console.log(`FUT.GG players ${minOverall}-${maxOverall}: ${firstPage.total}, pages: ${totalPages}.`);

  const pageNumbers = [];
  for (let page = 2; page <= totalPages; page += 1) pageNumbers.push(page);

  const rest = await mapWithConcurrency(pageNumbers, 8, (page) => fetchPlayerPage(page, minOverall, maxOverall));
  return [firstPage, ...rest].flatMap((page) => page.data);
}

async function fetchPlayerPage(page, minOverall, maxOverall) {
  const url = `${FUTGG_API}?sorts=-created_at&overall__gte=${minOverall}&overall__lte=${maxOverall}&page=${page}`;
  return fetchJson(url, { retries: 5 });
}

async function fetchPriceMaps() {
  try {
    const manifest = await fetchJson(MANIFEST_URL, { retries: 5 });
    const [index, consolePrices, pcPrices] = await Promise.all([
      fetchManifestBlob(manifest, "player-prices-index"),
      fetchManifestBlob(manifest, "player-prices-ps5-dyn"),
      fetchManifestBlob(manifest, "player-prices-pc-dyn"),
    ]);
    return {
      console: decodePriceBlob(index, consolePrices),
      pc: decodePriceBlob(index, pcPrices),
    };
  } catch (error) {
    console.warn(`Could not load FUT.GG price blobs, falling back to list prices: ${error.message}`);
    return { console: new Map(), pc: new Map() };
  }
}

function fetchManifestBlob(manifest, key) {
  const hash = manifest[key];
  if (!hash) throw new Error(`Manifest missing ${key}`);
  return fetchJson(`https://r2.fut.gg/26/${key}.v${manifest._version}.${hash}.json`, { retries: 5 });
}

function decodePriceBlob(indexBlob, priceBlob) {
  const idIndex = decodeIndex(indexBlob);
  const prices = new Map();
  for (const [eaId, index] of idIndex) {
    const price = Number(priceBlob.p?.[index] ?? 0);
    if (price > 0) prices.set(Number(eaId), price);
  }
  return prices;
}

function decodeIndex(blob) {
  const ids = new Map();
  let eaId = Number(blob.id0);
  ids.set(eaId, 0);
  blob.d.forEach((delta, index) => {
    eaId += Number(delta);
    ids.set(eaId, index + 1);
  });
  return ids;
}

function normalizePlayer(player, previousByEaId, priceMaps) {
  const eaId = Number(player.eaId);
  const previous = previousByEaId.get(eaId);
  const positions = [player.position, ...(player.alternativePositions ?? [])]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  const listPrice = Number(player.price ?? 0);

  return {
    eaId,
    basePlayerEaId: Number(player.basePlayerEaId ?? 0),
    name: player.commonName || [player.firstName, player.lastName].filter(Boolean).join(" "),
    rating: Number(player.overall ?? 0),
    positions,
    club: player.club?.name ?? player.uniqueClub?.name ?? "",
    nation: player.nation?.name ?? "",
    league: player.league?.name ?? "",
    rarity: player.rarityName ?? player.cardName ?? "",
    addedOn: player.createdAt ?? null,
    prices: {
      console: Number(priceMaps.console.get(eaId) ?? listPrice ?? 0),
      pc: Number(priceMaps.pc.get(eaId) ?? 0),
    },
    priceUpdatedAtUtc: new Date().toISOString(),
    priceRange: previous?.priceRange ?? null,
    rangeUpdatedAtUtc: previous?.rangeUpdatedAtUtc ?? null,
    url: `https://www.fut.gg${player.url}`,
    imageUrl: player.cardImageUrl ?? player.imageUrl ?? "",
  };
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? 3;
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: HEADERS });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      const waitMs = 750 * attempt;
      console.log(`Fetch failed ${attempt}/${retries}: ${url} (${error.message})`);
      await delay(waitMs);
    }
  }
  throw lastError;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
      if ((index + 1) % 25 === 0) console.log(`Loaded ${index + 1}/${items.length} extra pages.`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hasUsableRange(range) {
  return Boolean(range && (range.min > 0 || range.max > 0));
}

function versionStamp() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
