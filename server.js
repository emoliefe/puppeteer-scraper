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

/* ---------------- helpers ---------------- */
const ok = (req) =>
  !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;

const uniq = (arr) => Array.from(new Set(arr || []));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** v22+: Metinden buton/anchor bulup tıkla (CSS değil, DOM içi tarama) */
async function clickByText(page, texts, tags = ["button", "a"]) {
  for (const txt of texts) {
    const found = await page.evaluate(
      (t, tagList) => {
        const match = (el) => {
          const s = (el.innerText || el.textContent || "").trim();
          if (!s) return false;
          return s.toLowerCase().includes(t.toLowerCase());
        };
        const visible = (el) => {
          const st = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return (
            st &&
            st.display !== "none" &&
            st.visibility !== "hidden" &&
            r.width > 0 &&
            r.height > 0
          );
        };

        const qs = tagList.join(",") + ", *[role='button']";
        const nodes = document.querySelectorAll(qs);
        for (const el of nodes) {
          if (match(el) && visible(el)) {
            el.click();
            return true;
          }
        }
        return false;
      },
      txt,
      tags
    );
    if (found) return true;
  }
  return false;
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

/* ---------------- routes ---------------- */

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

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

    // KVKK kapatmaya çalış
    await clickByText(page, ["Kabul", "Tamam", "Anladım", "Kapat", "Accept"]);
    await sleep(400);

    const openers = {
      "Tüm Tarihler ve Fiyatlar": await page.evaluate(() =>
        !!Array.from(document.querySelectorAll("*")).find((el) =>
          (el.innerText || el.textContent || "")
            .toLowerCase()
            .includes("tüm tarihler ve fiyatlar")
        )
      ),
      "Tüm Tarihler": await page.evaluate(() =>
        !!Array.from(document.querySelectorAll("*")).find((el) =>
          (el.innerText || el.textContent || "")
            .toLowerCase()
            .includes("tüm tarihler")
        )
      ),
      "Tarihler": await page.evaluate(() =>
        !!Array.from(document.querySelectorAll("*")).find((el) =>
          (el.innerText || el.textContent || "")
            .toLowerCase()
            .includes("tarihler")
        )
      ),
      "HESAPLA": await page.evaluate(() =>
        !!Array.from(document.querySelectorAll("*")).find((el) =>
          (el.innerText || el.textContent || "")
            .toLowerCase()
            .includes("hesapla")
        )
      ),
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

    // KVKK
    await clickByText(page, ["Kabul", "Tamam", "Anladım", "Kapat", "Accept"]);
    await sleep(400);

    // Tarih/fiyat açmaya çalış
    await clickByText(page, ["Tüm Tarihler ve Fiyatlar", "Tüm Tarihler", "Tarihler"]);
    await sleep(800);

    // Hesapla
    await clickByText(page, ["HESAPLA", "Hesapla", "Fiyat"]);
    await sleep(1200);

    // Şimdilik metinden topla (site-özel tıklama sonraki adım)
    const { dates, prices } = await getAllDatesAndPricesFromText(page);

    const price = prices[0] || "";
    const schedule = dates.slice(0, limit).map((d) => ({ date: d, price }));

    res.json({
      ok: true,
      url,
      schedule,
      note:
        "Puppeteer v22 uyumlu. Tarih seçiminde siteye özel tıklama adımı bir sonraki patch'te eklenecek.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servisi çalışıyor:", PORT);
});
