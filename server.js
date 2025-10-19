// server.js
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT = process.env.PORT || 3000;
// Güvenlik için: URL'de ?token=... veya Header: x-token (Coolify: TOKEN=efe123)
const TOKEN = process.env.TOKEN || "";

// Chromium yolu: Dockerfile'da PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
// (yoksa puppeteer'ın kendi yolunu dener)
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function"
    ? puppeteer.executablePath()
    : null);

/* Sağlık kontrolü */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

/* Yardımcılar */
function authOk(req) {
  if (!TOKEN) return true;
  const q = req.query.token;
  const h = req.header("x-token");
  return q === TOKEN || h === TOKEN;
}
const unique = (arr) => Array.from(new Set(arr || []));

/* /scrape?url=...&date=DD.MM.YYYY (opsiyonel) */
app.get("/scrape", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "Unauthorized" });

  const url = (req.query.url || "").trim();
  const targetDate = (req.query.date || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--window-size=1366,900",
        "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    );
    page.setDefaultTimeout(60_000);

    await page.goto(encodeURI(url), { waitUntil: "networkidle2", timeout: 120_000 });

    // "Tüm Tarihler" butonunu dene (varsa)
    try {
      const variants = [
        "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZÇĞİÖŞÜ', 'abcdefghijklmnopqrstuvwxyzçğiöşü'), 'tüm tarihler')]",
        "//button[contains(., 'Tüm Tarihler ve Fiyatlar')]",
        "button[data-bs-toggle='modal']",
        ".btn-dates,.btn-calendar,[data-target*='tarih']",
      ];
      for (const sel of variants) {
        const handles = sel.startsWith("//") ? await page.$x(sel) : [await page.$(sel)];
        if (handles && handles[0]) {
          await handles[0].click();
          await page.waitForTimeout(2000);
          break;
        }
      }
    } catch (_) {}

    // İstenen tarih verildiyse seç + "Hesapla" tıkla (varsa)
    let clickedDate = "";
    if (targetDate) {
      try {
        const dateXPath = `//*[contains(normalize-space(.), '${targetDate}')]`;
        const cands = await page.$x(dateXPath);
        if (cands.length) {
          await cands[0].click();
          clickedDate = targetDate;
          await page.waitForTimeout(800);
        }

        const hesaplaXPath =
          "//*[self::button or self::a or self::*[name()='span'] or self::*[name()='div']]" +
          "[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZÇĞİÖŞÜ', 'abcdefghijklmnopqrstuvwxyzçğiöşü'), 'hesapla')]";
        const hesapBtns = await page.$x(hesaplaXPath);
        if (hesapBtns.length) {
          await hesapBtns[0].click();
          if (typeof page.waitForNetworkIdle === "function") {
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30_000 }).catch(() => {});
          } else {
            await page.waitForTimeout(1500);
          }
        }
      } catch (_) {}
    }

    // Metni al ve çıkarımlar yap
    const text = await page.evaluate(() => document.body.innerText || "");

    // Tarihler (DD.MM.YYYY)
    const dateRegex = /\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g;
    const dates = unique((text.match(dateRegex) || []).map((s) => s.trim()));

    // Fiyatlar (TL/₺)
    const priceRegex = /(?:₺|\bTL\b)\s*[\d\.]+(?:,\d{2})?|\b[\d\.]+\s*(?:TL|₺)/gi;
    const prices = unique((text.match(priceRegex) || []).map((s) => s.replace(/\s+/g, " ").trim()));

    const result = { ok: true, url, clickedDate: clickedDate || null, dates, prices };
    if (clickedDate && prices.length) result.datePrice = { [clickedDate]: prices[0] };

    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      hint:
        "Chromium bulunamazsa Dockerfile'da PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium ve chromium kurulumunu kontrol edin.",
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/* Container içinde dışarıdan erişim için 0.0.0.0'a bağlan */
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servisi çalışıyor:", PORT);
});
