const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT  = process.env.PORT  || 3000;
const TOKEN = process.env.TOKEN || "";
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : undefined);

// -------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (req) => !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;

const uniq = (arr) => Array.from(new Set(arr || []));
const normDate = (s) => {
  // 1.1.2025 → 01.01.2025
  const m = (s || "").match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  return `${String(m[1]).padStart(2,"0")}.${String(m[2]).padStart(2,"0")}.${m[3]}`;
};

async function ensurePage(url) {
  const browser = await puppeteer.launch({
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

  await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 }).catch(()=>{});

  // çerez / KVKK kabul (varsa)
  try {
    // sık görülen buton metinleri
    const cookieBtnXpath = [
      "//button[contains(translate(., 'İI', 'ii'), 'kabul') or contains(translate(.,'OK','ok'),'ok')]",
      "//button[contains(., 'Kabul Et')]",
      "//button[contains(., 'Tamam')]",
    ];
    for (const xp of cookieBtnXpath) {
      const btns = await page.$x(xp);
      if (btns.length) { await btns[0].click().catch(()=>{}); await sleep(300); break; }
    }
  } catch {}

  return { browser, page };
}

async function scrollToTop(page){ await page.evaluate(() => window.scrollTo(0,0)); await sleep(200); }
async function scrollIntoViewIfNeeded(page, el) {
  try { await el.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" })); } catch {}
  await sleep(120);
}

async function extractVisiblePrice(page) {
  // sayfadaki görünür metinden makul bir fiyat ifadesi çek
  const txt = await page.evaluate(() => document.body.innerText || "");
  const re = /(?:₺|TL|€|EUR|USD)\s*\d{2,6}(?:[.,]\d{2})?|\b\d{2,6}(?:[.,]\d{2})?\s*(?:₺|TL|€|EUR|USD)\b/i;
  const m = txt.match(re);
  if (m) return m[0].replace(/\s+/g, " ").trim();

  // belirgin fiyat alanları
  const selectors = [
    ".price", ".fiyat",
    ".tour-price", ".calculated-price", ".result-price", ".total-price",
    "[class*='price']"
  ];
  for (const s of selectors) {
    try {
      const val = await page.$eval(s, el => (getComputedStyle(el).display !== "none" ? el.innerText : "")).catch(()=> "");
      if (val && /(₺|TL|€|EUR|USD)/.test(val)) {
        const mm = val.match(re);
        if (mm) return mm[0].replace(/\s+/g, " ").trim();
      }
    } catch {}
  }
  return "";
}

async function clickFirstHesapla(page) {
  // Hem <button> hem <a> içinde "Hesapla" / "Fiyat" arar
  const nodes = await page.$$(`button, a, .btn, [role="button"]`);
  for (const n of nodes) {
    const t = (await n.evaluate(el => (el.innerText || el.textContent || "").trim().toLowerCase())).replace(/\s+/g, " ");
    if (!t) continue;
    if (t.includes("hesapla") || t.includes("fiyat")) {
      await scrollIntoViewIfNeeded(page, n);
      await n.click().catch(()=>{});
      return true;
    }
  }
  // XPATH yedek
  const xpath = [
    "//button[contains(translate(normalize-space(.),'HESAPLA','hesapla'),'hesapla')]",
    "//a[contains(translate(normalize-space(.),'HESAPLA','hesapla'),'hesapla')]",
    "//button[contains(.,'Fiyat')]",
    "//a[contains(.,'Fiyat')]",
  ];
  for (const xp of xpath) {
    const b = await page.$x(xp);
    if (b.length) { await scrollIntoViewIfNeeded(page, b[0]); await b[0].click().catch(()=>{}); return true; }
  }
  return false;
}

async function findLavinyaDateElements(page) {
  // Lavinya tarih kutuları: .tour-date-item içinde görünüyor.
  // Bu fonksiyon her görünür tarih için {text, handle} döndürür.
  const handles = await page.$$(
    ".tour-date-item, .tour-date, [data-date], .calendar .day, .calendar button, .calendar a"
  );

  const list = [];
  for (const h of handles) {
    try {
      const visible = await h.evaluate(el => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs && cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
      });
      if (!visible) continue;

      const label = await h.evaluate(el => (el.innerText || el.textContent || el.getAttribute("data-date") || "").trim());
      const d = normDate(label);
      if (d) list.push({ date: d, handle: h });
    } catch {}
  }

  // Tekilleştir (aynı tarihi gösteren birden çok node olabilir)
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!seen.has(item.date)) { seen.add(item.date); out.push(item); }
  }
  return out;
}

async function calcAllDates(page) {
  // Ekrandaki tüm tarih kutularını bul
  let dates = await findLavinyaDateElements(page);

  // Eğer sayfada bulamadıysak, metinden yakala (ör. içerik bloklarında geçen tarih)
  if (!dates.length) {
    const textDates = await page.evaluate(() => {
      const t = document.body.innerText || "";
      return (t.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []);
    });
    const uniqDates = uniq(textDates.map(normDate));
    // tıklanacak element ararken bu tarih metnini içeren bir düğme/hücre bulmayı deneriz
    dates = uniqDates.map(d => ({ date: d, handle: null }));
  }

  const schedule = [];
  const failed = [];

  // Her tarih için: tıkla → Hesapla → fiyat al
  for (const item of dates) {
    try {
      // element varsa direkt tıkla; yoksa metne göre arayıp tıkla
      if (item.handle) {
        await scrollIntoViewIfNeeded(page, item.handle);
        await item.handle.click().catch(()=>{});
      } else {
        // metne göre yaklaşık tıklama
        const cand = await page.$x(`//*[contains(normalize-space(.), '${item.date}')]`);
        if (cand.length) {
          await scrollIntoViewIfNeeded(page, cand[0]);
          await cand[0].click().catch(()=>{});
        }
      }
      await sleep(300);

      const pressed = await clickFirstHesapla(page);
      if (pressed) {
        // ağ trafiği sakinleşsin
        if (typeof page.waitForNetworkIdle === "function") {
          await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(()=>{});
        }
        await sleep(600);
      }

      const price = await extractVisiblePrice(page);
      if (price) schedule.push({ date: item.date, price });
      else failed.push({ date: item.date, reason: "price_not_found" });
    } catch (e) {
      failed.push({ date: item.date, reason: e.message || "click_error" });
    }

    // güvenli sınır (çok tarihi olan sayfalarda)
    if (schedule.length >= 40) break;
  }

  // sıra ve tekilleştirme
  const uniqSched = [];
  const seenKey = new Set();
  for (const s of schedule) {
    const k = `${s.date}|${s.price}`;
    if (!seenKey.has(k)) { seenKey.add(k); uniqSched.push(s); }
  }

  return { schedule: uniqSched, failed };
}

// -------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// debug: sayfada ne bulduk?
app.get("/probe", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    ({ browser, page } = await ensurePage(url));
    const pageAny = await (async () => {
      const dates = await findLavinyaDateElements(page);
      const hesaplaButtons = await page.$$eval("button, a, .btn, [role='button']",
        (nodes) => nodes
          .map(el => (el.innerText || el.textContent || "").trim().toLowerCase())
          .filter(t => t.includes("hesapla") || t.includes("fiyat")).length
      ).catch(()=>0);

      const textDatesCount = await page.evaluate(() => {
        const t = document.body.innerText || "";
        return (t.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).length;
      });

      return { dateNodes: dates.length, textDatesCount, hesaplaButtons };
    })();

    res.json({ ok: true, url, ...pageAny });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally { if (browser) await browser.close().catch(()=>{}); }
});

// asıl: tarihe tıkla → hesapla → fiyat
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    ({ browser, page } = await ensurePage(url));
    await scrollToTop(page);

    const { schedule, failed } = await calcAllDates(page);

    res.json({ ok: true, url, schedule, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally { if (browser) await browser.close().catch(()=>{}); }
});

// ---- listen ----
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Lavinya Puppeteer servisi hazır:", PORT);
});
