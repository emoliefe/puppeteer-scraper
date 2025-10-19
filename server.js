const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function"
    ? puppeteer.executablePath()
    : undefined);

const ok = (req) =>
  !TOKEN ||
  req.query.token === TOKEN ||
  req.header("x-token") === TOKEN;

const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withWatchdog(promise, ms, onTimeout) {
  let to;
  const timeout = new Promise((_, rej) => {
    to = setTimeout(() => {
      if (onTimeout) try { onTimeout(); } catch {}
      rej(new Error("watchdog_timeout"));
    }, ms);
  });
  try {
    const res = await Promise.race([promise, timeout]);
    clearTimeout(to);
    return res;
  } catch (e) {
    clearTimeout(to);
    throw e;
  }
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      if (sel.startsWith("//")) {
        const nodes = await page.$x(sel);
        if (nodes && nodes.length) { await nodes[0].click(); return true; }
      } else {
        const h = await page.$(sel);
        if (h) { await h.click(); return true; }
      }
    } catch {}
  }
  return false;
}

function normDate(s) {
  const m = s && s.match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  const dd = String(m[1]).padStart(2, "0");
  const mm = String(m[2]).padStart(2, "0");
  const yyyy = m[3];
  return `${dd}.${mm}.${yyyy}`;
}

async function waitPriceText(page) {
  // 1) Genel bodyText taraması
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => document.body.innerText || "");
    const m = txt.match(
      /(?:₺|\bTL\b|\bEUR\b|\bUSD\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺|EUR|USD)\b/i
    );
    if (m) return m[0].replace(/\s+/g, " ").trim();
    await sleep(250);
  }
  // 2) Klasik “Hesap/Toplam/Price” alanları
  const priceSelectors = [
    "[class*='price']",
    ".price,.fiyat,.tour-price,.calculated-price,.result-price,.total-price"
  ];
  for (const sel of priceSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 2000 });
      const v = await page.$eval(sel, (el) => el.textContent || "");
      const mm = v && v.match(
        /(?:₺|\bTL\b|\bEUR\b|\bUSD\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺|EUR|USD)\b/i
      );
      if (mm) return mm[0].replace(/\s+/g, " ").trim();
    } catch {}
  }
  return "";
}

async function openDatesUI(page) {
  // Bazı sayfalarda “Tarihler” sadece sayfa içi anchor; bazı sayfalarda modal.
  // İkisini de deneyelim.
  await clickFirst(page, [
    "//button[contains(., 'Tüm Tarihler ve Fiyatlar')]",
    "//button[contains(., 'Tüm Tarihler')]",
    "//a[contains(., 'Tüm Tarihler ve Fiyatlar')]",
    "//a[contains(., 'Tüm Tarihler')]",
    "//a[contains(., 'Tarihler')]",
    "a[href*='tarih'], button[data-bs-toggle='modal'], [class*='tarih']",
  ]);
  await sleep(800);

  // Modal var mı kontrol
  const hasModal = await page.$(".modal.show, .modal.in, [role='dialog']") != null;
  return { hasModal };
}

async function collectDateButtons(page) {
  // Modal içi ya da sayfa içi düğme/hücreler
  const handles =
    (await page.$$(
      ".modal.show [data-date], .modal.show .date, .modal.show .day, .modal.show button, .modal.show a," +
        "[data-date], .date, .day, button.date, a.date"
    )) || [];
  // Bu düğmelerin görünen label’larından dd.mm.yyyy çıkar
  const pairs = [];
  for (const h of handles) {
    try {
      const label = await page.evaluate(
        (el) => (el.innerText || el.getAttribute("data-date") || "").trim(),
        h
      );
      const d = normDate(label);
      if (d) pairs.push({ handle: h, date: d, label });
    } catch {}
  }
  return pairs;
}

async function findDatesFromText(page) {
  const txt = await page.evaluate(() => document.body.innerText || "");
  return uniq((txt.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).map(normDate));
}

async function clickHesaplaNear(page, anchorHandle) {
  // Seçilen tarih düğmesinin “yakınındaki” hesapla/fiyat butonunu bul
  // 1) Aynı kart içinde buton
  try {
    await anchorHandle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  } catch {}
  // Yakın butonları deneyelim
  return await clickFirst(page, [
    "//button[contains(., 'Hesapla')]",
    "//a[contains(., 'Hesapla')]",
    "//button[contains(., 'Fiyat')]", // bazen “Fiyat Hesapla”
    "//a[contains(., 'Fiyat')]",
    "button:has-text('Hesapla')", // Playwright benzeri; bazı chromium’larda çalışmayabilir ama deneriz
    "a:has-text('Hesapla')",
  ]);
}

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Tanılama
app.get("/probe", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1366,900",
        "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      ],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

    // Çerezleri kapatmayı dene
    await clickFirst(page, [
      "//button[contains(., 'Kabul')]", "//button[contains(., 'Tamam')]", "//button[contains(., 'Accept')]",
      "button#onetrust-accept-btn-handler"
    ]);

    const openers = {
      "Tüm Tarihler ve Fiyatlar": await clickFirst(page, ["//button[contains(., 'Tüm Tarihler ve Fiyatlar')]", "//a[contains(., 'Tüm Tarihler ve Fiyatlar')]"]),
      "Tüm Tarihler": await clickFirst(page, ["//button[contains(., 'Tüm Tarihler')]", "//a[contains(., 'Tüm Tarihler')]"]),
      "Tarihler": await clickFirst(page, ["//a[contains(., 'Tarihler')]", "a[href*='tarih']"]),
    };

    const hasModal = !!(await page.$(".modal.show, .modal.in, [role='dialog']"));
    const modalDateNodes = hasModal ? (await collectDateButtons(page)).length : 0;
    const pageDateNodes = !hasModal ? (await collectDateButtons(page)).length : 0;
    const textDates = await findDatesFromText(page);

    const hesaplaButtons = (await page.$x("//button[contains(., 'Hesapla')]")).length
      + (await page.$x("//a[contains(., 'Hesapla')]")).length;

    res.json({
      ok: true,
      url,
      openers: {
        "Tüm Tarihler ve Fiyatlar": { clicked: !!openers["Tüm Tarihler ve Fiyatlar"] },
        "Tüm Tarihler": { clicked: !!openers["Tüm Tarihler"] },
        "Tarihler": { clicked: !!openers["Tarihler"] },
      },
      modalPresent: hasModal,
      dateCandidates: hasModal ? modalDateNodes : pageDateNodes,
      textDateNodes: textDates.length,
      hesaplaButtons
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// Asıl akış: tıkla → hesapla → tarih=fiyat eşle
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "8", 10) || 8, 20));
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    const result = await withWatchdog((async () => {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: chromePath,
        args: [
          "--no-sandbox", "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", "--window-size=1366,900",
          "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        ],
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(90000);

      await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });

      // Çerezleri kapat
      await clickFirst(page, [
        "//button[contains(., 'Kabul')]", "//button[contains(., 'Tamam')]", "//button[contains(., 'Accept')]",
        "button#onetrust-accept-btn-handler"
      ]);

      const { hasModal } = await openDatesUI(page);

      // Aday tarih düğmeleri
      let buttons = await collectDateButtons(page);

      // Hiç düğme yoksa metinden tarih bul
      if (!buttons.length) {
        const textDates = await findDatesFromText(page);
        buttons = textDates.map((d) => ({ handle: null, date: d, label: d }));
      }

      const picked = uniq(buttons.map(b => b.date)).slice(0, limit);

      const schedule = [];
      const failed = [];

      for (const d of picked) {
        try {
          if (hasModal) {
            // Modal içinde bu tarihi içeren düğmeyi bulup tıkla
            const nodes = await page.$x(`.//div[contains(@class,'modal') and contains(@class,'show')]//*[contains(normalize-space(.), '${d}')]`);
            if (nodes && nodes.length) {
              await nodes[0].click();
            } else {
              // sayfada dene
              const nx = await page.$x(`//*[contains(normalize-space(.), '${d}')]`);
              if (nx && nx.length) await nx[0].click();
            }
          } else {
            // sayfa içinde bu tarihi içeren bir node’u tıkla
            const nx = await page.$x(`//*[contains(normalize-space(.), '${d}')]`);
            if (nx && nx.length) await nx[0].click();
          }

          // Yakındaki “Hesapla”yı tıkla
          const pressed = await clickHesaplaNear(page, (await page.$x(`//*[contains(normalize-space(.), '${d}')]`))[0] || (await page.$("body")));
          if (pressed) {
            // kısa ağ bekleme
            try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }); } catch {}
          } else {
            // bazen hesap gerekmeden fiyat görünür
          }

          const price = await waitPriceText(page);
          if (price) {
            schedule.push({ date: d, price });
          } else {
            failed.push({ date: d, reason: "price_not_found" });
          }
        } catch (e) {
          failed.push({ date: d, reason: String(e.message || e) });
        }
      }

      return { ok: true, url, schedule: uniq(schedule.map(j => JSON.stringify(j))).map(s => JSON.parse(s)), failed };
    })(), 45_000, () => { /* istek çok uzarsa */ });

    res.json(result);
  } catch (e) {
    // Watchdog ya da başka hata → o ana kadarki sonuç yoksa boş dön
    res.status(500).json({ error: e.message || String(e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servis hazır:", PORT);
});
