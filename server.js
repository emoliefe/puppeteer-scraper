// server.js
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : undefined);

const ok = (req) => !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;
const uniq = (arr) => Array.from(new Set(arr || []));

// =================== yardımcılar ===================
async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      let handle = null;
      if (sel.startsWith("//")) {
        const xs = await page.$x(sel);
        handle = xs && xs[0];
      } else {
        handle = await page.$(sel);
      }
      if (!handle) continue;

      // görünür/erişilebilir yap
      await page.evaluate(el => el.scrollIntoView({ block: "center" }), handle).catch(() => {});
      await handle.hover().catch(() => {});
      await handle.click({ delay: 30 });
      return true;
    } catch (_) {}
  }
  return false;
}

async function waitPriceText(page) {
  const priceCssCandidates = [
    ".price,.fiyat,.tour-price,.calculated-price,.result-price,.total-price,[class*='price']",
    "section, main, #content"
  ];
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    // genel metinden ara
    const txt = await page.evaluate(() => document.body.innerText || "");
    const m = txt.match(
      /(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/i
    );
    if (m) return m[0].replace(/\s+/g, " ").trim();

    // belirgin alanlardan dene
    for (const s of priceCssCandidates) {
      const v = await page.$eval(s, el => el.innerText).catch(() => "");
      if (v && /TL|₺/.test(v)) {
        const mm = v.match(
          /(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/i
        );
        if (mm) return mm[0].replace(/\s+/g, " ").trim();
      }
    }
    await page.waitForTimeout(400);
  }
  return "";
}

function normDate(s) {
  const m = s.match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
}

async function newBrowser() {
  return puppeteer.launch({
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
}

// XPath sabitleri
const HESAPLA_XPATHS = [
  "//*[self::button or self::a][contains(translate(normalize-space(.), 'HESAPLA', 'hesapla'), 'hesapla')]",
  "//*[self::button or self::a][contains(translate(normalize-space(.), 'FIYAT', 'fiyat'), 'fiyat')]",
];

const OPEN_CALENDAR_XPATHS = [
  "//button[contains(translate(.,'TUM TARIHLER','tüm tarihler'),'tüm tarihler')]",
  "//a[contains(translate(.,'TUM TARIHLER','tüm tarihler'),'tüm tarihler')]",
  "//*[contains(@class,'btn') and contains(translate(.,'TARIH','tarih'),'tarih')]",
];

const DATE_XPATH_FALLBACK_MODAL =
  "(.//div[contains(@class,'modal')]//*/self::button | .//div[contains(@class,'modal')]//*[@role='button'] | .//div[contains(@class,'modal')]//td | .//div[contains(@class,'modal')]//a)[not(contains(@class,'disabled'))]";
const DATE_XPATH_FALLBACK_PAGE =
  "(//td[not(contains(@class,'disabled'))] | //button[not(contains(@class,'disabled'))] | //a[not(contains(@class,'disabled'))])[.//text()]";

// =================== endpoints ===================

// health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// hızlı/ham metin tarama
app.get("/scrape", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await newBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(60000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

    const txt = await page.evaluate(() => document.body.innerText || "");
    const dates = uniq((txt.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).map(normDate));
    const prices = uniq(
      (txt.match(/(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)/gi) || [])
        .map(s => s.replace(/\s+/g, " ").trim())
        .filter(p => !/^0+ ?TL$/i.test(p))
    );

    res.json({ ok: true, url, dates, prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// tıkla → hesapla → tarih-fiyat
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await newBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(90000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });

    // 1) Takvim/tarih alanını açmayı dene (varsa)
    await clickFirst(page, OPEN_CALENDAR_XPATHS);

    await page.waitForTimeout(800);

    // 2) Modal içinden tarih düğmelerini bul, yoksa sayfadan bul
    let dateHandles = await page.$x(DATE_XPATH_FALLBACK_MODAL);
    if (!dateHandles || !dateHandles.length) {
      dateHandles = await page.$x(DATE_XPATH_FALLBACK_PAGE);
    }

    const schedule = [];
    const failed = [];

    // metinden yakalanan tarihler (yedek plan)
    let textDates = await page.evaluate(() => {
      const t = document.body.innerText || "";
      return (t.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []);
    });
    textDates = uniq(textDates.map(normDate));

    // 3) Ele alınan düğmeleri deneyelim (limitli)
    let clicks = 0;
    for (const h of dateHandles.slice(0, 30)) {
      try {
        const label = await page.evaluate(
          el => (el.getAttribute("data-date") || el.innerText || "").trim(),
          h
        );
        const d = normDate(label);
        if (!d) continue;

        await page.evaluate(el => el.scrollIntoView({ block: "center" }), h).catch(() => {});
        await h.click({ delay: 20 }).catch(() => {});
        await page.waitForTimeout(300);

        const pressed = await clickFirst(page, HESAPLA_XPATHS);
        if (pressed) {
          if (typeof page.waitForNetworkIdle === "function") {
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
          } else {
            await page.waitForTimeout(1000);
          }
        }

        const price = (await waitPriceText(page)) || "";
        if (price) schedule.push({ date: d, price });
        else failed.push({ date: d, reason: "price_not_found" });

        clicks++;
        if (clicks >= 20) break; // güvenli limit
      } catch (_) {}
    }

    // 4) Hâlâ boşsa, metindeki tarihler üzerinden dene
    if (!schedule.length && textDates.length) {
      for (const d of textDates.slice(0, 20)) {
        try {
          const x = `//*[contains(normalize-space(.), '${d}')]`;
          const hs = await page.$x(x);
          if (!hs.length) continue;

          await page.evaluate(el => el.scrollIntoView({ block: "center" }), hs[0]).catch(() => {});
          await hs[0].click({ delay: 20 }).catch(() => {});
          await page.waitForTimeout(300);

          const pressed = await clickFirst(page, HESAPLA_XPATHS);
          if (pressed) {
            if (typeof page.waitForNetworkIdle === "function") {
              await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
            } else {
              await page.waitForTimeout(1000);
            }
          }

          const price = (await waitPriceText(page)) || "";
          if (price) schedule.push({ date: d, price });
          else failed.push({ date: d, reason: "price_not_found" });
        } catch (_) {}
      }
    }

    // benzersizleştir
    const uniqueSchedule = uniq(schedule.map(j => JSON.stringify(j))).map(s => JSON.parse(s));

    res.json({ ok: true, url, schedule: uniqueSchedule, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// =================== start ===================
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servisi çalışıyor:", PORT);
});
