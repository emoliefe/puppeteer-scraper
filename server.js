const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";

// Chrome yolu (Coolify/Puppeteer resmi imajı ile uyumlu)
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function"
    ? puppeteer.executablePath()
    : undefined);

// --- yardımcılar ---
const ok = (req) =>
  !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normDate(d) {
  // 30.11.2025 veya 30/11/2025 -> 30.11.2025
  if (!d) return "";
  const m = d.match(/([0-3]?\d)[./]([01]?\d)[./](\d{4})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
}

async function getInnerText(page) {
  return page.evaluate(() => document.body.innerText || "");
}

async function waitPriceText(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const PRICE_RE =
    /(?:₺|\bTL\b)\s*\d{1,3}(?:[\.\s]\d{3})*(?:[.,]\d{2})?|\b\d{1,3}(?:[\.\s]\d{3})*(?:[.,]\d{2})?\s*(?:TL|₺)\b/i;

  // 1) belirgin fiyat alanları
  const hotSelectors = [
    ".price,.fiyat,.tour-price,.calculated-price,.result-price,.total-price,[class*='price']",
    "[id*='price']",
  ];

  while (Date.now() < deadline) {
    // a) hızlı tarama
    for (const s of hotSelectors) {
      try {
        const txt = await page.$eval(s, (el) => el.innerText.trim());
        if (txt) {
          const m = txt.match(PRICE_RE);
          if (m) return m[0].replace(/\s+/g, " ").trim();
        }
      } catch (_) {}
    }

    // b) full body fallback
    const body = await getInnerText(page);
    const m = body.match(PRICE_RE);
    if (m) return m[0].replace(/\s+/g, " ").trim();

    await sleep(300);
  }
  return "";
}

// Ekranda görünür ve tıklanabilir mi?
async function isVisibleClickable(page, handle) {
  if (!handle) return false;
  try {
    const box = await handle.boundingBox();
    if (!box || box.width < 2 || box.height < 2) return false;
    const disabled = await page.evaluate(
      (el) =>
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        el.classList.contains("disabled"),
      handle
    );
    return !disabled;
  } catch {
    return false;
  }
}

// Metinde geçen butonu (içerik) tıklama
async function clickByText(page, texts, scopeSelector = null) {
  return page.evaluate(
    ({ texts, scopeSelector }) => {
      const scope = scopeSelector
        ? document.querySelector(scopeSelector)
        : document;
      if (!scope) return false;
      const candidates = scope.querySelectorAll("button, a, [role='button']");
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wants = texts.map(norm);

      for (const el of candidates) {
        const t = norm(el.innerText || el.textContent || "");
        if (!t) continue;
        if (wants.some((w) => t.includes(w))) {
          el.click();
          return true;
        }
      }
      return false;
    },
    { texts, scopeSelector }
  );
}

// Tarih inputunu/alanını aç
async function openDatePicker(page) {
  // 1) doğrudan input'a tıkla
  const selectors = [
    "input[placeholder*='Tarih' i]",
    "input[name*='tarih' i]",
    "#tarih, .tarih, [id*='tarih' i], [class*='tarih' i]",
  ];
  for (const s of selectors) {
    const el = await page.$(s);
    if (await isVisibleClickable(page, el)) {
      await el.click({ delay: 20 }).catch(() => {});
      await sleep(300);
      return true;
    }
  }
  // 2) yazıya tıkla
  const ok = await clickByText(page, ["tarih seçiniz", "tarih", "tarihler"]);
  if (ok) {
    await sleep(300);
    return true;
  }
  return false;
}

// Görünen takvim içindeki tıklanabilir gün düğmelerini bul
async function getClickableDayLabels(page, max = 24) {
  return page.evaluate((max) => {
    const host =
      document.querySelector(".ui-datepicker, .datepicker, .calendar, .date, [class*='calendar'], [id*='calendar']") ||
      document.body;
    const nodes = host.querySelectorAll("button, a, td, div, span");
    const out = [];
    for (const el of nodes) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        el.classList.contains("disabled")
      )
        continue;
      const txt = (el.innerText || el.textContent || "").trim();
      if (/^\d{1,2}$/.test(txt)) {
        // sadece gün numarası
        out.push({ text: txt });
        if (out.length >= max) break;
      }
    }
    return out;
  }, max);
}

// Takvimde belirli gün numarasını tıkla
async function clickDayByText(page, dayText) {
  return page.evaluate((dayText) => {
    const host =
      document.querySelector(".ui-datepicker, .datepicker, .calendar, .date, [class*='calendar'], [id*='calendar']") ||
      document.body;

    // Önce seçilebilir <button>/<a>
    const candidates = host.querySelectorAll("button, a, td, div, span");
    const norm = (s) => (s || "").trim();

    for (const el of candidates) {
      const txt = norm(el.innerText || el.textContent);
      if (txt === String(dayText)) {
        // disabled değilse tıkla
        if (
          !el.hasAttribute("disabled") &&
          el.getAttribute("aria-disabled") !== "true" &&
          !el.classList.contains("disabled")
        ) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }, dayText);
}

// “HESAPLA” tuşuna bas
async function clickHesapla(page) {
  // önce görünen modal/alan içinde ara
  const ok =
    (await clickByText(page, ["hesapla"], ".modal, body")) ||
    (await clickByText(page, ["fiyat", "fiyatları gör"], ".modal, body"));
  await sleep(400);
  return ok;
}

// Seçilmiş tarihi okumak için input değerini al
async function readSelectedDate(page) {
  const val = await page.evaluate(() => {
    const el =
      document.querySelector("input[placeholder*='Tarih' i]") ||
      document.querySelector("input[name*='tarih' i]") ||
      document.querySelector("#tarih");
    return el && (el.value || el.getAttribute("value"));
  });
  return normDate(val || "");
}

// ---- Sağlık
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Hızlı tarama (tıklamasız, mevcut /scrape)
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
    page.setDefaultTimeout(90000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });
    const body = await getInnerText(page);

    const dates = Array.from(
      new Set(
        (body.match(/\b([0-3]?\d)[.\/]([01]?\d)[.\/](\d{4})\b/g) || []).map(
          (d) => normDate(d)
        )
      )
    );

    const prices = Array.from(
      new Set(
        (
          body.match(
            /(?:₺|\bTL\b)\s*\d{1,3}(?:[\.\s]\d{3})*(?:[.,]\d{2})?|\b\d{1,3}(?:[\.\s]\d{3})*(?:[.,]\d{2})?\s*(?:TL|₺)\b/gi
          ) || []
        ).map((s) => s.replace(/\s+/g, " ").trim())
      )
    );

    res.json({ ok: true, url, dates, prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ---- Teşhis (opsiyonel)
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
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(90000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });

    const openerClicked = await openDatePicker(page);
    await sleep(400);

    const dateCandidates = await getClickableDayLabels(page, 50);
    const hesaplaExists = await clickByText(page, ["hesapla", "fiyat"]);
    // geri almayalım; sadece var mı diye bastık

    res.json({
      ok: true,
      url,
      openerClicked,
      modalPresent: false,
      dateCandidates: dateCandidates.length,
      hesaplaButtons: hesaplaExists ? 1 : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ---- Asıl akış: tarih seç → HESAPLA → fiyatı oku
// /calc?url=...&token=efe123&limit=12
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || "18", 10), 36));
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  const schedule = [];
  const failed = [];

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1366,900",
        "--lang=tr-TR,tr;q=0.9
