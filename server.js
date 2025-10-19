// server.js
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";

// Chromium yolu (Dockerfile'da /usr/bin/chromium olarak verdik)
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : undefined);

// --------- küçük yardımcılar ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (req) => !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;
const uniq = (arr) => Array.from(new Set(arr || []));
const normDate = (s) => {
  const m = s && s.match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  return m ? `${m[1].padStart(2,"0")}.${m[2].padStart(2,"0")}.${m[3]}` : "";
};

// Bir dizi seçiciden ilki bulunursa tıkla (XPath öncelikli)
async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      let handle = null;
      if (sel.startsWith("//")) {
        const hs = await page.$x(sel);
        handle = hs && hs[0] ? hs[0] : null;
      } else {
        handle = await page.$(sel);
      }
      if (handle) {
        await handle.click({ delay: 20 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// Fiyat metnini sayfadan çek (metin tarama + bazı belirgin alanlar)
async function readPrice(page, deadlineMs = 15000) {
  const endAt = Date.now() + deadlineMs;
  const priceRe =
    /(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/i;

  while (Date.now() < endAt) {
    const txt = await page.evaluate(() => document.body.innerText || "");
    const m = txt.match(priceRe);
    if (m) return m[0].replace(/\s+/g, " ").trim();

    // bazı yaygın fiyat alanlarını da yokla
    const selectors = [
      "[class*='price']",
      ".price,.fiyat,.tour-price,.calculated-price,.total-price",
    ];
    for (const s of selectors) {
      try {
        const t = await page.$eval(s, (el) => el.innerText || "");
        const mm = t.match(priceRe);
        if (mm) return mm[0].replace(/\s+/g, " ").trim();
      } catch (_) {}
    }
    await sleep(300);
  }
  return "";
}

// --------- health ----------
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --------- hızlı tarama (/scrape) ----------
app.get("/scrape", async (req, res) => {
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
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(60000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

    const txt = await page.evaluate(() => document.body.innerText || "");
    const dates = uniq(
      (txt.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).map(normDate)
    );
    const prices = uniq(
      (txt.match(/(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)/gi) || [])
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((p) => !/^0+ ?TL$/i.test(p))
    );

    res.json({ ok: true, url, dates, prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// --------- tıkla → hesapla → tarih-fiyat eşle ( /calc ) ----------
app.get("/calc", async (req, res) => {
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
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(90000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });

    // 1) Tarih/fiyat modalını açmayı dene
    await clickFirst(page, [
      "//button[contains(., 'Tüm Tarihler ve Fiyatlar')]",
      "//button[contains(., 'Tüm Tarihler')]",
      "//a[contains(., 'Tüm Tarihler')]",
      "button[data-bs-target*='tarih']",
      "button[data-bs-toggle='modal']",
      ".btn-dates,.btn-calendar,[class*='tarih']",
    ]);
    await sleep(800);

    // 2) Metinden tüm tarihler (fallback olarak)
    let textDates = await page.evaluate(() => {
      const t = document.body.innerText || "";
      return t.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || [];
    });
    textDates = uniq(textDates.map(normDate));

    // 3) Modal veya sayfadaki tıklanabilir tarih elemanlarını topla (etiket/innerText üzerinden)
    const dateNodes = await page.$$(
      ".modal [data-date], .modal .date, .modal .day, .modal button, .modal a, " +
      "[data-date], .date, .day, button.date, a.date"
    );

    const schedule = [];
    const failed = [];
    let clicks = 0;

    // Önce UI üzerinden yakaladıklarını dene (limitli)
    for (const h of dateNodes.slice(0, 30)) {
      try {
        const label = await page.evaluate(
          (el) => (el.innerText || el.getAttribute("data-date") || "").trim(),
          h
        );
        const d = normDate(label);
        if (!d) continue;

        await h.click({ delay: 20 });
        await sleep(400);

        // "Hesapla" / "Fiyat" gibi butonlar (XPath metin içerik bazlı)
        await clickFirst(page, [
          "//button[contains(., 'Hesapla')]",
          "//a[contains(., 'Hesapla')]",
          "//button[contains(., 'Fiyat')]",
          "//a[contains(., 'Fiyat')]",
        ]);
        await sleep(1000);

        const price = await readPrice(page, 12000);
        if (price) schedule.push({ date: d, price });
        else failed.push({ date: d, reason: "price_not_found" });

        clicks++;
        if (clicks >= 20) break;
      } catch (_) {}
    }

    // Hâlâ boşsa: metinden bulduğu tarihlerle “metin bazlı tıklama” yap
    if (!schedule.length && textDates.length) {
      for (const d of textDates.slice(0, 20)) {
        try {
          const x = `//*[contains(normalize-space(.), '${d}')]`;
          const handles = await page.$x(x);
          if (!handles.length) continue;

          await handles[0].click().catch(() => {});
          await sleep(400);

          await clickFirst(page, [
            "//button[contains(., 'Hesapla')]",
            "//a[contains(., 'Hesapla')]",
            "//button[contains(., 'Fiyat')]",
            "//a[contains(., 'Fiyat')]",
          ]);
          await sleep(1000);

          const price = await readPrice(page, 12000);
          if (price) schedule.push({ date: d, price });
          else failed.push({ date: d, reason: "price_not_found" });
        } catch (_) {}
      }
    }

    res.json({
      ok: true,
      url,
      schedule: uniq(schedule.map((j) => JSON.stringify(j))).map((s) => JSON.parse(s)),
      failed,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// --------- listen ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servisi çalışıyor:", PORT);
});
