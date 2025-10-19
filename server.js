const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";

/** Puppeteer Chrome yolu (varsa env, yoksa bundled) */
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function"
    ? puppeteer.executablePath()
    : undefined);

/* -------------------- yardımcılar -------------------- */

const ok = (req) =>
  !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;

const uniq = (arr) => Array.from(new Set(arr || []));

const normDate = (s) => {
  const m = String(s).match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
};

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1366,900",
      "--lang=tr-TR",
    ],
  });
}

async function findByTextXPath(page, tag, text) {
  const esc = text.replace(/'/g, "\\'");
  const xp =
    tag === "*"
      ? `//*[contains(normalize-space(.), '${esc}')]`
      : `//${tag}[contains(normalize-space(.), '${esc}')]`;
  const els = await page.$x(xp);
  return els[0] || null;
}

async function clickByText(page, texts, tags = ["button", "a", "*"]) {
  for (const txt of texts) {
    for (const tag of tags) {
      try {
        const h = await findByTextXPath(page, tag, txt);
        if (h) {
          await h.click({ delay: 20 }).catch(() => {});
          return true;
        }
      } catch (_) {}
    }
  }
  return false;
}

async function waitNetworkQuiet(page, timeout = 15000) {
  if (typeof page.waitForNetworkIdle === "function") {
    try {
      await page.waitForNetworkIdle({ idleTime: 800, timeout });
      return;
    } catch (_) {}
  }
  await page.waitForTimeout(1200);
}

async function getAllDatesAndPricesFromText(page) {
  const txt = await page.evaluate(() => document.body.innerText || "");
  const dates = uniq(
    (txt.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).map(normDate)
  );
  const prices = uniq(
    (txt.match(
      /(?:₺|\bTL\b)\s*\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?|\b\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?\s*(?:TL|₺)\b/gi
    ) || [])
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((p) => !/^0+ ?TL$/i.test(p))
  );
  return { dates, prices };
}

/* -------------------- routes -------------------- */

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/** Basit sonda: buton/metin bulunabiliyor mu? */
app.get("/probe", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(60000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

    // çerez/kvkk kapat
    await clickByText(page, ["Kabul", "Tamam", "Anladım", "Kapat", "Accept"]);

    const openers = {
      "Tüm Tarihler ve Fiyatlar": !!(await findByTextXPath(
        page,
        "*",
        "Tüm Tarihler ve Fiyatlar"
      )),
      "Tüm Tarihler": !!(await findByTextXPath(page, "*", "Tüm Tarihler")),
      "Tarihler": !!(await findByTextXPath(page, "*", "Tarihler")),
      "HESAPLA": !!(await findByTextXPath(page, "*", "HESAPLA")),
    };

    const { dates, prices } = await getAllDatesAndPricesFromText(page);

    res.json({
      ok: true,
      url,
      openers,
      textDateCount: dates.length,
      sampleDates: dates.slice(0, 6),
      samplePrices: prices.slice(0, 6),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/**
 * Basit hesaplama akışı:
 * - Sayfayı aç
 * - Gerekirse "Tüm Tarihler" düğmesine bas
 * - Varsa "HESAPLA" bas
 * - Metinden tarih & fiyat topla (hedef sitede tarih seçip hesaplamak
 *   bir sonraki adımda siteye özel selector’la genişletilecek)
 */
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  const limit = Number(req.query.limit || 12);
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(90000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });
    await clickByText(page, ["Kabul", "Tamam", "Anladım", "Kapat", "Accept"]);

    // Tarih/fiyat modali açmaya çalış
    await clickByText(page, ["Tüm Tarihler ve Fiyatlar", "Tüm Tarihler", "Tarihler"]);
    await waitNetworkQuiet(page);

    // Hesapla butonu varsa bir kez bas
    await clickByText(page, ["HESAPLA", "Hesapla", "Fiyat"]);
    await waitNetworkQuiet(page);

    // Şimdilik metinden çek (stabil ve hatasız)
    const { dates, prices } = await getAllDatesAndPricesFromText(page);

    // Basit eşleme: her yakalanan tarihe ilk fiyatı ata (site-özel tıklama sonraki adım)
    const price = prices[0] || "";
    const schedule = dates.slice(0, limit).map((d) => ({ date: d, price }));

    res.json({ ok: true, url, schedule, note: "Genel metinden toplandı; site-özel tıklama sonraki adımda." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servisi çalışıyor:", PORT);
});
