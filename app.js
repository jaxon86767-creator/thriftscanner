const GEMINI_KEY_STORAGE = "thriftscan_gemini_key";
const RECENT_SCANS_STORAGE = "thriftscan_recent_scans_v2";
const GEMINI_MODEL = "gemini-3.8-flash";
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
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .replace(/\b(mens|womens|used|new|pre-owned|item|garment)\b/gi, " ")
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

function renderDirectCompsFeed(cleanQuery, exactPlus, plus) {
  const listEl = $("directCompsList");
  const metaEl = $("compsFeedMeta");
  if (!listEl) return;

  const qPlus = plus || encodeURIComponent(cleanQuery).replace(/%20/g, "+");
  const qExact = exactPlus || encodeURIComponent('"' + cleanQuery + '"').replace(/%20/g, "+");

  const rows = [
    {
      label: "Sold & Completed (Recent First)",
      tag: "SOLD",
      href: "https://www.ebay.com/sch/i.html?_nkw=" + qPlus + "&LH_Sold=1&LH_Complete=1&_sop=13"
    },
    {
      label: "Exact Phrase Sold Comps",
      tag: "EXACT SOLD",
      href: "https://www.ebay.com/sch/i.html?_nkw=" + qExact + "&LH_Sold=1&LH_Complete=1&_sop=13"
    },
    {
      label: "Active Buy-It-Now (Lowest + Ship)",
      tag: "ACTIVE",
      href: "https://www.ebay.com/sch/i.html?_nkw=" + qPlus + "&LH_BIN=1&_sop=15"
    },
    {
      label: "Active Auctions (Ending Soonest)",
      tag: "AUCTION",
      href: "https://www.ebay.com/sch/i.html?_nkw=" + qPlus + "&LH_Auction=1&_sop=1"
    }
  ];

  const modeNote = backendAvailable
    ? '<div class="empty-history">Live eBay Browse API active for this query.</div>'
    : '<div class="empty-history">Browser-Only Mode: tap a direct eBay comp link below to verify sold prices:</div>';

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

function updateCompLinks(query, opts) {
  const clean = buildCompQuery(query, 7) || "Nike arched block swoosh brown";
  if ($("searchQueryInput")) $("searchQueryInput").value = clean;

  const plus = encodeURIComponent(clean).replace(/%20/g, "+");
  const exactPlus = encodeURIComponent('"' + clean + '"').replace(/%20/g, "+");
  const encoded = encodeURIComponent(clean);

  if ($("linkEbaySold")) {
    $("linkEbaySold").href = "https://www.ebay.com/sch/i.html?_nkw=" + plus + "&LH_Sold=1&LH_Complete=1&_sop=13";
  }
  if ($("linkEbayExactSold")) {
    $("linkEbayExactSold").href = "https://www.ebay.com/sch/i.html?_nkw=" + exactPlus + "&LH_Sold=1&LH_Complete=1&_sop=13";
  }
  if ($("linkEbayActive")) {
    $("linkEbayActive").href = "https://www.ebay.com/sch/i.html?_nkw=" + plus + "&_sop=15";
  }
  if ($("linkPoshSold")) {
    $("linkPoshSold").href = "https://poshmark.com/search?query=" + encoded + "&availability=sold_out";
  }
  if ($("linkDepopSold")) {
    $("linkDepopSold").href = "https://www.google.com/search?q=" + encodeURIComponent('site:depop.com "Sold" ' + clean);
  }

  if (!opts || !opts.keepCandidates) {
    renderCandidatePills([], clean);
  }

  renderDirectCompsFeed(clean, exactPlus, plus);
  return clean;
}

function renderEvidenceReport(parsed) {
  const eraEl = $("evidenceEra");
  const codesEl = $("evidenceCodes");
  const badgeEl = $("confidenceBadge");
  const listEl = $("evidenceList");
  const tipEl = $("resellerTip");

  const era = parsed.estimatedEra || "Needs tag & hem stitch check";
  const blank = parsed.blankOrTagType ? " | Blank/Tag: " + parsed.blankOrTagType : "";
  const stitch = parsed.stitchingNotes ? " | Stitch: " + parsed.stitchingNotes : "";
  const codes = parsed.tagOrStyleCodes || "None visible";
  const conf = Math.max(0, Math.min(100, parseInt(parsed.confidenceScore, 10) || 45));
  const points = Array.isArray(parsed.evidencePoints) && parsed.evidencePoints.length
    ? parsed.evidencePoints
    : ["Snap a close-up of the neck tag, care tag style code, and sleeve hem stitch to lock in the era."];

  if (eraEl) eraEl.textContent = "Era: " + era + blank;
  if (codesEl) codesEl.textContent = "Codes / RN#: " + codes + stitch;

  if (badgeEl) {
    badgeEl.textContent = "Confidence: " + conf + "%";
    badgeEl.className = "confidence-pill " + (conf >= 78 ? "high" : (conf >= 52 ? "med" : "low"));
  }

  if (listEl) {
    listEl.innerHTML = points.slice(0, 5).map(function (pt) {
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

      const clean = updateCompLinks(entry.query);
      if ($("itemTitleLabel")) $("itemTitleLabel").textContent = entry.title || clean;
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

  localStorage.setItem(RECENT_SCANS_STORAGE, JSON.stringify(filtered.slice(0, 12)));
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
}

function renderEbayApiItems(data, fallbackQuery) {
  if (!$("ebayApiResults")) return;
  if (!data || !Array.isArray(data.itemSummaries) || !data.itemSummaries.length) {
    $("ebayApiResults").classList.add("hidden");
    return;
  }

  if (typeof data.total === "number" && $("activeCountInput")) {
    $("activeCountInput").value = String(data.total);
    calculateSellThroughRate();
  }

  const items = data.itemSummaries.slice(0, 5);
  $("ebayApiResults").innerHTML = items.map(function (it) {
    const price = it.price && it.price.value ? "$" + Number(it.price.value).toFixed(2) : "N/A";
    const url = it.itemWebUrl || "#";
    return (
      '<a class="api-item" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">' +
      "<span>" + escapeHtml(it.title || fallbackQuery) + "</span>" +
      "<strong>" + price + "</strong>" +
      "</a>"
    );
  }).join("");
  $("ebayApiResults").classList.remove("hidden");
}

async function fetchEbayBrowseItems(query) {
  if (!backendAvailable) return;
  try {
    const res = await fetch("/api/ebay/search?q=" + encodeURIComponent(query));
    const data = await res.json();
    if (!res.ok) {
      renderEbayApiItems(null, query);
      return;
    }
    renderEbayApiItems(data, query);
  } catch (_) {
    renderEbayApiItems(null, query);
  }
}

async function fetchEbayVisualMatches(base64Jpeg, queryHint) {
  if (!backendAvailable || !base64Jpeg) return;
  try {
    const res = await fetch("/api/ebay/search-by-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64Jpeg })
    });
    const data = await res.json();
    if (!res.ok) return;
    renderEbayApiItems(data, queryHint);
  } catch (_) {
    // Ignore visual API errors when unconfigured
  }
}

function compressDataUrl(dataUrl, maxDim, quality) {
  const limit = maxDim || 1600;
  const q = quality || 0.90;
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

function buildBidstitchPrompt(multiMode) {
  const intro = multiMode
    ? "You are a senior vintage & secondhand clothing authenticator like Bidstitch. Cross-check all attached photos (Tag/RN#, Front, and/or Back) step by step."
    : "You are a senior vintage & secondhand clothing authenticator like Bidstitch. Inspect every visible detail of this item step by step.";

  return [
    intro,
    "STRICT AUTHENTICATION RULES:",
    "1. TAG & BLANK FINGERPRINTING: Read exact neck tag font, color, copyright year, RN/CA number (e.g., RN 56323 Nike, RN 14806 Carhartt, RN 15763 Hanes), country of manufacture (Made in USA vs Mexico/Honduras/China), blank brand (Screen Stars, Giant, Brockum, Hanes Beefy-T, Anvil, Gildan), and care tag style codes.",
    "2. STITCHING & CONSTRUCTION: Check visible sleeve/bottom hem stitching (single stitch vs double stitch), collar rib width, tubular body vs side seams, and hardware/zipper markings (Talon, YKK, Scovill).",
    "3. GRAPHIC & ERA CHECK: Identify exact print method (screenprint, plastisol, puff, embroidery, all-over print), licensing text, colorway, and exact era (e.g., 1980s, early 90s, late 90s Y2K, 2000s, Modern).",
    "4. NO HALLUCINATION: Never guess or invent RN numbers or style codes not visible in the image. If the neck tag or hem is missing/blurry, explicitly state that and drop confidenceScore below 55.",
    "5. BUILD 3 TARGETED COMP QUERIES (5-7 specific words each):",
    "   - Query 1 ('Tag/Era'): Brand + Era/Tag/Blank + key subject + color",
    "   - Query 2 ('Visual/Style'): Brand + specific graphic/cut/feature + color + item type",
    "   - Query 3 ('Broad Comp'): Core 3-5 word fallback query",
    "Return ONLY valid JSON with these exact keys:",
    '{"itemName":"Exact Brand + Era/Tag + Model/Graphic + Color","estimatedEra":"e.g. Late 90s / Y2K (1998-2002)","blankOrTagType":"e.g. Nike Silver Tag / Screen Stars / Unverified","stitchingNotes":"e.g. Single stitch sleeves / Double stitch / Not visible","tagOrStyleCodes":"Exact visible codes/RN# or None visible","confidenceScore":72,"evidencePoints":["Tag/RN observation","Stitch/construction observation","Graphic/print/color observation","Era/value driver"],"candidateQueries":[{"label":"Tag/Era","query":"..."},{"label":"Visual/Style","query":"..."},{"label":"Broad","query":"..."}],"ebayShortQuery":"Best primary 5-7 word eBay comp query","suggestedSalePrice":45,"resellerTip":"Exact physical check to confirm authenticity & value before buying"}'
  ].join("\n");
}

async function callGeminiWithFallback(apiKey, parts) {
  const modelsToTry = [GEMINI_MODEL, "gemini-3.5-flash-lite"];
  let lastErr = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i];
    try {
      const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
        modelName + ":generateContent?key=" + encodeURIComponent(apiKey);

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

      if ($("modelBadge")) $("modelBadge").textContent = modelName;
      return payload;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Gemini request failed");
}

function applyEvidenceResult(parsed, fallbackQuery, primaryBase64) {
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

  if ($("itemTitleLabel")) $("itemTitleLabel").textContent = titleText;
  if (suggestedNum > 0 && $("salePriceInput")) {
    $("salePriceInput").value = suggestedNum.toFixed(2);
    calculateProfitAndMaxBuy();
  }

  saveRecentScan({
    title: titleText,
    query: cleanQuery,
    salePrice: suggestedNum,
    report: parsed
  });

  fetchEbayBrowseItems(cleanQuery);
  if (primaryBase64) {
    fetchEbayVisualMatches(primaryBase64, cleanQuery);
  }
}

async function analyzePhotoWithGemini(file) {
  const apiKey = localStorage.getItem(GEMINI_KEY_STORAGE) || "";
  if (!apiKey) {
    if ($("settingsModal")) $("settingsModal").classList.remove("hidden");
    return;
  }

  const compressed = await compressImageFile(file, 1600, 0.90);
  if ($("previewImg")) $("previewImg").src = compressed.dataUrl;
  if ($("previewWrap")) $("previewWrap").classList.remove("hidden");
  if ($("loaderBox")) $("loaderBox").classList.remove("hidden");
  if ($("loaderText")) $("loaderText").textContent = "Running Bidstitch tag, stitch & era inspection...";

  try {
    const parts = [
      { text: buildBidstitchPrompt(false) },
      { inline_data: { mime_type: compressed.mimeType, data: compressed.base64 } }
    ];

    const payload = await callGeminiWithFallback(apiKey, parts);
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
  const maxDim = slotKey === "tag" ? 2000 : 1400;
  const compressed = await compressImageFile(file, maxDim, 0.92);
  await applySlotCompressed(slotKey, compressed);
}

function updateMultiScanButton() {
  const btn = $("runMultiScanBtn");
  if (!btn) return;
  const count = Object.values(multiPhotos).filter(Boolean).length;
  if (count > 0) {
    btn.classList.remove("hidden");
    btn.textContent = "✨ Run Tag + Stitch Authentication (" + count + ")";
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
    tag: "📷 Snap 1. Tag / RN# Close-Up",
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
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    if ($("camVideo")) {
      $("camVideo").srcObject = activeCamStream;
    }
    if ($("camStatusText")) $("camStatusText").textContent = "Hold steady — tap Snap Photo when tag text is crisp.";
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
  const rawDataUrl = canvas.toDataURL("image/jpeg", 0.94);

  closeCameraModal();

  if (target === "quick") {
    const compressed = await compressDataUrl(rawDataUrl, 1600, 0.90);
    const blob = await (await fetch(compressed.dataUrl)).blob();
    const file = new File([blob], "quick-scan.jpg", { type: "image/jpeg" });
    analyzePhotoWithGemini(file);
  } else {
    const maxDim = target === "tag" ? 2000 : 1400;
    const compressed = await compressDataUrl(rawDataUrl, maxDim, 0.92);
    await applySlotCompressed(target, compressed);
  }
}

async function runMultiAngleScan() {
  const apiKey = localStorage.getItem(GEMINI_KEY_STORAGE) || "";
  if (!apiKey) {
    if ($("settingsModal")) $("settingsModal").classList.remove("hidden");
    return;
  }

  const parts = [{ text: buildBidstitchPrompt(true) }];
  const labels = {
    tag: "PHOTO 1 - NECK / CARE TAG, BLANK LABEL & RN# CLOSE-UP:",
    front: "PHOTO 2 - FRONT VIEW (GRAPHIC, COLLAR & SLEEVE STITCH):",
    back: "PHOTO 3 - BACK VIEW (BACK PRINT, HEM & SEAMS):"
  };

  let attachedCount = 0;
  let firstPreview = null;
  let primaryBase64 = null;

  ["tag", "front", "back"].forEach(function (key) {
    if (multiPhotos[key]) {
      attachedCount++;
      if (!firstPreview) firstPreview = multiPhotos[key].dataUrl;
      if (!primaryBase64) primaryBase64 = multiPhotos[key].base64;
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

  if (firstPreview && $("previewImg")) $("previewImg").src = firstPreview;
  if ($("previewWrap")) $("previewWrap").classList.remove("hidden");
  if ($("loaderBox")) $("loaderBox").classList.remove("hidden");
  if ($("loaderText")) $("loaderText").textContent = "Authenticating tag, blank & stitch across " + attachedCount + " photo(s)...";

  try {
    const payload = await callGeminiWithFallback(apiKey, parts);
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
      const q = updateCompLinks(currentVal);
      if ($("itemTitleLabel")) $("itemTitleLabel").textContent = q;
      const saleVal = parseFloat($("salePriceInput") && $("salePriceInput").value) || 0;
      saveRecentScan({
        title: q,
        query: q,
        salePrice: saleVal,
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
