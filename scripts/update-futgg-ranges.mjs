import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const METADATA_FILE = path.join(DATA_DIR, "metadata.json");
const MAX_PLAYERS = Number(process.env.MAX_RANGE_PLAYERS || "0");
const SAVE_EVERY = Number(process.env.SAVE_EVERY || "25");
const DELAY_MS = Number(process.env.RANGE_DELAY_MS || "50");
const REFRESH_EXISTING_RANGES = process.env.REFRESH_EXISTING_RANGES === "1";
const RATE_LIMIT_RETRIES = Number(process.env.RANGE_RATE_LIMIT_RETRIES || "6");
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.RANGE_RATE_LIMIT_COOLDOWN_MS || "120000");
const BATCH_COOLDOWN_EVERY = Number(process.env.RANGE_BATCH_COOLDOWN_EVERY || "500");
const BATCH_COOLDOWN_MS = Number(process.env.RANGE_BATCH_COOLDOWN_MS || "600000");

console.log("Refreshing prices before ranges.");
await import("./update-futgg-prices.mjs");

const players = JSON.parse(await readFile(PLAYERS_FILE, "utf8"));
const metadata = JSON.parse(await readFile(METADATA_FILE, "utf8"));

const targets = players
  .filter((player) => player.prices.console > 0 || player.prices.pc > 0)
  .filter((player) => REFRESH_EXISTING_RANGES || !hasUsableRange(player.priceRange))
  .sort((a, b) => Number(hasUsableRange(a.priceRange)) - Number(hasUsableRange(b.priceRange)));
const limitedTargets = MAX_PLAYERS > 0 ? targets.slice(0, MAX_PLAYERS) : targets;

console.log(`Range targets: ${limitedTargets.length}/${players.length}.`);
console.log(`Refresh existing ranges: ${REFRESH_EXISTING_RANGES ? "yes" : "no"}.`);
console.log(`Rate limit retries: ${RATE_LIMIT_RETRIES}, cooldown ms: ${RATE_LIMIT_COOLDOWN_MS}.`);
console.log(`Batch cooldown: every ${BATCH_COOLDOWN_EVERY}, ms: ${BATCH_COOLDOWN_MS}.`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
});
await context.route("**/*", (route) => {
  const url = route.request().url();
  if (
    url.includes("adthrive") ||
    url.includes("doubleclick") ||
    url.includes("googlesyndication") ||
    url.includes("analytics") ||
    url.includes("scorecardresearch") ||
    url.includes("jwplayer") ||
    url.includes("id5") ||
    url.includes("rlcdn") ||
    url.includes("amazon-adsystem")
  ) {
    return route.abort();
  }
  return route.continue();
});

const page = await context.newPage();
await page.goto("https://www.fut.gg/players/new/", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3000);

let updated = 0;
let failed = 0;

try {
  for (let index = 0; index < limitedTargets.length; index += 1) {
    const player = limitedTargets[index];
    try {
      const result = await fetchRangeWithRetries(page, player);
      if (result?.minPrice || result?.maxPrice) {
        player.priceRange = {
          min: Number(result.minPrice ?? 0),
          max: Number(result.maxPrice ?? 0),
        };
        player.rangeUpdatedAtUtc = new Date().toISOString();
        updated += 1;
      }
    } catch (error) {
      failed += 1;
      console.log(`Range failed ${player.eaId} ${player.name}: ${error.message}`);
      if (failed >= 50 && updated === 0) {
        throw new Error("Too many range failures before any success.");
      }
    }

    if ((index + 1) % SAVE_EVERY === 0) {
      await save(players, metadata);
      console.log(`Range progress ${index + 1}/${limitedTargets.length}, updated ${updated}, failed ${failed}.`);
    }
    if (DELAY_MS > 0) await delay(DELAY_MS);
    if (BATCH_COOLDOWN_EVERY > 0 && BATCH_COOLDOWN_MS > 0 && (index + 1) % BATCH_COOLDOWN_EVERY === 0 && index + 1 < limitedTargets.length) {
      console.log(`Range cooldown after ${index + 1}/${limitedTargets.length}: ${BATCH_COOLDOWN_MS}ms.`);
      await delay(BATCH_COOLDOWN_MS);
    }
  }
} finally {
  await browser.close();
}

metadata.rangesUpdatedAtUtc = new Date().toISOString();
metadata.totalRanges = players.filter((player) => hasUsableRange(player.priceRange)).length;
await save(players, metadata);

console.log(`Ranges updated this run: ${updated}.`);
console.log(`Ranges failed this run: ${failed}.`);
console.log(`Total players with ranges: ${metadata.totalRanges}.`);

async function fetchRangeWithRetries(page, player) {
  let lastError;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await fetchRangeInPage(page, player.eaId);
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt >= RATE_LIMIT_RETRIES) break;
      const waitMs = RATE_LIMIT_COOLDOWN_MS * (attempt + 1);
      console.log(`Range rate limited ${player.eaId} ${player.name}; retry ${attempt + 1}/${RATE_LIMIT_RETRIES} in ${waitMs}ms.`);
      await delay(waitMs);
    }
  }
  throw lastError;
}

async function fetchRangeInPage(page, eaId) {
  return page.evaluate(async (id) => {
    const targetUrl = `/api/fut/player-prices/26/${id}/`;
    const signed = await fetch("/api/fut/price-access/sign/", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url: targetUrl }),
    });
    if (!signed.ok) throw new Error(`sign ${signed.status}`);
    const signedData = await signed.json();
    const signedUrl = signedData?.data?.url;
    if (!signedUrl) throw new Error("missing signed url");

    const price = await fetch(signedUrl, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!price.ok) throw new Error(`price ${price.status}`);
    const priceData = await price.json();
    return priceData?.data?.priceRange ?? null;
  }, Number(eaId));
}

async function save(players, metadata) {
  await writeFile(PLAYERS_FILE, `${JSON.stringify(players, null, 2)}\n`, "utf8");
  await writeFile(METADATA_FILE, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function hasUsableRange(range) {
  return Boolean(range && (range.min > 0 || range.max > 0));
}

function isRateLimitError(error) {
  return /(?:sign|price) 429|Failed to fetch/i.test(error?.message ?? "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
