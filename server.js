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

function normDate(s) {
  const m = s && s.match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  const d = m[1].padStart(2, "0");
  const mo = m[2].padStart(2, "0");
  const y = m[3];
  return `${d}.${mo}.${y}`;
}

async function launch() {
  return puppeteer.launch({
    protocol: "cdp",              // <-- klasik API
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

async function clickByText(page, texts = [], scope = null) {
  // texts: ["Tüm Tarihler", "Tüm Tarihler ve Fiyatlar", "Hesapla", "Fiyat"]
  const res = await page.evaluate(
    ({ texts, scope }) => {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return false;
      const candidates = Array.from(
        root.querySelectorAll(
          [
            "button",
            "a",
            "[role='button']",
            ".btn",
            "[class*='btn']",
            "div",
            "span",
            "label",
          ].join(",")
        )
      );
      const want = texts.map((t) => t.toLowerCase());
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (!txt) continue;
        if (want.some((t) => txt.includes(t))) {
          el.click();
          return true;
        }
      }
      return false;
    },
    { texts, scope }
  );
  return !!res;
}

async function waitPriceText(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => document.body.innerText || "");
    const m =
      txt.match(
        /(?:₺|\bTL\b|\bEUR\b|\bUSD\b)\s*\d{2,6}(?:[.,]\d{2})?|\b\d{2,6}(?:[.,]\d{2})?\s*(?:TL|₺|EUR|USD)\b/i
      ) || txt.match(/\b\d{2,6}\s*₺\b/);
    if (m) return m[0].replace(/\s+/g, " ").trim();
    await sleep(400);
  }
  return "";
}

async function findDateButtons(page) {
  // Modal varsa öncelikle orada ara
  const hasModal = await page.evaluate(() => {
    return !!document.querySelector(".modal.show,.modal[style*='display: block'],.modal.open,[class*='modal'][aria-hidden='false']");
  });

  const selectors = [
    "[data-date]",
    ".date",
    ".day",
    "button.date",
    "a.date",
    ".calendar button",
    ".calendar a",
    ".calendar [data-date]",
  ];
  const scope = hasModal ? ".modal.show, .modal[style*='display: block'], .modal.open" : null;

  // 1) veri-öznitelikli veya sınıflı düğmeler
  const handles = [];
  for (const sel of selectors) {
    const found = await page.$$(scope ? `${scope} ${sel}` : sel);
    handles.push(...found);
  }

  // 2) Düğme yoksa düz metinden tarih geçen clickable node bul
  const textNodes = await page.evaluateHandle((scopeSel) => {
    const root = scopeSel ? document.querySelector(scopeSel) : document;
    const nodes = [];
    const all = Array.from(
      root.querySelectorAll("button, a, [role='button'], .btn, [class*='btn'], div, span, label")
    );
    for (const el of all) {
      const t = (el.innerText || el.textContent || "").trim();
      if (/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/.test(t)) nodes.push(el);
    }
    return nodes;
  }, hasModal ? ".modal.show, .modal[style*='display: block'], .modal.open" : null);

  const textNodeProps = await page.evaluate((arr) => arr.length, textNodes).catch(() => 0);

  return { handles, hasModal, textNodeProps, textNodes };
}

// ---------- health ----------
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- keşif: sayfada ne var? ----------
app.get("/probe", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });

    // Çerez kapatma
    const cookieClicked = await clickByText(page, ["kabul", "kapat", "çerez", "cookie"]);

    // 'Tüm Tarihler' butonlarını say
    const openers = {};
    for (const label of ["Tüm Tarihler", "Tüm Tarihler ve Fiyatlar", "Tarihler"]) {
      const count = await page.evaluate((label) => {
        const all = Array.from(
          document.querySelectorAll(
            "button,a,[role='button'],.btn,[class*='btn'],div,span,label"
          )
        );
        return all.filter((el) =>
          (el.innerText || el.textContent || "").toLowerCase().includes(label.toLowerCase())
        ).length;
      }, label);
      openers[label] = { count };
    }

    // Tüm Tarihler’e tıklamayı dene (modal açılacak mı?)
    const opened = await clickByText(page, ["Tüm Tarihler ve Fiyatlar", "Tüm Tarihler", "Tarihler"]);
    await sleep(800);
    const modalPresent = await page.evaluate(() => {
      return !!document.querySelector(".modal.show,.modal[style*='display: block'],.modal.open,[class*='modal'][aria-hidden='false']");
    });

    const { handles, hasModal, textNodeProps } = await findDateButtons(page);
    const hesaplaButtons = await page.evaluate(() => {
      const all = Array.from(
        document.querySelectorAll("button,a,[role='button'],.btn,[class*='btn'],div,span,label")
      );
      return all.filter((el) => {
        const t = (el.innerText || el.textContent || "").toLowerCase();
        return t.includes("hesapla") || t.includes("fiyat");
      }).length;
    });

    res.json({
      ok: true,
      url,
      cookieClicked,
      openers,
      clickedOpeners: opened,
      modalPresent,
      hasModal,
      modalDateNodes: hasModal ? handles.length : 0,
      pageDateNodes: !hasModal ? handles.length : 0,
      textDateNodes: textNodeProps || 0,
      hesaplaButtons,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ---------- asıl akış: tarih → hesapla → fiyat ----------
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL eksik" });

  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(90000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });

    // Çerez kapatma (varsa)
    await clickByText(page, ["kabul", "kapat", "çerez", "cookie"]);
    await sleep(400);

    // 1) Tarih/fiyat modalını aç
    await clickByText(page, ["Tüm Tarihler ve Fiyatlar", "Tüm Tarihler", "Tarihler"]);
    await sleep(800);

    // 2) Modal (veya sayfa) içinden tarih düğmelerini topla
    const { handles, hasModal, textNodes } = await findDateButtons(page);

    // 3) Buton/hücre listesinden tıkla → Hesapla/Fiyat → fiyatı al
    const schedule = [];
    const failed = [];

    async function pressCalculateAndRead() {
      const pressed =
        (await clickByText(page, ["Hesapla", "Fiyat"], hasModal ? ".modal" : null)) ||
        (await clickByText(page, ["Hesapla", "Fiyat"], null));
      if (pressed) {
        try {
          if (typeof page.waitForNetworkIdle === "function") {
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 });
          } else {
            await sleep(1000);
          }
        } catch {}
      }
      const price = (await waitPriceText(page)) || "";
      return price;
    }

    // a) belirlenen element handle’ları ile (ilk 25 ile sınır)
    let clicks = 0;
    for (const h of handles.slice(0, 25)) {
      try {
        const label = await page.evaluate((el) => el.innerText || el.getAttribute("data-date") || "", h);
        const d = normDate(label || "");
        if (!d) continue;

        await h.click();
        await sleep(400);

        const price = await pressCalculateAndRead();
        if (price) schedule.push({ date: d, price });
        else failed.push({ date: d, reason: "price_not_found" });

        clicks++;
        if (clicks >= 20) break;
      } catch {}
    }

    // b) hâlâ yoksa, metinden bulunan tıklanabilir tarih düğümlerini dene (ilk 15)
    if (!schedule.length && textNodes) {
      const count = await page.evaluate((arr) => arr.length, textNodes).catch(() => 0);
      for (let i = 0; i < Math.min(count, 15); i++) {
        try {
          const label = await page.evaluate(
            (arr, idx) => {
              const el = arr[idx];
              return el ? (el.innerText || el.textContent || "") : "";
            },
            textNodes,
            i
          );
          const d = normDate(label || "");
          if (!d) continue;

          await page.evaluate(
            (arr, idx) => {
              const el = arr[idx];
              if (el) el.click();
            },
            textNodes,
            i
          );
          await sleep(400);

          const price = await pressCalculateAndRead();
          if (price) schedule.push({ date: d, price });
          else failed.push({ date: d, reason: "price_not_found" });
        } catch {}
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

// ---- dinle ----
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servis hazır:", PORT);
});
