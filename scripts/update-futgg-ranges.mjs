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
const MAX_RETRIES = Number(process.env.RANGE_MAX_RETRIES || "2");
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.RANGE_429_COOLDOWN_MS || "60000");
const MAX_CONSECUTIVE_RATE_LIMITS = Number(process.env.RANGE_MAX_CONSECUTIVE_429 || "20");

console.log("Refreshing prices before ranges.");
await import("./update-futgg-prices.mjs");

const players = JSON.parse(await readFile(PLAYERS_FILE, "utf8"));
const metadata = JSON.parse(await readFile(METADATA_FILE, "utf8"));

const targets = players
  .filter((player) => player.prices.console > 0 || player.prices.pc > 0)
  .sort((a, b) => Number(hasUsableRange(a.priceRange)) - Number(hasUsableRange(b.priceRange)));
const limitedTargets = MAX_PLAYERS > 0 ? targets.slice(0, MAX_PLAYERS) : targets;

console.log(`Range targets: ${limitedTargets.length}/${players.length}.`);

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
let consecutiveRateLimits = 0;

try {
  for (let index = 0; index < limitedTargets.length; index += 1) {
    const player = limitedTargets[index];
    try {
      const result = await fetchRangeWithRetry(page, player.eaId);
      if (result?.minPrice || result?.maxPrice) {
        player.priceRange = {
          min: Number(result.minPrice ?? 0),
          max: Number(result.maxPrice ?? 0),
        };
        player.rangeUpdatedAtUtc = new Date().toISOString();
        updated += 1;
      }
      consecutiveRateLimits = 0;
    } catch (error) {
      failed += 1;
      console.log(`Range failed ${player.eaId} ${player.name}: ${error.message}`);
      if (isRateLimit(error)) {
        consecutiveRateLimits += 1;
        if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
          console.log(`Stopping after ${consecutiveRateLimits} consecutive 429 responses. Saved progress will be kept.`);
          break;
        }
      } else {
        consecutiveRateLimits = 0;
      }
      if (failed >= 50 && updated === 0) {
        throw new Error("Too many range failures before any success.");
      }
    }

    if ((index + 1) % SAVE_EVERY === 0) {
      await save(players, metadata);
      console.log(`Range progress ${index + 1}/${limitedTargets.length}, updated ${updated}, failed ${failed}.`);
    }
    if (DELAY_MS > 0) await delay(DELAY_MS);
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

async function fetchRangeWithRetry(page, eaId) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fetchRangeInPage(page, eaId);
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === MAX_RETRIES) break;
      console.log(`Rate limited for ${eaId}; waiting ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s before retry ${attempt + 1}/${MAX_RETRIES}.`);
      await delay(RATE_LIMIT_COOLDOWN_MS);
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

function isRateLimit(error) {
  return String(error?.message ?? error).includes("429");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
