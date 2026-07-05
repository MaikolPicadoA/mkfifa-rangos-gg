const state = {
  players: [],
  filtered: [],
};

const dataVersion = "2026070501";

const auth = {
  user: "admin",
  passwordHash: "da9d0e1b2df69898f6e14abe094230337ce034f834c671d2837f3b2c434332fd",
  sessionKey: "mkfifa-rangos-gg-auth",
};

const els = {
  loginScreen: document.querySelector("#loginScreen"),
  loginForm: document.querySelector("#loginForm"),
  loginUser: document.querySelector("#loginUser"),
  loginPassword: document.querySelector("#loginPassword"),
  loginError: document.querySelector("#loginError"),
  appShell: document.querySelector("#appShell"),
  sourceCount: document.querySelector("#sourceCount"),
  pricesUpdatedAt: document.querySelector("#pricesUpdatedAt"),
  rangesUpdatedAt: document.querySelector("#rangesUpdatedAt"),
  searchInput: document.querySelector("#searchInput"),
  platform: document.querySelector("#platform"),
  maxPrice: document.querySelector("#maxPrice"),
  minRange: document.querySelector("#minRange"),
  maxRange: document.querySelector("#maxRange"),
  positionFilter: document.querySelector("#positionFilter"),
  sortBy: document.querySelector("#sortBy"),
  filteredCount: document.querySelector("#filteredCount"),
  avgPrice: document.querySelector("#avgPrice"),
  rangeCount: document.querySelector("#rangeCount"),
  bestValue: document.querySelector("#bestValue"),
  playersBody: document.querySelector("#playersBody"),
  emptyState: document.querySelector("#emptyState"),
};

async function boot() {
  bindLogin();
  if (!isAuthenticated()) return;
  showApp();
  await loadPlayers();
  bindEvents();
  applyFilters();
}

function bindLogin() {
  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = els.loginUser.value.trim();
    const passwordHash = await sha256(els.loginPassword.value);

    if (user === auth.user && passwordHash === auth.passwordHash) {
      sessionStorage.setItem(auth.sessionKey, "1");
      els.loginPassword.value = "";
      els.loginError.textContent = "";
      showApp();
      await loadPlayers();
      bindEvents();
      applyFilters();
      return;
    }

    els.loginError.textContent = "Usuario o contrasena incorrectos.";
  });
}

function isAuthenticated() {
  return sessionStorage.getItem(auth.sessionKey) === "1";
}

function showApp() {
  els.loginScreen.hidden = true;
  els.appShell.hidden = false;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadPlayers() {
  const [playersResponse, metadataResponse] = await Promise.all([
    fetch(`data/players.json?v=${dataVersion}`, { cache: "no-store" }),
    fetch(`data/metadata.json?v=${dataVersion}`, { cache: "no-store" }),
  ]);
  state.players = await playersResponse.json();
  const metadata = await metadataResponse.json();
  els.sourceCount.textContent = `${state.players.length.toLocaleString("es")} jugadores`;
  els.pricesUpdatedAt.textContent = `Precios UTC: ${formatUtcDate(metadata.pricesUpdatedAtUtc)}`;
  els.rangesUpdatedAt.textContent = `Rangos UTC: ${formatUtcDate(metadata.rangesUpdatedAtUtc)}`;
  fillPositions();
}

function bindEvents() {
  [
    els.searchInput,
    els.platform,
    els.maxPrice,
    els.minRange,
    els.maxRange,
    els.positionFilter,
    els.sortBy,
  ].forEach((element) => element.addEventListener("input", applyFilters));
}

function fillPositions() {
  const selected = els.positionFilter.value;
  els.positionFilter.innerHTML = '<option value="all">Todas</option>';
  const positions = new Set();
  state.players.forEach((player) => player.positions.forEach((pos) => positions.add(pos)));
  [...positions].sort().forEach((position) => {
    const option = document.createElement("option");
    option.value = position;
    option.textContent = position;
    els.positionFilter.append(option);
  });
  if ([...els.positionFilter.options].some((option) => option.value === selected)) {
    els.positionFilter.value = selected;
  }
}

function applyFilters() {
  const query = normalize(els.searchInput.value);
  const maxPrice = parseFilterNumber(els.maxPrice.value, Number.MAX_SAFE_INTEGER);
  const minRangeActive = hasFilterValue(els.minRange.value);
  const maxRangeActive = hasFilterValue(els.maxRange.value);
  const minRangeFilter = parseFilterNumber(els.minRange.value, 0);
  const maxRangeFilter = parseFilterNumber(els.maxRange.value, Number.MAX_SAFE_INTEGER);
  const platform = els.platform.value;
  const position = els.positionFilter.value;

  state.filtered = state.players
    .filter((player) => {
      const price = getPrimaryPrice(player, platform);
      const priceRange = getPriceRange(player);
      const haystack = normalize(`${player.name} ${player.positions.join(" ")} ${player.club} ${player.nation}`);
      return price > 0
        && price <= maxPrice
        && hasUsableRange(priceRange)
        && passesRangeFilter(priceRange, {
          minActive: minRangeActive,
          min: minRangeFilter,
          maxActive: maxRangeActive,
          max: maxRangeFilter,
        })
        && (position === "all" || player.positions.includes(position))
        && haystack.includes(query);
    })
    .sort(sortPlayers(platform));

  renderSummary(platform);
  renderTable();
}

function sortPlayers(platform) {
  return (a, b) => {
    switch (els.sortBy.value) {
      case "price-asc":
        return getPrimaryPrice(a, platform) - getPrimaryPrice(b, platform);
      case "price-desc":
        return getPrimaryPrice(b, platform) - getPrimaryPrice(a, platform);
      case "range-min-asc":
        return getRangeMin(a) - getRangeMin(b);
      case "range-min-desc":
        return getRangeMin(b) - getRangeMin(a);
      case "range-max-asc":
        return getRangeMax(a) - getRangeMax(b);
      case "range-max-desc":
        return getRangeMax(b) - getRangeMax(a);
      case "name-asc":
        return a.name.localeCompare(b.name);
      default:
        return b.rating - a.rating || a.name.localeCompare(b.name);
    }
  };
}

function renderSummary(platform) {
  const priced = state.filtered.filter((player) => getPrimaryPrice(player, platform) > 0);
  const avgPrice = average(priced.map((player) => getPrimaryPrice(player, platform)));
  const ranged = state.players.filter((player) => hasUsableRange(getPriceRange(player)));
  const best = [...priced].sort((a, b) => valueScore(b, platform) - valueScore(a, platform))[0];

  els.filteredCount.textContent = state.filtered.length.toLocaleString("es");
  els.avgPrice.textContent = formatCoins(avgPrice);
  els.rangeCount.textContent = ranged.length.toLocaleString("es");
  els.bestValue.textContent = best ? best.name : "-";
}

function renderTable() {
  els.emptyState.hidden = state.filtered.length > 0;
  els.playersBody.innerHTML = state.filtered.map((player) => `
    <tr>
      <td>
        <a href="${player.url}" target="_blank" rel="noreferrer">${player.name}</a>
        <span>${player.club || "-"} - ${player.nation || "-"}</span>
      </td>
      <td><b>${player.rating}</b></td>
      <td>${player.positions.join(", ")}</td>
      <td>${formatDateOnly(player.addedOn)}</td>
      <td><strong class="mainPrice">${formatCoins(getPrimaryPrice(player, els.platform.value))}</strong></td>
      <td>${formatRange(getPriceRange(player))}</td>
    </tr>
  `).join("");
}

function valueScore(player, platform) {
  const price = getPrimaryPrice(player, platform) || 1;
  const range = getPriceRange(player);
  return (player.rating * player.rating * (range?.max || 1)) / price;
}

function getPrimaryPrice(player, platform) {
  return player.prices?.[platform] ?? 0;
}

function getPriceRange(player) {
  return player.priceRange ?? null;
}

function getRangeMin(player) {
  return getPriceRange(player)?.min ?? Number.MAX_SAFE_INTEGER;
}

function getRangeMax(player) {
  return getPriceRange(player)?.max ?? Number.MAX_SAFE_INTEGER;
}

function passesRangeFilter(range, filter) {
  if (!filter.minActive && !filter.maxActive) return true;
  if (!range) return false;
  if (filter.minActive && range.min !== filter.min) return false;
  if (filter.maxActive && range.max !== filter.max) return false;
  return true;
}

function hasUsableRange(range) {
  return Boolean(range && (range.min > 0 || range.max > 0));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatCoins(value) {
  if (!value) return "0";
  return Math.round(value).toLocaleString("es");
}

function formatRange(range) {
  if (!range) return "-";
  return `${formatCoins(range.min)} - ${formatCoins(range.max)}`;
}

function formatUtcDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatDateOnly(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalize(value) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function hasFilterValue(value) {
  return String(value ?? "").trim() !== "";
}

function parseFilterNumber(value, fallback) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return fallback;

  const compact = raw.replace(/\s+/g, "");
  const suffixMatch = compact.match(/^(\d+(?:[.,]\d+)?)([KM])$/);
  if (suffixMatch) {
    const amount = Number(suffixMatch[1].replace(",", "."));
    return Math.round(amount * (suffixMatch[2] === "M" ? 1000000 : 1000));
  }

  const milMatch = compact.match(/^(\d+(?:[.,]\d+)?)(MIL)$/);
  if (milMatch) {
    return Math.round(Number(milMatch[1].replace(",", ".")) * 1000);
  }

  const normalized = compact.replace(/[^\d]/g, "");
  return normalized ? Number(normalized) : fallback;
}

boot().catch((error) => {
  els.playersBody.innerHTML = `<tr><td colspan="6">No se pudo cargar data/players.json: ${error.message}</td></tr>`;
});
