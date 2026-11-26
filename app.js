const GEMINI_KEY_STORAGE = "thriftscan_gemini_key";
const RECENT_SCANS_STORAGE = "thriftscan_recent_scans_v2";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
let backendAvailable = false;

const multiPhotos = {
  tag: null,
  front: null,
  back: null
};

let activeCamStream = null;
let activeCamTarget = null;
let currentCandidates = [];

function $(id) {
  return document.getElementById(id);
}

function setStatusBadge(text, isOnline) {
  const el = $("backendStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("online", Boolean(isOnline));
}

function buildCompQuery(text, maxWords) {
  const limit = maxWords || 7;
  return String(text || "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .replace(/\b(vintage|mens|womens|used|new|pre-owned|shirt|t-shirt|tee|top|item|garment)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, limit)
    .join(" ");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCandidatePills(candidates, activeQuery) {
  const wrap = $("candidateQueriesWrap");
  const pillsEl = $("candidatePills");
  if (!wrap || !pillsEl) return;

  const cleanedList = (candidates || [])
    .map(function (c) {
      return {
        label: c.label || "Query",
        query: buildCompQuery(c.query || "", 7)
      };
    })
    .filter(function (c) { return Boolean(c.query); });

  currentCandidates = cleanedList;

  if (!cleanedList.length) {
    wrap.classList.add("hidden");
    pillsEl.innerHTML = "";
    return;
  }

  wrap.classList.remove("hidden");
  pillsEl.innerHTML = cleanedList.map(function (c, idx) {
    const isSelected = c.query.toLowerCase() === String(activeQuery || "").toLowerCase();
    return (
      '<button type="button" class="candidate-pill' + (isSelected ? " active" : "") + '" data-cand-idx="' + idx + '">' +
      escapeHtml(c.label + ": " + c.query) +
      "</button>"
    );
  }).join("");

  pillsEl.querySelectorAll("[data-cand-idx]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const idx = parseInt(btn.getAttribute("data-cand-idx"), 10);
      const chosen = currentCandidates[idx];
      if (!chosen) return;
      const clean = updateCompLinks(chosen.query, { keepCandidates: true });
      renderCandidatePills(currentCandidates, clean);
      fetchEbayBrowseItems(clean);
    });
  });
}

const EXCLUDE_TERMS = ["lot", "bundle", "kids", "youth", "toddler"];
const SOLD_FLAGS = "&LH_Sold=1&LH_Complete=1&_sop=13";

function cleanPhrase(text) {
  return String(text || "").replace(/['’]/g, "").replace(/[^a-zA-Z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

// Adds "-lot -bundle ..." so multi-item lots and kids' sizes drop out of results
function shortQuery(q) {
  return String(q || "").split(" ").filter(Boolean).slice(0, 5).join(" ");
}

function withExclusions(q) {
  const lower = " " + q.toLowerCase() + " ";
  return q + EXCLUDE_TERMS
    .filter(function (w) { return lower.indexOf(" " + w + " ") === -1; })
    .map(function (w) { return " -" + w; })
    .join("");
}

function ebayUrl(queryText, flags, skipCategory) {
  return "https://www.ebay.com/sch/i.html?_nkw=" + encodeURIComponent(queryText).replace(/%20/g, "+") +
    (skipCategory ? "" : "&_sacat=11450") + "&_ipg=120" + (flags || "");
}

// The tightest search we can build: style code first, then a short quoted key phrase
function buildClosestMatch(clean) {
  const r = lastReport || {};
  const brand = cleanPhrase(r.brand);
  const code = cleanPhrase(r.styleCode);
  const phrase = cleanPhrase(r.exactPhrase);

  if (code.length >= 4) {
    return { label: "🎯 eBay Style Code SOLD", query: (brand + " " + code).trim(), tight: true };
  }
  if (phrase && phrase.split(" ").length >= 2) {
    const used = phrase.toLowerCase().split(" ");
    const rest = clean.split(" ").filter(function (w) {
      return used.indexOf(w.toLowerCase()) === -1;
    }).join(" ");
    return { label: "🎯 eBay Key Phrase SOLD", query: ('"' + phrase + '" ' + rest).trim(), tight: false };
  }
  return { label: "🎯 eBay Closest-Match SOLD", query: clean, tight: false };
}

function renderDirectCompsFeed(cleanQuery) {
  const listEl = $("directCompsList");
  const metaEl = $("compsFeedMeta");
  if (!listEl) return;

  const broad = withExclusions(shortQuery(cleanQuery));
  const closest = buildClosestMatch(cleanQuery);
  const closestQ = closest.tight ? closest.query : withExclusions(closest.query);

  const rows = [
    { label: "Sold & Completed (Recent First)", tag: "SOLD", href: ebayUrl(broad, SOLD_FLAGS) },
    { label: closest.label.replace("🎯 ", ""), tag: "CLOSEST", href: ebayUrl(closestQ, SOLD_FLAGS, closest.tight) },
    { label: "Active Buy-It-Now (Lowest + Ship)", tag: "ACTIVE", href: ebayUrl(broad, "&LH_BIN=1&_sop=15") },
    { label: "Active Auctions (Ending Soonest)", tag: "AUCTION", href: ebayUrl(broad, "&LH_Auction=1&_sop=1") }
  ];

  const modeNote = backendAvailable
    ? '<div class="empty-history">Live eBay data is active for this query.</div>'
    : '<div class="empty-history">Browser-Only Mode: live listings need the Java backend with eBay API keys. Use the direct eBay links below:</div>';

  listEl.innerHTML = modeNote + rows.map(function (r) {
    return (
      '<a class="comp-row-link" href="' + r.href + '" target="_blank" rel="noopener">' +
      "<span>" + r.label + "</span>" +
      "<small>" + r.tag + " →</small>" +
      "</a>"
    );
  }).join("");

  if (metaEl) {
    metaEl.textContent = 'Query: "' + cleanQuery + '"';
  }
}

function setLink(id, href, label) {
  const el = $(id);
  if (!el) return;
  el.href = href;
  if (label) el.textContent = label;
}

function updateCompLinks(query, opts) {
  const clean = buildCompQuery(query, 7) || "Nike arched block swoosh brown";
  currentQueryText = clean;
  if ($("searchQueryInput")) $("searchQueryInput").value = clean;

  const broad = withExclusions(shortQuery(clean));
  const closest = buildClosestMatch(clean);
  const closestQ = closest.tight ? closest.query : withExclusions(closest.query);

  setLink("linkEbaySold", ebayUrl(broad, SOLD_FLAGS));
  setLink("linkEbayExactSold", ebayUrl(closestQ, SOLD_FLAGS, closest.tight), closest.label);
  setLink("linkEbayActive", ebayUrl(broad, "&_sop=15"));
  setLink("linkPoshSold", "https://poshmark.com/search?query=" + encodeURIComponent(clean) + "&availability=sold_out");
  setLink("linkDepopSold", "https://www.google.com/search?q=" + encodeURIComponent('site:depop.com "Sold" ' + clean));

  if (!opts || !opts.keepCandidates) {
    renderCandidatePills([], clean);
  }

  renderDirectCompsFeed(clean);
  return clean;
}

function renderEvidenceReport(parsed) {
  const eraEl = $("evidenceEra");
  const codesEl = $("evidenceCodes");
  const badgeEl = $("confidenceBadge");
  const listEl = $("evidenceList");
  const tipEl = $("resellerTip");

  const era = parsed.estimatedEra || "Era: Needs tag/stitch check";
  const codes = parsed.tagOrStyleCodes || "Tag / RN / Style Code: None visible";
  const conf = Math.max(0, Math.min(100, parseInt(parsed.confidenceScore, 10) || 50));
  const points = Array.isArray(parsed.evidencePoints) && parsed.evidencePoints.length
    ? parsed.evidencePoints
    : ["Inspect neck tag font/color, care tag style code, and graphic placement to confirm exact release."];

  if (eraEl) eraEl.textContent = "Era: " + era;
  if (codesEl) codesEl.textContent = "Codes / Tag: " + codes;

  if (badgeEl) setConfidenceBadge(conf);

  if (listEl) {
    listEl.innerHTML = points.slice(0, 6).map(function (pt) {
      return "<li>" + escapeHtml(pt) + "</li>";
    }).join("");
  }

  if (tipEl && parsed.resellerTip) {
    tipEl.textContent = parsed.resellerTip;
  }
}

function calculateSellThroughRate() {
  const soldRaw = $("soldCountInput") ? $("soldCountInput").value.trim() : "";
  const activeRaw = $("activeCountInput") ? $("activeCountInput").value.trim() : "";
  const displayEl = $("strDisplay");
  const badgeEl = $("strBadge");
  if (!displayEl || !badgeEl) return;

  if (soldRaw === "" && activeRaw === "") {
    displayEl.textContent = "—";
    badgeEl.textContent = "Enter Sold & Active";
    badgeEl.className = "str-pill";
    return;
  }

  const sold = Math.max(0, parseInt(soldRaw || "0", 10) || 0);
  const active = Math.max(0, parseInt(activeRaw || "0", 10) || 0);
  const total = sold + active;

  if (total === 0) {
    displayEl.textContent = "0%";
    badgeEl.textContent = "No Comps";
    badgeEl.className = "str-pill";
    return;
  }

  const str = (sold / total) * 100;
  displayEl.textContent = str.toFixed(1) + "%";

  if (str >= 75) {
    badgeEl.textContent = "Fast Mover (" + sold + "/" + total + ")";
    badgeEl.className = "str-pill hot";
  } else if (str >= 40) {
    badgeEl.textContent = "Steady (" + sold + "/" + total + ")";
    badgeEl.className = "str-pill warm";
  } else {
    badgeEl.textContent = "Slow / Saturated (" + sold + "/" + total + ")";
    badgeEl.className = "str-pill slow";
  }
}

function parseSoldActiveFromText(rawText) {
  const text = String(rawText || "");
  const soldMatch = text.match(/(\d[\d,]*)\s*(?:\+\s*)?sold/i);
  const activeMatch = text.match(/(\d[\d,]*)\s*(?:\+\s*)?active/i);

  const soldVal = soldMatch ? parseInt(soldMatch[1].replace(/,/g, ""), 10) : null;
  const activeVal = activeMatch ? parseInt(activeMatch[1].replace(/,/g, ""), 10) : null;

  if (soldVal !== null && $("soldCountInput")) {
    $("soldCountInput").value = String(soldVal);
  }
  if (activeVal !== null && $("activeCountInput")) {
    $("activeCountInput").value = String(activeVal);
  }
  calculateSellThroughRate();
}

function getRecentScans() {
  try {
    const raw = localStorage.getItem(RECENT_SCANS_STORAGE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function renderRecentScans() {
  const listEl = $("recentScansList");
  if (!listEl) return;

  const scans = getRecentScans();
  const totalEl = $("collectionTotal");
  if (totalEl) {
    const valued = scans.filter(function (sc) { return typeof sc.salePrice === "number" && sc.salePrice > 0; });
    const total = valued.reduce(function (sum, sc) { return sum + sc.salePrice; }, 0);
    totalEl.textContent = valued.length ? valued.length + " valued items • est. total " + fmtMoney(total) : "";
  }
  if (!scans.length) {
    listEl.innerHTML = '<div class="empty-history">No scans saved yet. Run a scan or search to log items here.</div>';
    return;
  }

  listEl.innerHTML = scans.map(function (item, idx) {
    const priceText = typeof item.salePrice === "number" && item.salePrice > 0
      ? "$" + item.salePrice.toFixed(0)
      : "";
    return (
      '<div class="recent-item">' +
      '<div class="recent-info">' +
      "<strong>" + escapeHtml(item.title || item.query) + "</strong>" +
      "<small>" + escapeHtml(item.query) + (item.timeLabel ? " • " + escapeHtml(item.timeLabel) : "") + "</small>" +
      "</div>" +
      '<div class="recent-actions">' +
      (priceText ? '<span class="recent-price">' + priceText + "</span>" : "") +
      '<button type="button" class="recent-load-btn" data-scan-idx="' + idx + '">Load</button>' +
      "</div>" +
      "</div>"
    );
  }).join("");

  listEl.querySelectorAll("[data-scan-idx]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const idx = parseInt(btn.getAttribute("data-scan-idx"), 10);
      const entry = getRecentScans()[idx];
      if (!entry) return;

      lastReport = entry.report || null;
      scanKey = entry.query;
      const clean = updateCompLinks(entry.query);
      if ($("itemTitleLabel")) $("itemTitleLabel").textContent = entry.title || clean;
      resetVisual();
      if (entry.report) renderEvidenceReport(entry.report);
      if (typeof entry.salePrice === "number" && entry.salePrice > 0 && $("salePriceInput")) {
        $("salePriceInput").value = entry.salePrice.toFixed(2);
        calculateProfitAndMaxBuy();
      }
      fetchEbayBrowseItems(clean);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function saveRecentScan(entry) {
  const scans = getRecentScans();
  const normalizedQuery = buildCompQuery(entry.query || entry.title, 7);
  if (!normalizedQuery) return;

  const filtered = scans.filter(function (s) {
    return (s.query || "").toLowerCase() !== normalizedQuery.toLowerCase();
  });

  const now = new Date();
  const timeLabel = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  filtered.unshift({
    title: entry.title || normalizedQuery,
    query: normalizedQuery,
    salePrice: typeof entry.salePrice === "number" ? entry.salePrice : 0,
    report: entry.report || null,
    timeLabel: timeLabel
  });

  localStorage.setItem(RECENT_SCANS_STORAGE, JSON.stringify(filtered.slice(0, 50)));
  renderRecentScans();
}

function clearRecentScans() {
  localStorage.removeItem(RECENT_SCANS_STORAGE);
  renderRecentScans();
}

async function checkJavaBackend() {
  if (window.location.protocol === "file:") {
    backendAvailable = false;
    setStatusBadge("Browser-Only Mode", false);
    return;
  }

  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error("Offline");
    const data = await res.json();
    backendAvailable = true;
    setStatusBadge(data.ebayConfigured ? "Java + eBay API Ready" : "Java Backend Online", true);
  } catch (_) {
    backendAvailable = false;
    setStatusBadge("Browser-Only Mode", false);
  }
}

async function calculateProfitAndMaxBuy() {
  const buyCost = parseFloat($("buyCostInput") && $("buyCostInput").value) || 0;
  const salePrice = parseFloat($("salePriceInput") && $("salePriceInput").value) || 0;
  const shippingCost = parseFloat($("shippingInput") && $("shippingInput").value) || 0;
  const targetProfit = parseFloat($("targetProfitInput") && $("targetProfitInput").value) || 25;
  const feeRate = 0.136;

  let netProfit;
  let maxBuyPrice;
  let roiPct;

  if (backendAvailable) {
    try {
      const res = await fetch("/api/calc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyCost, salePrice, shippingCost, feeRate, targetProfit })
      });
      if (res.ok) {
        const data = await res.json();
        netProfit = data.netProfit;
        maxBuyPrice = data.maxBuyPrice;
        roiPct = data.roiPct;
        if ($("calcSourceBadge")) $("calcSourceBadge").textContent = "Java /api/calc";
      }
    } catch (_) {
      backendAvailable = false;
    }
  }

  if (typeof netProfit !== "number") {
    const fixedFee = salePrice > 10 ? 0.40 : (salePrice > 0 ? 0.30 : 0);
    const fees = salePrice > 0 ? (salePrice * feeRate) + fixedFee : 0;
    netProfit = salePrice - fees - buyCost - shippingCost;
    maxBuyPrice = Math.max(0, salePrice - fees - shippingCost - targetProfit);
    roiPct = buyCost > 0 ? (netProfit / buyCost) * 100 : 0;
    if ($("calcSourceBadge")) $("calcSourceBadge").textContent = "JS Local Calc";
  }

  const netEl = $("netProfitDisplay");
  if (netEl) {
    netEl.textContent = (netProfit >= 0 ? "+$" : "-$") + Math.abs(netProfit).toFixed(2);
    netEl.className = netProfit >= 0 ? "pos" : "neg";
  }
  if ($("maxBuyDisplay")) $("maxBuyDisplay").textContent = "$" + maxBuyPrice.toFixed(2);
  if ($("roiDisplay")) $("roiDisplay").textContent = buyCost > 0 ? Math.round(roiPct) + "%" : "N/A";
  updateVerdict(buyCost, salePrice, netProfit, maxBuyPrice);
}

// ---------- Market data (sold + active listings) and valuation ----------
let lastReport = null;
let lastSoldItems = [];
let lastActiveItems = [];
let visualItems = [];
let soldAvailable = false;
let soldTotal = null;
let activeTotal = null;
let verdictActive = false;
let currentQueryText = "";
let scanKey = "";
let visualState = "idle"; // idle | searching | verifying | done | unverified | failed
let visualError = "";
let visualRequestId = 0;
let deferSold = false; // hold the sold lookup until the photo has picked the best search words
let soldReason = "";
let soldExcluded = 0;
let soldQueryUsed = "";
let marketRequestId = 0;

// Active asking prices usually run above what items really sell for. Tune this with your own results.
const ASK_TO_SOLD = 0.85;

function fmtMoney(n) {
  const v = Number(n) || 0;
  return "$" + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeUrl(u) {
  return typeof u === "string" && /^https:\/\//i.test(u) ? u : "#";
}

function pickImage(it) {
  if (it.image && it.image.imageUrl) return it.image.imageUrl;
  if (it.thumbnailImages && it.thumbnailImages[0] && it.thumbnailImages[0].imageUrl) {
    return it.thumbnailImages[0].imageUrl;
  }
  return "";
}

function normalizeListing(it, sold) {
  const priceObj = sold ? (it.lastSoldPrice || it.price) : it.price;
  return {
    title: it.title || "",
    price: Number(priceObj && priceObj.value) || 0,
    url: it.itemWebUrl || "",
    img: pickImage(it),
    condition: it.condition || "",
    date: sold ? (it.lastSoldDate || "") : ""
  };
}

// SoldComps sale -> the shape the listing UI uses. Lots, for-parts and hidden Best Offer prices are flagged.
function normalizeSoldComp(it) {
  const p = it.sold_price || {};
  const img = it.image || it.image_url || it.photo || it.thumbnail || "";
  return {
    title: it.title || "",
    price: Number(p.value) || 0,
    url: it.url || "",
    img: typeof img === "string" ? img : ((img && img.url) || ""),
    condition: it.condition || "",
    date: it.sold_at || "",
    flagged: (Array.isArray(it.flags) && it.flags.length > 0) || it.best_offer_accepted === true
  };
}

async function fetchJsonSafe(url) {
  try {
    const res = await fetch(url);
    const data = await res.json();
    return { ok: res.ok, data: data };
  } catch (_) {
    return { ok: false, data: null };
  }
}

function getActivePool() {
  if (lastActiveItems.length >= 3) return lastActiveItems;
  const seen = {};
  return lastActiveItems.concat(visualItems).filter(function (it) {
    const key = it.url || it.title;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function listingRowHtml(it, isSold) {
  const meta = [];
  if (isSold && it.date) {
    const d = new Date(it.date);
    if (!isNaN(d.getTime())) meta.push("Sold " + d.toLocaleDateString([], { month: "short", day: "numeric" }));
  }
  if (typeof it.score === "number" && it.score >= MATCH_MIN) meta.unshift("Close match");
  if (it.condition) meta.push(it.condition);
  const thumb = it.img
    ? '<img class="listing-thumb" loading="lazy" src="' + escapeHtml(safeUrl(it.img)) + '" alt="" />'
    : '<div class="listing-thumb listing-thumb-empty"></div>';
  return (
    '<a class="listing-row" href="' + escapeHtml(safeUrl(it.url)) + '" target="_blank" rel="noopener">' +
    thumb +
    '<div class="listing-info"><span class="listing-title">' + escapeHtml(it.title) + "</span>" +
    "<small>" + escapeHtml(meta.join(" • ")) + "</small></div>" +
    '<strong class="listing-price' + (isSold ? " sold" : "") + '">' + (it.price > 0 ? fmtMoney(it.price) : "N/A") + "</strong>" +
    "</a>"
  );
}

function setMarketLoading() {
  const loading = '<div class="empty-history">Loading listings...</div>';
  if ($("soldList")) $("soldList").innerHTML = loading;
  if ($("activeList")) $("activeList").innerHTML = loading;
  if ($("soldNote")) $("soldNote").classList.add("hidden");
}

function soldNoteText() {
  if (soldReason === "pending") return "Comparing your photo first, so the sold search uses the same words real sellers used.";
  if (soldReason === "invalid_key") return "The sold-data API key was rejected. Check the SOLDCOMPS_API_KEY setting on the server.";
  if (soldReason === "quota") return "The sold-data service hit its credit or rate limit. Try again later or check your plan.";
  if (soldReason === "error") return "Couldn't reach the sold-data service right now. Use the sold links below in the meantime.";
  return "Sold data isn't connected yet. Add a SoldComps API key (SOLDCOMPS_API_KEY) on the server, or use the sold links below.";
}

function renderMarket() {
  const soldEl = $("soldList");
  const activeEl = $("activeList");
  const noteEl = $("soldNote");
  const metaEl = $("listingsMeta");
  if (!soldEl || !activeEl) return;

  if (soldAvailable) {
    if (noteEl) noteEl.classList.add("hidden");
    soldEl.innerHTML = lastSoldItems.length
      ? lastSoldItems.slice(0, 8).map(function (it) { return listingRowHtml(it, true); }).join("")
      : '<div class="empty-history">No sold listings found for this search in the last 90 days.</div>';
  } else {
    soldEl.innerHTML = "";
    if (noteEl) {
      noteEl.classList.remove("hidden");
      noteEl.textContent = soldNoteText();
    }
  }

  const pool = getActivePool();
  activeEl.innerHTML = pool.length
    ? pool.slice(0, 8).map(function (it) { return listingRowHtml(it, false); }).join("")
    : '<div class="empty-history">No active listings found. Try a shorter search.</div>';

  if (metaEl) {
    const bits = [];
    if (soldAvailable && typeof soldTotal === "number") bits.push(soldTotal + " sold (90 days)");
    if (soldAvailable && soldExcluded) bits.push(soldExcluded + " lots/offers left out");
    if (typeof activeTotal === "number") bits.push(activeTotal + " active");
    const closeCount = closeMatches(soldAvailable ? lastSoldItems.concat(pool) : pool).length;
    if (pool.length || lastSoldItems.length) bits.push(closeCount + " close matches");
    metaEl.textContent = bits.length ? bits.join(" • ") : 'Search: "' + currentQueryText + '"';
  }
}

function renderMarketUnavailable() {
  if ($("activeList")) {
    $("activeList").innerHTML = '<div class="empty-history">Live listings need the Java backend. Start ThriftScanServer with your eBay keys, or use the eBay, Poshmark and Depop links below.</div>';
  }
  if ($("soldList")) $("soldList").innerHTML = "";
  if ($("soldNote")) $("soldNote").classList.add("hidden");
}

function priceList(items) {
  return items
    .map(function (i) { return i.price; })
    .filter(function (p) { return p > 0; })
    .sort(function (a, b) { return a - b; });
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const MATCH_MIN = 0.67; // a listing is a "close match" if it has at least this share of the key words
const STOPWORDS = ["the", "and", "with", "for", "men", "mens", "women", "womens", "size", "new", "used"];

function keyTokens() {
  let words = [];
  if (lastReport && Array.isArray(lastReport.mustHaveWords)) words = lastReport.mustHaveWords.slice();
  if (!words.length) words = currentQueryText.split(" ");
  const seen = {};
  return words
    .map(function (w) { return String(w || "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim(); })
    .filter(function (w) {
      if (w.length < 2 || STOPWORDS.indexOf(w) !== -1 || seen[w]) return false;
      seen[w] = true;
      return true;
    });
}

function relevance(title, tokens) {
  if (!tokens.length) return 1;
  const t = " " + String(title || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ") + " ";
  let hits = 0;
  tokens.forEach(function (tok) { if (t.indexOf(tok) !== -1) hits++; });
  return hits / tokens.length;
}

function scoreAndSort(list, bySoldDate) {
  const tokens = keyTokens();
  list.forEach(function (it) { it.score = relevance(it.title, tokens); });
  return list.sort(function (a, b) {
    return (b.score - a.score) || (bySoldDate ? new Date(b.date) - new Date(a.date) : 0);
  });
}

function closeMatches(items) {
  return items.filter(function (i) { return typeof i.score !== "number" || i.score >= MATCH_MIN; });
}

function computeValuation(sold, active, report) {
  const closeSold = closeMatches(sold);
  const closeActive = closeMatches(active);
  const verified = visualItems.filter(function (i) { return i.verified && i.price > 0; });
  let list;
  let source;
  let factor;
  let loose = false;

  // Prefer close matches. Only fall back to broader results if close ones are scarce.
  if (priceList(closeSold).length >= 3) {
    list = closeSold; source = "sold"; factor = 1;
  } else if (verified.length >= 2) {
    list = verified; source = "visual"; factor = ASK_TO_SOLD;
  } else if (priceList(closeActive).length >= 3) {
    list = closeActive; source = "active"; factor = ASK_TO_SOLD;
  } else if (priceList(sold).length >= 3) {
    list = sold; source = "sold"; factor = 1; loose = true;
  } else if (priceList(active).length >= 3) {
    list = active; source = "active"; factor = ASK_TO_SOLD; loose = true;
  } else {
    return null;
  }

  const prices = priceList(list);
  const med = quantile(prices, 0.5);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const spread = med > 0 ? (q3 - q1) / med : 1;

  const photoScore = source === "visual"
    ? avgVisualScore(verified)
    : (report ? clamp(parseInt(report.confidenceScore, 10) || 50, 0, 100) : 50);
  const compScore = Math.min(prices.length / 20, 1) * 100;
  const tightScore = clamp(100 - spread * 100, 0, 100);
  const sourceScore = source === "sold" ? 100 : (source === "visual" ? 85 : 60);
  let confidence = Math.round(0.35 * photoScore + 0.3 * compScore + 0.2 * tightScore + 0.15 * sourceScore);
  if (loose) confidence = Math.max(0, confidence - 15);

  return {
    source: source,
    count: prices.length,
    loose: loose,
    estimate: med * factor,
    low: q1 * factor,
    high: q3 * factor,
    confidence: confidence
  };
}

function aiValuation(report) {
  if (!report) return null;
  const low = Number(report.priceLow) || 0;
  const high = Number(report.priceHigh) || 0;
  const single = Number(report.suggestedSalePrice) || 0;
  let est;
  let lo;
  let hi;
  if (low > 0 && high >= low) {
    lo = low; hi = high; est = (low + high) / 2;
  } else if (single > 0) {
    est = single; lo = single * 0.75; hi = single * 1.25;
  } else {
    return null;
  }
  const photoScore = clamp(parseInt(report.confidenceScore, 10) || 50, 0, 100);
  return { source: "ai", count: 0, estimate: est, low: lo, high: hi, confidence: Math.min(photoScore, 45) };
}

function setConfidenceBadge(conf) {
  const badgeEl = $("confidenceBadge");
  if (!badgeEl) return;
  badgeEl.textContent = "Confidence: " + conf + "%";
  badgeEl.className = "confidence-pill " + (conf >= 75 ? "high" : (conf >= 50 ? "med" : "low"));
}

function updateRecentScanPrice(query, price) {
  const key = buildCompQuery(query, 7).toLowerCase();
  const scans = getRecentScans();
  let changed = false;
  scans.forEach(function (s) {
    if ((s.query || "").toLowerCase() === key) {
      s.salePrice = price;
      changed = true;
    }
  });
  if (changed) {
    localStorage.setItem(RECENT_SCANS_STORAGE, JSON.stringify(scans));
    renderRecentScans();
  }
}

function renderValuation(v) {
  verdictActive = true;
  const conf = clamp(v.confidence, 0, 100);
  const badges = { sold: "eBay sold data", visual: "Visual match", active: "Active listings", ai: "AI estimate" };
  const kind = v.loose ? "" : " closely matching";
  const sources = {
    sold: "Based on " + v.count + kind + " eBay sold listings from the last 90 days.",
    active: "Based on " + v.count + kind + " active eBay listings, adjusted down because asking prices run higher than sold prices.",
    visual: "Based on " + v.count + " listings that look like your exact item, adjusted down because asking prices run higher than sold prices.",
    ai: "AI estimate only, because no matching eBay listings were found."
  };

  if ($("valueSourceBadge")) $("valueSourceBadge").textContent = badges[v.source];
  if ($("valueEstimate")) $("valueEstimate").textContent = fmtMoney(v.estimate);
  if ($("valueRange")) $("valueRange").textContent = fmtMoney(v.low) + " to " + fmtMoney(v.high);
  if ($("valueConfidence")) {
    $("valueConfidence").textContent = conf + "%";
    $("valueConfidence").className = conf >= 75 ? "pos" : (conf >= 50 ? "mid" : "neg");
  }

  const notes = [sources[v.source]];
  if (v.loose) notes.push("Few listings matched this item closely, so these are broader comparisons and less certain.");
  if (lastReport && lastReport.priceReasoning) notes.push(lastReport.priceReasoning);
  if (lastReport && lastReport.tagVisible === false) {
    notes.push("No readable tag was found. Add a tag close-up under Multi-Angle for a more accurate result.");
  }
  if (!lastReport) notes.push("This was a manual search, so no photo evidence was used.");
  if ($("valueNote")) $("valueNote").textContent = notes.join(" ");

  const traitsEl = $("valueTraits");
  if (traitsEl) {
    const bits = [];
    if (lastReport && lastReport.condition) {
      bits.push('<span class="trait-pill"><b>Condition</b> ' + escapeHtml(lastReport.condition) + "</span>");
    }
    if (lastReport && lastReport.rarity) {
      bits.push('<span class="trait-pill"><b>Rarity</b> ' + escapeHtml(lastReport.rarity) + "</span>");
    }
    traitsEl.innerHTML = bits.join("");
  }

  setConfidenceBadge(conf);
  if ($("salePriceInput")) {
    $("salePriceInput").value = v.estimate.toFixed(2);
    calculateProfitAndMaxBuy();
  }
  updateRecentScanPrice(scanKey || currentQueryText, Math.round(v.estimate * 100) / 100);
}

function runValuation() {
  const v = computeValuation(lastSoldItems, getActivePool(), lastReport) || aiValuation(lastReport);
  if (v) renderValuation(v);
}

function updateVerdict(buyCost, salePrice, netProfit, maxBuy) {
  const el = $("verdictBanner");
  if (!el) return;
  if (!verdictActive || salePrice <= 0) {
    el.classList.add("hidden");
    return;
  }
  let cls;
  let text;
  if (buyCost <= maxBuy) {
    cls = "buy";
    text = "Buy. Your cost is under the max buy price of " + fmtMoney(maxBuy) + ".";
  } else if (netProfit > 0) {
    cls = "maybe";
    text = "Maybe. You'd profit " + fmtMoney(netProfit) + ", which is under your target. Max buy is " + fmtMoney(maxBuy) + ".";
  } else {
    cls = "pass";
    text = "Pass. You'd lose " + fmtMoney(Math.abs(netProfit)) + " at this price. Max buy is " + fmtMoney(maxBuy) + ".";
  }
  el.className = "verdict " + cls;
  el.textContent = text;
}

async function fetchEbayBrowseItems(query) {
  lastSoldItems = [];
  lastActiveItems = [];
  soldTotal = null;
  activeTotal = null;
  soldExcluded = 0;
  soldQueryUsed = "";
  currentQueryText = query;

  if (!backendAvailable) {
    renderMarketUnavailable();
    runValuation();
    return;
  }

  const reqId = ++marketRequestId;
  setMarketLoading();
  runValuation(); // show the AI estimate right away while listings load

  const q = encodeURIComponent(query);
  const skipSold = deferSold;
  const results = await Promise.all([
    skipSold ? Promise.resolve({ ok: false, data: null }) : fetchJsonSafe("/api/ebay/sold?q=" + q),
    fetchJsonSafe("/api/ebay/search?q=" + q)
  ]);
  if (reqId !== marketRequestId) return; // a newer search replaced this one

  const soldRes = results[0];
  const activeRes = results[1];

  soldAvailable = Boolean(soldRes.ok && soldRes.data && soldRes.data.available);
  soldReason = soldAvailable ? "" : (skipSold ? "pending" : ((soldRes.data && soldRes.data.reason) || "error"));
  if (soldAvailable) {
    const soldData = soldRes.data.data || {};
    if (soldRes.data.source === "soldcomps") {
      const all = (soldData.items || []).map(normalizeSoldComp);
      soldExcluded = all.filter(function (i) { return i.flagged; }).length;
      lastSoldItems = scoreAndSort(all.filter(function (i) { return !i.flagged; }), true);
      if (typeof soldData.count === "number") soldTotal = soldData.count;
      soldQueryUsed = soldRes.data.usedQuery || query;
    } else {
      lastSoldItems = scoreAndSort(
        (soldData.itemSales || []).map(function (it) { return normalizeListing(it, true); }),
        true
      );
      if (typeof soldData.total === "number") soldTotal = soldData.total;
    }
  }

  if (activeRes.ok && activeRes.data) {
    lastActiveItems = scoreAndSort(
      (activeRes.data.itemSummaries || []).map(function (it) { return normalizeListing(it, false); }),
      false
    );
    if (typeof activeRes.data.total === "number") activeTotal = activeRes.data.total;
  }

  if (soldAvailable && typeof soldTotal === "number" && $("soldCountInput")) {
    $("soldCountInput").value = String(soldTotal);
  }
  if (typeof activeTotal === "number" && $("activeCountInput")) {
    $("activeCountInput").value = String(activeTotal);
  }
  calculateSellThroughRate();

  renderMarket();
  runValuation();
}

// ---------- Visual matching: compare the user's photo with real listing photos ----------
const VISUAL_MATCH_MIN = 70;
const TITLE_NOISE = ["vintage", "nwt", "nwot", "euc", "guc", "vgc", "new", "used", "preowned", "pre", "owned",
  "size", "mens", "men", "womens", "women", "unisex", "adult", "xs", "xl", "xxl", "xxxl", "small", "medium", "large",
  "tee", "tees", "shirt", "t-shirt", "tshirt", "free", "shipping", "rare", "authentic", "original", "the", "and",
  "with", "for", "of", "in", "from", "style", "casual", "preowned", "condition", "great", "good"];

function avgVisualScore(items) {
  if (!items.length) return 50;
  const sum = items.reduce(function (t, i) { return t + (typeof i.vscore === "number" ? i.vscore : 80); }, 0);
  return Math.round(sum / items.length);
}

function resetVisual() {
  visualRequestId++;
  deferSold = false;
  visualItems = [];
  visualState = "idle";
  visualError = "";
  renderVisual();
}

function visualCardHtml(it, i) {
  const scored = typeof it.vscore === "number";
  const thumb = it.img
    ? '<img loading="lazy" src="' + escapeHtml(safeUrl(it.img)) + '" alt="" />'
    : '<div class="listing-thumb-empty"></div>';
  const badge = scored
    ? '<span class="vscore ' + (it.verified ? "good" : "weak") + '">' + it.vscore + "% match</span>"
    : "";
  return (
    '<div class="visual-card' + (it.verified ? " match" : "") + '" data-vidx="' + i + '">' +
    thumb + badge +
    '<div class="visual-title">' + escapeHtml(it.title) + "</div>" +
    '<div class="visual-price">' + (it.price > 0 ? fmtMoney(it.price) : "N/A") + "</div>" +
    (it.vreason ? "<small>" + escapeHtml(it.vreason) + "</small>" : "") +
    '<a class="visual-open" href="' + escapeHtml(safeUrl(it.url)) + '" target="_blank" rel="noopener">Open on eBay</a>' +
    "</div>"
  );
}

function renderVisual() {
  const block = $("visualBlock");
  const list = $("visualList");
  const note = $("visualNote");
  if (!block || !list) return;

  if (visualState === "idle") {
    block.classList.add("hidden");
    return;
  }
  block.classList.remove("hidden");

  let msg = "";
  if (visualState === "searching") msg = "Searching eBay for items that look like your photo...";
  else if (visualState === "verifying") msg = "Comparing your photo to " + Math.min(visualItems.length, 10) + " listings...";
  else if (visualState === "failed") msg = visualError || "Visual search isn't available right now.";
  else if (visualState === "unverified") msg = "Couldn't compare automatically (check your Gemini key). These are eBay's closest visual results, so check them yourself. Tap a card to mark it as the same item.";
  else if (visualState === "done") {
    const n = visualItems.filter(function (v) { return v.verified; }).length;
    msg = n
      ? n + " listing(s) look like the same item. Tap a card to mark it as the same item or not."
      : "No listing looks like the same item. These are the closest visual results, for reference. Tap one to mark it as the same.";
  }
  if (note) {
    note.textContent = msg;
    note.classList.toggle("hidden", !msg);
  }

  const you = $("previewImg") && $("previewImg").src
    ? '<div class="visual-you"><img src="' + escapeHtml($("previewImg").src) + '" alt="Your photo" /><small>Your photo</small></div>'
    : "";
  list.innerHTML = you + visualItems.slice(0, 8).map(visualCardHtml).join("");
}

async function proxyImageToBase64(url) {
  try {
    const res = await fetch("/api/proxy-image?u=" + encodeURIComponent(url));
    if (!res.ok) return null;
    const blob = await res.blob();
    const mime = blob.type && blob.type.indexOf("image/") === 0 ? blob.type : "image/jpeg";
    const dataUrl = await new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return { mime: mime, data: String(dataUrl).split(",")[1] };
  } catch (_) {
    return null;
  }
}

// Ask Gemini to compare the user's photo against each listing photo, strictly.
async function verifyVisualMatches(userBase64) {
  const apiKey = localStorage.getItem(GEMINI_KEY_STORAGE) || "";
  const cands = visualItems.filter(function (it) { return it.img; }).slice(0, 10);
  if (!apiKey || !cands.length) return false;

  const imgs = await Promise.all(cands.map(function (it) { return proxyImageToBase64(it.img); }));
  const sent = [];
  const parts = [{
    text: "You compare a thrifted garment photo against eBay listing photos. For each CANDIDATE decide if it is the SAME design as YOUR ITEM: same brand line, same graphic or print, same colorway, same cut. Be strict. A different graphic, color, or style is NOT a match even if the brand and garment type are the same. Judge by the images; listing titles can be wrong. " +
      'Return ONLY JSON: {"matches":[{"index":0,"sameDesign":true,"score":85,"reason":"short visual reason"}]} with one entry per candidate, score 0-100.'
  }, { text: "YOUR ITEM:" }, { inline_data: { mime_type: "image/jpeg", data: userBase64 } }];

  cands.forEach(function (it, i) {
    if (!imgs[i]) return;
    sent.push(it);
    parts.push({ text: "CANDIDATE " + (sent.length - 1) + " (title: " + it.title + "):" });
    parts.push({ inline_data: { mime_type: imgs[i].mime, data: imgs[i].data } });
  });
  if (!sent.length) return false;

  try {
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
      GEMINI_MODEL + ":generateContent?key=" + encodeURIComponent(apiKey);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: parts }],
        generationConfig: { temperature: 0, response_mime_type: "application/json" }
      })
    });
    const payload = await res.json();
    if (!res.ok || payload.error) return false;
    const raw = (payload.candidates && payload.candidates[0] && payload.candidates[0].content &&
      payload.candidates[0].content.parts && payload.candidates[0].content.parts[0] &&
      payload.candidates[0].content.parts[0].text) || "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/gi, "").trim());
    (parsed.matches || []).forEach(function (m) {
      const it = sent[Number(m.index)];
      if (!it) return;
      const score = clamp(parseInt(m.score, 10) || 0, 0, 100);
      it.vscore = score;
      it.vreason = String(m.reason || "").slice(0, 110);
      it.verified = m.sameDesign === true && score >= VISUAL_MATCH_MIN;
    });
    sent.sort(function (a, b) { return (b.vscore || 0) - (a.vscore || 0); });
    visualItems = sent; // keep only the listings that were actually compared
    return true;
  } catch (_) {
    return false;
  }
}

function tokenizeTitle(t) {
  return String(t || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9-]+/g, " ").split(" ")
    .filter(function (w) {
      return w.length >= 2 && TITLE_NOISE.indexOf(w) === -1 && !/^\d{1,2}$/.test(w) && !/^\d{2}x\d{2}$/.test(w);
    });
}

// Build a short search from the words real sellers used in the matched listings' titles
function queryFromTitles(titles) {
  const lists = titles.map(tokenizeTitle);
  if (!lists.length || !lists[0].length) return "";
  const need = lists.length >= 3 ? 2 : lists.length;
  const out = [];
  lists[0].forEach(function (tok) {
    if (out.indexOf(tok) !== -1) return;
    const count = lists.filter(function (l) { return l.indexOf(tok) !== -1; }).length;
    if (count >= need) out.push(tok);
  });
  const picked = out.length >= 2 ? out : lists[0];
  return picked.slice(0, 5).join(" ");
}

function adoptMatchedQuery() {
  const good = visualItems.filter(function (it) { return it.verified; });
  if (!good.length) return false;
  const q = queryFromTitles(good.slice(0, 3).map(function (it) { return it.title; }));
  if (!q) return false;
  if (lastReport) {
    lastReport.mustHaveWords = q.split(" ").slice(0, 4);
    lastReport.exactPhrase = "";
  }
  const clean = updateCompLinks(q, { keepCandidates: true });
  fetchEbayBrowseItems(clean);
  return true;
}

async function fetchEbayVisualMatches(base64Jpeg) {
  if (!backendAvailable || !base64Jpeg) return;
  const reqId = ++visualRequestId;
  visualState = "searching";
  visualError = "";
  deferSold = true; // sold lookups cost credits, so wait for the better search words
  renderVisual();

  let stale = false;
  let adopted = false;
  try {
    const res = await fetch("/api/ebay/search-by-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64Jpeg })
    });
    const data = await res.json();
    if (reqId !== visualRequestId) { stale = true; return; }
    if (!res.ok) {
      visualState = "failed";
      visualError = "eBay visual search failed. Check your eBay keys and API access.";
      renderVisual();
      return;
    }

    visualItems = (data.itemSummaries || []).map(function (it) { return normalizeListing(it, false); });
    if (!visualItems.length) {
      visualState = "done";
      renderVisual();
      return;
    }

    visualState = "verifying";
    renderVisual();
    const ok = await verifyVisualMatches(base64Jpeg);
    if (reqId !== visualRequestId) { stale = true; return; }

    visualState = ok ? "done" : "unverified";
    renderVisual();
    deferSold = false;
    if (ok) adopted = adoptMatchedQuery();
    runValuation();
  } catch (_) {
    if (reqId !== visualRequestId) { stale = true; return; }
    visualState = "failed";
    visualError = "Visual search isn't available right now.";
    renderVisual();
  } finally {
    if (!stale) {
      deferSold = false;
      if (!adopted) fetchEbayBrowseItems(currentQueryText);
    }
  }
}

function compressDataUrl(dataUrl, maxDim, quality) {
  const limit = maxDim || 1400;
  const q = quality || 0.88;
  return new Promise(function (resolve, reject) {
    const img = new Image();
    img.onload = function () {
      let w = img.width;
      let h = img.height;
      if (w > limit || h > limit) {
        if (w > h) {
          h = Math.round((h * limit) / w);
          w = limit;
        } else {
          w = Math.round((w * limit) / h);
          h = limit;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const outUrl = canvas.toDataURL("image/jpeg", q);
      resolve({
        dataUrl: outUrl,
        base64: outUrl.split(",")[1],
        mimeType: "image/jpeg"
      });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function compressImageFile(file, maxDim, quality) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function (e) {
      compressDataUrl(e.target.result, maxDim, quality).then(resolve).catch(reject);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function buildEvidencePrompt(multiMode) {
  const intro = multiMode
    ? "You are a vintage & secondhand garment authenticator. Analyze all attached photos together (Tag/RN#, Front, and/or Back)."
    : "You are a vintage & secondhand garment authenticator. Analyze this photo and state only concrete physical evidence.";

  return [
    intro,
    "Do NOT invent tag text, RN numbers, or style codes that are not visible. If something is not visible, say so.",
    "Date the garment from specific clues and cite each clue you used in evidencePoints: single- vs double-stitched hems, 'Made in USA' vs other countries, RN/WPL/CA numbers, union labels (ILGWU/UNITE), care label format (paper, sewn-in, multi-language), zipper brand and hardware, copyright year printed on graphics, tag font and logo version.",
    "Never infer an era from style alone. Lower confidenceScore whenever the neck tag or care tag is missing or blurry, and set tagVisible to false if no tag is clearly readable.",
    "Grade condition from visible wear only (fading, cracking, stains, holes, pilling).",
    "Give priceLow and priceHigh as a realistic US resale range in USD for this item in this condition, and explain it in one sentence in priceReasoning. If you cannot tell what the item is, use 0 for both.",
    "Write queries the way an eBay seller would title the listing: brand + the most distinctive words printed on the item (graphic text, team, character, style code). Prefer fewer, more distinctive words over many generic ones.",
    "Also return: brand, styleCode (only if clearly readable, else empty string), exactPhrase (the 2-3 word phrase that most uniquely identifies the design, as it would appear in a title), and mustHaveWords (2-4 lowercase words any matching listing title should contain).",
    "Build 3 candidate queries (5-7 specific words each, avoiding generic words like 'shirt' or 'tee'):",
    "1) Tag / Style Code query (if tag/code visible, else exact visual graphic + color)",
    "2) Visual / Era query (graphic layout, font/arch, logo placement, color, era)",
    "3) Broad brand + visual fallback",
    "Return ONLY valid JSON with keys:",
    '{"itemName":"Specific title","estimatedEra":"e.g. Modern / Y2K / 90s","tagOrStyleCodes":"Visible codes or None visible","brand":"Nike","styleCode":"","exactPhrase":"arched block swoosh","mustHaveWords":["nike","arched","swoosh"],"tagVisible":true,"confidenceScore":65,"evidencePoints":["Physical observation 1","Physical observation 2"],"condition":"Good: light fading, no stains","rarity":"Common / Uncommon / Rare, with a short reason","priceLow":25,"priceHigh":45,"priceReasoning":"One sentence on why this range","candidateQueries":[{"label":"Code/Tag","query":"..."},{"label":"Visual/Era","query":"..."},{"label":"Broad","query":"..."}],"ebayShortQuery":"Best primary 5-7 word query","suggestedSalePrice":35,"resellerTip":"What to check on tag/stitching before buying"}'
  ].join("\n");
}

function applyEvidenceResult(parsed, fallbackQuery, primaryBase64) {
  lastReport = parsed;
  const candidates = Array.isArray(parsed.candidateQueries) ? parsed.candidateQueries : [];
  const primaryRaw = parsed.ebayShortQuery
    || (candidates[0] && candidates[0].query)
    || parsed.itemName
    || fallbackQuery;

  const cleanQuery = updateCompLinks(primaryRaw, { keepCandidates: true });
  renderCandidatePills(candidates, cleanQuery);
  renderEvidenceReport(parsed);

  const titleText = parsed.itemName || cleanQuery;
  const suggestedNum = Number(parsed.suggestedSalePrice) || 0;
  lastReport = parsed;
  scanKey = cleanQuery;
  resetVisual();

  if ($("itemTitleLabel")) $("itemTitleLabel").textContent = titleText;

  saveRecentScan({
    title: titleText,
    query: cleanQuery,
    salePrice: suggestedNum,
    report: parsed
  });

  if (primaryBase64 && backendAvailable) deferSold = true;
  fetchEbayBrowseItems(cleanQuery);
  if (primaryBase64) {
    fetchEbayVisualMatches(primaryBase64);
  }
}

async function analyzePhotoWithGemini(file) {
  const apiKey = localStorage.getItem(GEMINI_KEY_STORAGE) || "";
  if (!apiKey) {
    if ($("settingsModal")) $("settingsModal").classList.remove("hidden");
    return;
  }

  const compressed = await compressImageFile(file, 1400, 0.88);
  if ($("previewImg")) $("previewImg").src = compressed.dataUrl;
  if ($("previewWrap")) $("previewWrap").classList.remove("hidden");
  if ($("loaderBox")) $("loaderBox").classList.remove("hidden");
  if ($("loaderText")) $("loaderText").textContent = "Inspecting visual & tag evidence...";

  try {
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
      GEMINI_MODEL + ":generateContent?key=" + encodeURIComponent(apiKey);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: buildEvidencePrompt(false) },
            { inline_data: { mime_type: compressed.mimeType, data: compressed.base64 } }
          ]
        }],
        generationConfig: { temperature: 0.1, response_mime_type: "application/json" }
      })
    });

    const payload = await res.json();
    if (!res.ok || payload.error) {
      throw new Error((payload.error && payload.error.message) || ("HTTP " + res.status));
    }

    const raw = (payload.candidates &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      payload.candidates[0].content.parts &&
      payload.candidates[0].content.parts[0] &&
      payload.candidates[0].content.parts[0].text) || "{}";

    const parsed = JSON.parse(raw.replace(/```json|```/gi, "").trim());
    applyEvidenceResult(parsed, $("searchQueryInput") ? $("searchQueryInput").value : "", compressed.base64);
  } catch (err) {
    if ($("resellerTip")) $("resellerTip").textContent = "Scan error: " + err.message;
  } finally {
    if ($("loaderBox")) $("loaderBox").classList.add("hidden");
  }
}

async function applySlotCompressed(slotKey, compressed) {
  multiPhotos[slotKey] = compressed;
  const cap = slotKey.charAt(0).toUpperCase() + slotKey.slice(1);
  if ($("thumb" + cap)) {
    $("thumb" + cap).src = compressed.dataUrl;
    $("thumb" + cap).classList.remove("hidden");
  }
  if ($("status" + cap)) $("status" + cap).textContent = "Photo ready ✓";
  if ($("slotLabel" + cap)) $("slotLabel" + cap).classList.add("filled");
  updateMultiScanButton();
}

async function handleSlotSelect(slotKey, file) {
  if (!file) return;
  const maxDim = slotKey === "tag" ? 1800 : 1280;
  const compressed = await compressImageFile(file, maxDim, 0.9);
  await applySlotCompressed(slotKey, compressed);
}

function updateMultiScanButton() {
  const btn = $("runMultiScanBtn");
  if (!btn) return;
  const count = Object.values(multiPhotos).filter(Boolean).length;
  if (count > 0) {
    btn.classList.remove("hidden");
    btn.textContent = "✨ Analyze Attached Photos (" + count + ")";
  } else {
    btn.classList.add("hidden");
  }
}

function clearMultiPhotos() {
  ["tag", "front", "back"].forEach(function (key) {
    multiPhotos[key] = null;
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    if ($("thumb" + cap)) {
      $("thumb" + cap).classList.add("hidden");
      $("thumb" + cap).src = "";
    }
    if ($("status" + cap)) $("status" + cap).textContent = "No photo";
    if ($("slotLabel" + cap)) $("slotLabel" + cap).classList.remove("filled");
    if ($("input" + cap + "Cam")) $("input" + cap + "Cam").value = "";
    if ($("input" + cap + "File")) $("input" + cap + "File").value = "";
  });
  updateMultiScanButton();
}

function stopCameraStream() {
  if (activeCamStream) {
    activeCamStream.getTracks().forEach(function (t) { t.stop(); });
    activeCamStream = null;
  }
  if ($("camVideo")) {
    $("camVideo").srcObject = null;
  }
}

function closeCameraModal() {
  stopCameraStream();
  activeCamTarget = null;
  if ($("cameraModal")) $("cameraModal").classList.add("hidden");
}

async function openCameraForTarget(target) {
  activeCamTarget = target;
  const labelMap = {
    quick: "📷 Quick Item Photo",
    tag: "📷 Snap 1. Tag / RN#",
    front: "📷 Snap 2. Front",
    back: "📷 Snap 3. Back"
  };
  if ($("camModalTitle")) $("camModalTitle").textContent = labelMap[target] || "📷 Take Photo";
  if ($("camStatusText")) $("camStatusText").textContent = "Starting camera...";
  if ($("cameraModal")) $("cameraModal").classList.remove("hidden");

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (isMobile && target !== "quick") {
    const cap = target.charAt(0).toUpperCase() + target.slice(1);
    const camInput = $("input" + cap + "Cam");
    if (camInput) {
      closeCameraModal();
      camInput.click();
      return;
    }
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setTimeout(function () {
      const savedTarget = activeCamTarget;
      closeCameraModal();
      if (savedTarget === "quick" && $("cameraInput")) $("cameraInput").click();
      else if (savedTarget && $("input" + savedTarget.charAt(0).toUpperCase() + savedTarget.slice(1) + "Cam")) {
        $("input" + savedTarget.charAt(0).toUpperCase() + savedTarget.slice(1) + "Cam").click();
      }
    }, 450);
    return;
  }

  try {
    stopCameraStream();
    activeCamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    if ($("camVideo")) {
      $("camVideo").srcObject = activeCamStream;
    }
    if ($("camStatusText")) $("camStatusText").textContent = "Ready — tap Snap Photo to capture.";
  } catch (err) {
    if ($("camStatusText")) {
      $("camStatusText").textContent = "Camera unavailable (" + err.message + "). Opening camera picker...";
    }
    setTimeout(function () {
      const savedTarget = activeCamTarget;
      closeCameraModal();
      if (savedTarget === "quick" && $("cameraInput")) $("cameraInput").click();
      else if (savedTarget && $("input" + savedTarget.charAt(0).toUpperCase() + savedTarget.slice(1) + "Cam")) {
        $("input" + savedTarget.charAt(0).toUpperCase() + savedTarget.slice(1) + "Cam").click();
      }
    }, 650);
  }
}

async function captureFromCameraModal() {
  const video = $("camVideo");
  const canvas = $("camCanvas");
  const target = activeCamTarget;
  if (!video || !canvas || !target || !video.videoWidth) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const rawDataUrl = canvas.toDataURL("image/jpeg", 0.92);

  closeCameraModal();

  if (target === "quick") {
    const compressed = await compressDataUrl(rawDataUrl, 1400, 0.88);
    const blob = await (await fetch(compressed.dataUrl)).blob();
    const file = new File([blob], "quick-scan.jpg", { type: "image/jpeg" });
    analyzePhotoWithGemini(file);
  } else {
    const maxDim = target === "tag" ? 1800 : 1280;
    const compressed = await compressDataUrl(rawDataUrl, maxDim, 0.9);
    await applySlotCompressed(target, compressed);
  }
}

async function runMultiAngleScan() {
  const apiKey = localStorage.getItem(GEMINI_KEY_STORAGE) || "";
  if (!apiKey) {
    if ($("settingsModal")) $("settingsModal").classList.remove("hidden");
    return;
  }

  const parts = [{ text: buildEvidencePrompt(true) }];
  const labels = {
    tag: "PHOTO 1 - NECK / CARE TAG & RN# CLOSE-UP:",
    front: "PHOTO 2 - FRONT VIEW OF GARMENT:",
    back: "PHOTO 3 - BACK VIEW OF GARMENT:"
  };

  let attachedCount = 0;
  let firstPreview = null;
  let primaryBase64 = null;

  ["tag", "front", "back"].forEach(function (key) {
    if (multiPhotos[key]) {
      attachedCount++;
      parts.push({ text: labels[key] });
      parts.push({
        inline_data: {
          mime_type: multiPhotos[key].mimeType,
          data: multiPhotos[key].base64
        }
      });
    }
  });

  if (attachedCount === 0) return;

  const hero = multiPhotos.front || multiPhotos.back || multiPhotos.tag;
  firstPreview = hero.dataUrl;
  primaryBase64 = hero.base64;

  if (firstPreview && $("previewImg")) $("previewImg").src = firstPreview;
  if ($("previewWrap")) $("previewWrap").classList.remove("hidden");
  if ($("loaderBox")) $("loaderBox").classList.remove("hidden");
  if ($("loaderText")) $("loaderText").textContent = "Cross-checking " + attachedCount + " angle(s) for evidence...";

  try {
    const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
      GEMINI_MODEL + ":generateContent?key=" + encodeURIComponent(apiKey);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: parts }],
        generationConfig: { temperature: 0.1, response_mime_type: "application/json" }
      })
    });

    const payload = await res.json();
    if (!res.ok || payload.error) {
      throw new Error((payload.error && payload.error.message) || ("HTTP " + res.status));
    }

    const raw = (payload.candidates &&
      payload.candidates[0] &&
      payload.candidates[0].content &&
      payload.candidates[0].content.parts &&
      payload.candidates[0].content.parts[0] &&
      payload.candidates[0].content.parts[0].text) || "{}";

    const parsed = JSON.parse(raw.replace(/```json|```/gi, "").trim());
    applyEvidenceResult(parsed, $("searchQueryInput") ? $("searchQueryInput").value : "", primaryBase64);
  } catch (err) {
    if ($("resellerTip")) $("resellerTip").textContent = "Multi-angle scan error: " + err.message;
  } finally {
    if ($("loaderBox")) $("loaderBox").classList.add("hidden");
  }
}

function initApp() {
  const visualListEl = $("visualList");
  if (visualListEl) {
    visualListEl.addEventListener("click", function (ev) {
      if (ev.target.closest && ev.target.closest("a")) return;
      const card = ev.target.closest ? ev.target.closest("[data-vidx]") : null;
      if (!card) return;
      const it = visualItems[parseInt(card.getAttribute("data-vidx"), 10)];
      if (!it) return;
      it.verified = !it.verified;
      renderVisual();
      runValuation();
    });
  }
  if ($("modelBadge")) $("modelBadge").textContent = GEMINI_MODEL;
  if ($("apiKeyInput")) $("apiKeyInput").value = localStorage.getItem(GEMINI_KEY_STORAGE) || "";

  if ($("openSettingsBtn") && $("settingsModal")) {
    $("openSettingsBtn").addEventListener("click", function () {
      $("settingsModal").classList.remove("hidden");
    });
  }
  if ($("cancelSettingsBtn") && $("settingsModal")) {
    $("cancelSettingsBtn").addEventListener("click", function () {
      $("settingsModal").classList.add("hidden");
    });
  }
  if ($("saveSettingsBtn") && $("settingsModal")) {
    $("saveSettingsBtn").addEventListener("click", function () {
      const val = $("apiKeyInput") ? $("apiKeyInput").value.trim() : "";
      localStorage.setItem(GEMINI_KEY_STORAGE, val);
      $("settingsModal").classList.add("hidden");
    });
  }

  if ($("quickCamBtn")) {
    $("quickCamBtn").addEventListener("click", function () {
      openCameraForTarget("quick");
    });
  }
  if ($("cameraInput")) {
    $("cameraInput").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) analyzePhotoWithGemini(e.target.files[0]);
    });
  }
  if ($("galleryInput")) {
    $("galleryInput").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) analyzePhotoWithGemini(e.target.files[0]);
    });
  }

  document.querySelectorAll("[data-cam-slot]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const slot = btn.getAttribute("data-cam-slot");
      if (slot) openCameraForTarget(slot);
    });
  });

  ["Tag", "Front", "Back"].forEach(function (cap) {
    const key = cap.toLowerCase();
    if ($("input" + cap + "Cam")) {
      $("input" + cap + "Cam").addEventListener("change", function (e) {
        if (e.target.files && e.target.files[0]) handleSlotSelect(key, e.target.files[0]);
      });
    }
    if ($("input" + cap + "File")) {
      $("input" + cap + "File").addEventListener("change", function (e) {
        if (e.target.files && e.target.files[0]) handleSlotSelect(key, e.target.files[0]);
      });
    }
  });

  if ($("closeCamBtn")) {
    $("closeCamBtn").addEventListener("click", closeCameraModal);
  }
  if ($("snapPhotoBtn")) {
    $("snapPhotoBtn").addEventListener("click", captureFromCameraModal);
  }

  if ($("clearMultiBtn")) {
    $("clearMultiBtn").addEventListener("click", clearMultiPhotos);
  }
  if ($("runMultiScanBtn")) {
    $("runMultiScanBtn").addEventListener("click", runMultiAngleScan);
  }

  if ($("searchBtn")) {
    $("searchBtn").addEventListener("click", function () {
      const currentVal = $("searchQueryInput") ? $("searchQueryInput").value : "";
      lastReport = null;
      const q = updateCompLinks(currentVal);
      if ($("itemTitleLabel")) $("itemTitleLabel").textContent = q;
      lastReport = null;
      scanKey = q;
      resetVisual();
      saveRecentScan({
        title: q,
        query: q,
        salePrice: 0,
        report: null
      });
      fetchEbayBrowseItems(q);
    });
  }

  ["buyCostInput", "salePriceInput", "shippingInput", "targetProfitInput"].forEach(function (id) {
    if ($(id)) {
      $(id).addEventListener("input", calculateProfitAndMaxBuy);
    }
  });

  ["soldCountInput", "activeCountInput"].forEach(function (id) {
    if ($(id)) {
      $(id).addEventListener("input", calculateSellThroughRate);
    }
  });

  if ($("strParseBtn") && $("strQuickPasteInput")) {
    $("strParseBtn").addEventListener("click", function () {
      parseSoldActiveFromText($("strQuickPasteInput").value);
    });
    $("strQuickPasteInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        parseSoldActiveFromText($("strQuickPasteInput").value);
      }
    });
  }

  if ($("clearHistoryBtn")) {
    $("clearHistoryBtn").addEventListener("click", clearRecentScans);
  }

  const initialQuery = $("searchQueryInput") ? $("searchQueryInput").value : "Nike arched block swoosh brown";
  updateCompLinks(initialQuery);
  checkJavaBackend();
  calculateProfitAndMaxBuy();
  calculateSellThroughRate();
  renderRecentScans();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
