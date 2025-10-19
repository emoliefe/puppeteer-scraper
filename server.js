// v4-final — Puppeteer stable, no $x / no waitForTimeout
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || ""; // senin için: efe123
const EXE = process.env.PUPPETEER_EXECUTABLE_PATH; // çoğu imajda boş kalabilir

// ---- utils ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (req) =>
  !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;

const uniq = (arr) => Array.from(new Set(arr || []));

// Görünürlük kontrolü (display:none / visibility:hidden olmayan)
function isVisible(node) {
  if (!node) return false;
  const st = node.ownerDocument && node.ownerDocument.defaultView
    ? node.ownerDocument.defaultView.getComputedStyle(node)
    : null;
  if (!st) return true;
  if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")
    return false;
  const rect = node.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0;
}

// Bir metni içeren tıklanabilir elemanı bulup click
async function clickByText(page, texts, scopes = ["button", "a", "[role='button']", "div", "span"]) {
  return page.evaluate(
    ({ texts, scopes }) => {
      const norm = (s) =>
        String(s || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

      const wanted = texts.map(norm);
      const nodes = [];
      scopes.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (!isVisible(el)) return;
          nodes.push(el);
        });
      });

      for (const el of nodes) {
        const t = norm(el.innerText || el.textContent || "");
        if (!t) continue;
        for (const w of wanted) {
          if (t.includes(w)) {
            el.click();
            return true;
          }
        }
      }
      return false;

      // helper visible inside page context
      function isVisible(node) {
        if (!node) return false;
        const st = node.ownerDocument && node.ownerDocument.defaultView
          ? node.ownerDocument.defaultView.getComputedStyle(node)
          : null;
        if (!st) return true;
        if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")
          return false;
        const rect = node.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0;
      }
    },
    { texts, scopes }
  );
}

// Cookie banner kapat
async function dismissCookies(page) {
  const labels = [
    "kabul et",
    "kabul",
    "izin ver",
    "tamam",
    "anladım",
    "kapat",
    "accept",
    "allow",
    "got it",
    "ok"
  ];
  for (let i = 0; i < 3; i++) {
    const clicked = await clickByText(page, labels, [
      "button",
      "a",
      "[role='button']",
      "div",
      "span",
    ]);
    if (clicked) return true;
    await sleep(250);
  }
  return false;
}

// “Tüm Tarihler” modali açmayı dene
async function openDatesModal(page) {
  const openers = [
    "Tüm Tarihler ve Fiyatlar",
    "Tüm Tarihler",
    "Tarihler",
    "Takvim",
  ];
  for (let i = 0; i < 2; i++) {
    const clicked = await clickByText(page, openers);
    if (clicked) {
      // modal gelmesi için kısa bekleme
      await sleep(700);
      const hasModal = await page.evaluate(() => {
        // tipik modal yakalama
        const cands = Array.from(document.querySelectorAll(".modal, [role='dialog']"));
        return cands.some((n) => {
          const st = window.getComputedStyle(n);
          const rect = n.getBoundingClientRect();
          return st.display !== "none" && st.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        });
      });
      if (hasModal) return true;
    }
  }
  return false;
}

function normalizeDate(s) {
  // 1.1.2026 → 01.01.2026
  const m = String(s || "").match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
}

// Modal içi tıklanabilir tarih düğmelerini/öğelerini topla (label & click fn)
async function collectDateTargets(page) {
  // Önce modal içindeki buton/elemanlar
  const inModal = await page.evaluate(() => {
    const res = [];
    const modal = Array.from(document.querySelectorAll(".modal, [role='dialog']")).find((n) => {
      const st = window.getComputedStyle(n);
      const rect = n.getBoundingClientRect();
      return st.display !== "none" && st.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const root = modal || document;
    const candidates = Array.from(
      root.querySelectorAll("button, a, [role='button'], .day, .date, [data-date]")
    ).filter((el) => {
      const st = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return st.display !== "none" && st.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });

    for (const el of candidates) {
      const txt = (el.innerText || el.textContent || el.getAttribute("data-date") || "").trim();
      if (!txt) continue;
      // Date text içinde dd.MM.yyyy yakala
      const m = txt.match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
      if (m) {
        res.push({ text: txt, date: m[0] });
      }
    }
    return res;
  });

  // Yoksa sayfa genelinde yazıdan elde et
  let fromText = [];
  if (!inModal.length) {
    fromText = await page.evaluate(() => {
      const t = document.body.innerText || "";
      const found = t.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || [];
      return Array.from(new Set(found)).map((d) => ({ text: d, date: d }));
    });
  }

  const merged = uniq([...inModal, ...fromText].map((x) => normalizeDate(x.date))).map((d) => ({
    text: d,
    date: d,
  }));
  return merged;
}

// “Hesapla / Fiyat” butonuna bas
async function pressCalculate(page) {
  const labels = ["hesapla", "fiyat"];
  for (let i = 0; i < 2; i++) {
    const clicked = await clickByText(page, labels, ["button", "a", "[role='button']", "div"]);
    if (clicked) {
      // isteklerin tamamlanması için bekleme
      try {
        if (typeof page.waitForNetworkIdle === "function") {
          await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 });
        } else {
          await sleep(1200);
        }
      } catch (_) {}
      return true;
    }
    await sleep(300);
  }
  return false;
}

// Fiyatı oku
async function readPrice(page) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => document.body.innerText || "");
    // TL / ₺ / € / EUR / USD
    const m =
      txt.match(
        /(?:₺|\bTL\b|\bEUR\b|€|\bUSD\b)\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?|\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*(?:TL|₺|EUR|€|USD)\b/i
      ) || [];
    if (m.length) {
      const cleaned = m[0].replace(/\s+/g, " ").trim();
      if (!/^0+ ?(TL|₺|EUR|€|USD)$/i.test(cleaned)) return cleaned;
    }
    await sleep(300);
  }
  return "";
}

// Belirli tarih label'ını (metin) içeren elemanı bulup tıkla
async function clickDateByText(page, dateText) {
  return page.evaluate((want) => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const rootModal =
      Array.from(document.querySelectorAll(".modal, [role='dialog']")).find((n) => {
        const st = window.getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
      }) || document;
    const els = Array.from(
      rootModal.querySelectorAll("button, a, [role='button'], .day, .date, [data-date]")
    );

    for (const el of els) {
      const txt = norm(el.innerText || el.textContent || el.getAttribute("data-date") || "");
      if (txt.includes(want)) {
        el.click();
        return true;
      }
    }

    // son çare: sayfa genelinde metni içeren bir node'a tıklama
    const all = Array.from(document.querySelectorAll("*"));
    for (const el of all) {
      if (!el) continue;
      const t = norm(el.innerText || el.textContent || "");
      if (!t) continue;
      if (t.includes(want)) {
        try { el.click(); return true; } catch(_) {}
      }
    }
    return false;
  }, dateText);
}

// ---------- endpoints ----------

// health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now(), tag: "calc-v4" }));

// diagnostik
app.get("/probe", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: EXE,
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
    await dismissCookies(page);

    // modal açmayı dene
    const openerClicked = await openDatesModal(page);

    // durumları oku
    const modalPresent = await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll(".modal, [role='dialog']"));
      return c.some((n) => {
        const st = window.getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
      });
    });

    const bodyTextCount = await page.evaluate(() => {
      const t = document.body.innerText || "";
      const m = t.match(/\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g) || [];
      return new Set(m).size;
    });

    res.json({
      ok: true,
      url,
      openerClicked,
      modalPresent,
      textDateNodes: bodyTextCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// asıl: tarih → hesapla → fiyat
// /calc?url=...&token=efe123&limit=12
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = String(req.query.url || "").trim();
  const limit = Math.max(1, Math.min(30, Number(req.query.limit || 12)));

  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: EXE,
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
    await dismissCookies(page);
    await openDatesModal(page); // varsa aç

    // tarih hedefleri
    const targets = await collectDateTargets(page);
    if (!targets.length) {
      return res.json({ ok: true, url, schedule: [], failed: [{ reason: "no_dates_found" }] });
    }

    const picked = targets.slice(0, limit);
    const schedule = [];
    const failed = [];

    for (const t of picked) {
      // 1) tarihi tıkla
      const clicked = await clickDateByText(page, t.date);
      if (!clicked) {
        failed.push({ date: t.date, reason: "date_click_failed" });
        continue;
      }
      await sleep(400);

      // 2) “Hesapla / Fiyat” tıkla
      const pressed = await pressCalculate(page);
      if (!pressed) {
        failed.push({ date: t.date, reason: "calculate_button_not_found" });
        continue;
      }

      // 3) fiyatı oku
      const price = await readPrice(page);
      if (price) schedule.push({ date: t.date, price });
      else failed.push({ date: t.date, reason: "price_not_found" });
    }

    // uniq & sırala
    const uniqSched = uniq(schedule.map((x) => JSON.stringify(x))).map((s) =>
      JSON.parse(s)
    );
    res.json({ ok: true, url, schedule: uniqSched, failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servis hazır:", PORT, "calc-v4");
});
