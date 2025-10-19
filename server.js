// server.js
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";

// Coolify/Puppeteer image için genelde gerekmez ama yine de destekleyelim
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function"
    ? puppeteer.executablePath()
    : undefined);

// ---------- küçük yardımcılar ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (req) =>
  !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;

const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

function normDate(s) {
  const m = String(s).match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
}

function extractDates(text) {
  return uniq((text.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).map(normDate));
}

function extractPrices(text) {
  return uniq(
    (text.match(
      /(?:₺|\bTL\b)\s*\d{2,6}(?:[.,]\d{2})?|\b\d{2,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/gi
    ) || [])
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((p) => !/^0+ ?(TL|₺)$/i.test(p))
  );
}

// sayfa içi: görünen, tıklanabilir elementler arasından metne göre bul
async function clickByText(page, text, scopeSelector = "body") {
  const found = await page.evaluate(
    (needle, scopeSel) => {
      const scope = document.querySelector(scopeSel) || document.body;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      const candidates = [];
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const style = window.getComputedStyle(el);
        if (
          el.offsetParent !== null &&
          style.visibility !== "hidden" &&
          style.pointerEvents !== "none"
        ) {
          const t = (el.innerText || el.textContent || "").trim();
          if (t && t.toLowerCase().includes(needle.toLowerCase())) {
            candidates.push({
              x: el.getBoundingClientRect().left + 2,
              y: el.getBoundingClientRect().top + 2,
            });
          }
        }
      }
      return candidates[0] || null;
    },
    text,
    scopeSelector
  );

  if (found) {
    await page.mouse.click(found.x, found.y);
    return true;
  }
  return false;
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    const handle = await page.$(sel);
    if (handle) {
      try {
        await handle.click();
        return true;
      } catch (_) {}
    }
  }
  return false;
}

async function newBrowserPage(targetUrl) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1366,900",
      // İstersen dil:
      // "--lang=tr-TR",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36",
  });

  // Bazı sitelerde onay/çerez
  page.on("dialog", async (d) => {
    try {
      await d.accept();
    } catch {}
  });

  await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 180000 });
  return { browser, page };
}

// ---------- endpoints ----------
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// hızlı: sadece metinden tarih/fiyat
app.get("/scrape", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    const ctx = await newBrowserPage(url);
    browser = ctx.browser;
    const page = ctx.page;

    const txt = await page.evaluate(() => document.body.innerText || "");
    res.json({
      ok: true,
      url,
      dates: extractDates(txt),
      prices: extractPrices(txt),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// teşhis: “aç/kapa düğmesi var mı, modal var mı, buton sayısı kaç?”
app.get("/probe", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    const ctx = await newBrowserPage(url);
    browser = ctx.browser;
    const page = ctx.page;

    // yaygın açıcılar
    const openers = [
      "button:has-text('Tüm Tarihler')",
      "button:has-text('Tüm Tarihler ve Fiyatlar')",
      "button:has-text('Tarihler')",
      "a:has-text('Tüm Tarihler')",
      "a:has-text('Tarihler')",
      ".btn-dates,.btn-calendar,[class*='tarih']",
    ];

    let openerClicked = false;
    for (const o of openers) {
      const h = await page.$(o).catch(() => null);
      if (h) {
        try {
          await h.click();
          openerClicked = true;
          break;
        } catch {}
      }
    }
    if (!openerClicked) {
      // metinle dene
      openerClicked = await clickByText(page, "Tarihler");
      if (!openerClicked) openerClicked = await clickByText(page, "Tüm Tarihler");
    }

    await sleep(800);

    const modalPresent = await page.$(".modal, [role='dialog']").then(Boolean).catch(() => false);

    const txt = await page.evaluate(() => document.body.innerText || "");
    const textDateNodes = extractDates(txt).length;

    // sayfadaki görünür hesapla butonları kaba sayı
    const hesaplaButtons = await page.evaluate(() => {
      const labelHit = (n) =>
        /hesapla|fiyat/i.test((n.innerText || n.textContent || "").trim());
      return Array.from(document.querySelectorAll("button,a")).filter(labelHit)
        .length;
    });

    res.json({
      ok: true,
      url,
      openerClicked,
      modalPresent,
      textDateNodes,
      hesaplaButtons,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// asıl akış: tarih tıkla → HESAPLA → çıkan fiyatı oku
// /calc?url=...&token=...&limit=12
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });
  const LIMIT = Math.max(1, Math.min(30, Number(req.query.limit) || 12));

  let browser;
  try {
    const ctx = await newBrowserPage(url);
    browser = ctx.browser;
    const page = ctx.page;

    // Açılabilir “tarihler” paneli varsa aç
    let openerClicked =
      (await clickFirst(page, [
        "button:has-text('Tüm Tarihler')",
        "button:has-text('Tüm Tarihler ve Fiyatlar')",
        "button:has-text('Tarihler')",
        "a:has-text('Tarihler')",
        "a:has-text('Tüm Tarihler')",
        ".btn-dates,.btn-calendar,[class*='tarih']",
      ])) ||
      (await clickByText(page, "Tüm Tarihler")) ||
      (await clickByText(page, "Tarihler"));
    if (openerClicked) await sleep(700);

    // Görünen tarih hücrelerinden aday topla
    const candidates = await page.evaluate(() => {
      const isVis = (el) =>
        el.offsetParent !== null &&
        window.getComputedStyle(el).visibility !== "hidden";

      const set = new Set();
      const push = (s) => set.add(s);

      // modal içi
      document
        .querySelectorAll(
          ".modal [data-date], .modal .day, .modal button, .modal a"
        )
        .forEach((el) => {
          if (!isVis(el)) return;
          const txt = (el.innerText || el.textContent || "").trim();
          if (/\d{1,2}[./]\d{1,2}[./]\d{4}/.test(txt)) push(txt);
          const d = el.getAttribute("data-date");
          if (d) push(d);
        });

      // sayfa geneli
      document.querySelectorAll("[data-date], .day, .date").forEach((el) => {
        if (!isVis(el)) return;
        const txt = (el.innerText || el.textContent || "").trim();
        if (/\d{1,2}[./]\d{1,2}[./]\d{4}/.test(txt)) push(txt);
        const d = el.getAttribute("data-date");
        if (d) push(d);
      });

      // fallback: tüm metinden de ayıklayalım
      const body = document.body.innerText || "";
      (body.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || []).forEach((s) =>
        push(s)
      );

      return Array.from(set).slice(0, 60);
    });

    const dateList = uniq(candidates.map(normDate)).slice(0, LIMIT);

    const schedule = [];
    const failed = [];

    // tek bir tarihe tıklayıp "Hesapla" → fiyat okuyan küçük rutin
    async function handleOneDate(d) {
      // tarihi içeren ilk görünen düğmeye “metinden” tıkla
      const clicked = await clickByText(page, d);
      if (!clicked) {
        failed.push({ date: d, reason: "date_not_clickable" });
        return;
      }
      await sleep(400);

      // HESAPLA/Fiyat düğmesi
      const pressed =
        (await clickFirst(page, [
          "button:has-text('Hesapla')",
          "a:has-text('Hesapla')",
          "button:has-text('Fiyat')",
          "a:has-text('Fiyat')",
        ])) ||
        (await clickByText(page, "HESAPLA")) ||
        (await clickByText(page, "Hesapla")) ||
        (await clickByText(page, "Fiyat"));

      if (pressed) {
        // sonuçların yüklenmesi için kısa bekleme
        await sleep(1000);
      }

      // fiyat okuma: önce belirgin alanlar, sonra gövde metni
      const priceFromBoxes = await page
        .evaluate(() => {
          const pick = (n) =>
            (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim();
          const nodes = document.querySelectorAll(
            ".price, .fiyat, .tour-price, .calculated-price, .result-price, .total-price, [class*='price']"
          );
          for (const el of nodes) {
            const t = pick(el);
            const m = t.match(
              /(?:₺|\bTL\b)\s*\d{2,6}(?:[.,]\d{2})?|\b\d{2,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/i
            );
            if (m) return m[0];
          }
          return "";
        })
        .catch(() => "");

      let price = priceFromBoxes;
      if (!price) {
        const body = await page.evaluate(() => document.body.innerText || "");
        price = extractPrices(body)[0] || "";
      }

      if (price) schedule.push({ date: d, price });
      else failed.push({ date: d, reason: "price_not_found" });
    }

    for (const d of dateList) {
      await handleOneDate(d);
    }

    // benzersizleştir
    const uniqSchedule = uniq(schedule.map((x) => JSON.stringify(x))).map((s) =>
      JSON.parse(s)
    );

    res.json({ ok: true, url, schedule: uniqSchedule, failed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ---- dinle ----
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servisi çalışıyor:", PORT);
});
