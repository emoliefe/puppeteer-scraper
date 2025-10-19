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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---- Common helpers ----
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
      await page.evaluate(el => el.scrollIntoView({ block: "center" }), handle).catch(() => {});
      await handle.hover().catch(() => {});
      await handle.click({ delay: 30 });
      return true;
    } catch {}
  }
  return false;
}

function normDate(s) {
  const m = s && s.match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
}

async function waitPriceText(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const priceCssCandidates = [
    ".price,.fiyat,.tour-price,.calculated-price,.result-price,.total-price,[class*='price']",
    "section, main, #content"
  ];
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => document.body.innerText || "");
    const m = txt.match(
      /(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/i
    );
    if (m) return m[0].replace(/\s+/g, " ").trim();

    for (const s of priceCssCandidates) {
      const v = await page.$eval(s, el => el.innerText).catch(() => "");
      if (v && /TL|₺/.test(v)) {
        const mm = v.match(
          /(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/i
        );
        if (mm) return mm[0].replace(/\s+/g, " ").trim();
      }
    }
    await sleep(300);
  }
  return "";
}

// Seçici setleri
const COOKIE_BUTTON_XPATHS = [
  "//button[contains(translate(.,'KABUL','kabul'),'kabul')]",
  "//button[contains(translate(.,'ONAY','onay'),'onay')]",
  "//button[contains(translate(.,'ACCEPT','accept'),'accept')]",
  "//a[contains(translate(.,'KABUL','kabul'),'kabul')]",
];
const OPEN_CALENDAR_XPATHS = [
  "//button[contains(translate(.,'TUM TARIHLER','tüm tarihler'),'tüm tarihler')]",
  "//a[contains(translate(.,'TUM TARIHLER','tüm tarihler'),'tüm tarihler')]",
  "//*[contains(@class,'btn') and contains(translate(.,'TARIH','tarih'),'tarih')]",
  "//*[@data-bs-toggle='modal' or @data-bs-target]",
];
const HESAPLA_XPATHS = [
  "//*[self::button or self::a][contains(translate(normalize-space(.), 'HESAPLA', 'hesapla'), 'hesapla')]",
  "//*[self::button or self::a][contains(translate(normalize-space(.), 'FIYAT', 'fiyat'), 'fiyat')]",
];
const DATE_XPATH_IN_MODAL =
  "//div[contains(@class,'modal') or @role='dialog']//*[self::button or self::a or self::td][not(contains(@class,'disabled'))]";
const DATE_XPATH_IN_PAGE =
  "//*[self::button or self::a or self::td][not(contains(@class,'disabled'))]";

// ---- endpoints ----
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Teşhis: sayfada ne buluyoruz / neden bulamıyoruz
app.get("/probe", async (req, res) => {
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

    // çerez
    const cookieClicked = await clickFirst(page, COOKIE_BUTTON_XPATHS);
    if (cookieClicked) await sleep(300);

    // takvim butonları
    const foundOpeners = [];
    for (const xp of OPEN_CALENDAR_XPATHS) {
      const xs = await page.$x(xp);
      foundOpeners.push({ xp, count: xs.length });
    }

    // modal var mı?
    const modalNow = await page.$x("//div[contains(@class,'modal') or @role='dialog']");
    // sayfadaki dd.MM.yyyy sayısı
    const txt = await page.evaluate(() => document.body.innerText || "");
    const allDates = uniq((txt.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).map(normDate));

    // modal içi tarih düğmeleri
    const modalDates = await page.$x(DATE_XPATH_IN_MODAL);
    // sayfa içi potansiyel düğmeler
    const pageDates = await page.$x(DATE_XPATH_IN_PAGE);

    // hesapla buton sayısı
    let hesaplaCount = 0;
    for (const hx of HESAPLA_XPATHS) {
      const hs = await page.$x(hx);
      hesaplaCount += hs.length;
    }

    res.json({
      ok: true,
      url,
      cookieClicked,
      openers: foundOpeners,
      modalPresent: modalNow.length > 0,
      textDateCount: allDates.length,
      modalDateNodes: modalDates.length,
      pageDateNodes: pageDates.length,
      hesaplaButtons: hesaplaCount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// Asıl akış: tıkla → hesapla → tarih-fiyat
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

    // 0) çerez
    await clickFirst(page, COOKIE_BUTTON_XPATHS);
    await sleep(300);

    // 1) Tüm tarihler / takvim / modal
    await clickFirst(page, OPEN_CALENDAR_XPATHS);
    await sleep(700);

    // 2) Modal içinden tarih düğmeleri → yoksa sayfadaki olası düğmeler
    let dateHandles = await page.$x(DATE_XPATH_IN_MODAL);
    if (!dateHandles || !dateHandles.length) {
      dateHandles = await page.$x(DATE_XPATH_IN_PAGE);
    }

    // Metinden dd.MM.yyyy (yedek)
    let textDates = await page.evaluate(() => {
      const t = document.body.innerText || "";
      return (t.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []);
    });
    textDates = uniq(textDates.map(normDate));

    const schedule = [];
    const failed = [];
    let clicks = 0;

    // A) Gerçek buton/td/a node’ları üzerinden dene (limit 30)
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
        await sleep(350);

        const pressed = await clickFirst(page, HESAPLA_XPATHS);
        if (pressed) {
          if (typeof page.waitForNetworkIdle === "function") {
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
          } else {
            await sleep(1000);
          }
        }

        const price = (await waitPriceText(page)) || "";
        if (price) schedule.push({ date: d, price });
        else failed.push({ date: d, reason: "price_not_found" });

        clicks++;
        if (clicks >= 20) break; // güvenli limit
      } catch {
        // pas
      }
    }

    // B) Hâlâ boşsa, ekranda görünen tarih metinlerini Xpath ile hedefleyip tıkla (limit 20)
    if (!schedule.length && textDates.length) {
      for (const d of textDates.slice(0, 20)) {
        try {
          const x = `//*[contains(normalize-space(.), '${d}')]`;
          const hs = await page.$x(x);
          if (!hs.length) continue;

          await page.evaluate(el => el.scrollIntoView({ block: "center" }), hs[0]).catch(() => {});
          await hs[0].click({ delay: 20 }).catch(() => {});
          await sleep(350);

          const pressed = await clickFirst(page, HESAPLA_XPATHS);
          if (pressed) {
            if (typeof page.waitForNetworkIdle === "function") {
              await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
            } else {
              await sleep(1000);
            }
          }

          const price = (await waitPriceText(page)) || "";
          if (price) schedule.push({ date: d, price });
          else failed.push({ date: d, reason: "price_not_found" });
        } catch {
          // pas
        }
      }
    }

    const uniqueSchedule = uniq(schedule.map(j => JSON.stringify(j))).map(s => JSON.parse(s));
    res.json({
      ok: true,
      url,
      schedule: uniqueSchedule,
      failed
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// start
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servis hazır:", PORT);
});
