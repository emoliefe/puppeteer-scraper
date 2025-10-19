const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";
const chromePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : undefined);

const ok = (req) =>
  !TOKEN || req.query.token === TOKEN || req.header("x-token") === TOKEN;

const uniq = (arr) => Array.from(new Set(arr || []));

// ---------- yardımcılar ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normDate(s) {
  const m = s.match(/\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
}

// Belirli metni içeren (button, a vb) ilk görünen elemente tıkla
async function clickByText(page, texts = [], tagFilter = ["button", "a"]) {
  return await page.evaluate((texts, tagFilter) => {
    const haystack = Array.from(
      document.querySelectorAll(tagFilter.join(","))
    ).filter((el) => {
      const st = window.getComputedStyle(el);
      const vis = st && st.visibility !== "hidden" && st.display !== "none";
      const box = el.getBoundingClientRect();
      return vis && box.width > 1 && box.height > 1 && !el.disabled;
    });

    function containsText(el, needle) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      return t.includes(needle.toLowerCase());
    }

    for (const t of texts) {
      const node = haystack.find((el) => containsText(el, t));
      if (node) {
        node.scrollIntoView({ block: "center", inline: "center" });
        node.click();
        return true;
      }
    }
    return false;
  }, texts, tagFilter);
}

// (XPath tek atım) — sadece EVAL içinde bularak click eder (ElementHandle kullanmaz)
async function clickByXPathOnce(page, xpath) {
  return await page.evaluate((xp) => {
    try {
      const it = document.evaluate(
        xp,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      const el = it.singleNodeValue;
      if (!el) return false;
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, xpath);
}

// “Kabul et / Cookies” vb tıklamaları dener
async function dismissOverlays(page) {
  await clickByText(page, ["Kabul Et", "Kabul et", "Anladım", "Tamam", "Accept", "I Agree"]);
  await sleep(400);
}

// Fiyat metnini sayfadan oku
async function readPrice(page, deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const price = await page.evaluate(() => {
      // görünür, para içeren alanları tara
      const moneyRe =
        /(?:₺|\bTL\b|\bEUR\b|\bUSD\b)\s*\d{2,6}(?:[.,]\d{2})?|\b\d{2,6}(?:[.,]\d{2})?\s*(?:TL|₺|EUR|USD)\b/i;

      // Seçici adayları
      const nodes = Array.from(
        document.querySelectorAll(
          ".price, .fiyat, .tour-price, .calculated-price, .result-price, .total-price, [class*='price'], [class*='fiyat'], span, div, p, b, strong"
        )
      );

      for (const el of nodes) {
        const st = window.getComputedStyle(el);
        if (!st || st.visibility === "hidden" || st.display === "none") continue;
        const box = el.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;

        const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t) continue;

        const m = t.match(moneyRe);
        if (m) {
          const txt = m[0].replace(/\s+/g, " ").trim();
          if (!/^0+ ?(TL|₺|EUR|USD)$/i.test(txt)) return txt;
        }
      }

      // Son çare: body text
      const body = (document.body.innerText || "").replace(/\s+/g, " ");
      const m2 = body.match(moneyRe);
      return m2 ? m2[0].replace(/\s+/g, " ").trim() : "";
    });

    if (price) return price;
    await sleep(400);
  }
  return "";
}

// Modal veya sayfada tarih buton/hücre adaylarını (görünür) bul
async function collectClickableDateLabels(page) {
  return await page.evaluate(() => {
    const reDate = /\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/;
    const candidates = Array.from(
      document.querySelectorAll(
        ".modal [data-date], .modal .date, .modal .day, .modal button, .modal a, " +
          "[data-date], .date, .day, button, a, td, div"
      )
    );

    const out = [];
    for (const el of candidates) {
      const st = window.getComputedStyle(el);
      if (!st || st.visibility === "hidden" || st.display === "none") continue;
      if (el.closest("[aria-hidden='true']")) continue;

      const box = el.getBoundingClientRect();
      if (box.width < 6 || box.height < 6) continue;
      if (el.hasAttribute("disabled")) continue;

      let label =
        el.getAttribute("data-date") ||
        (el.innerText || el.textContent || "").trim();

      if (!label) continue;
      const m = label.match(reDate);
      if (!m) continue;

      out.push({ label: m[0], xpath: null }); // xpath üretmeden text’e göre tıklayacağız
    }

    // Body text’ten de yakala (yedek)
    const bodyDates = (document.body.innerText || "").match(
      /\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/g
    ) || [];

    for (const d of bodyDates) out.push({ label: d, xpath: null });

    // benzersiz
    const seen = new Set();
    return out.filter((o) => {
      const key = o.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

// “Hesapla/Fiyat” düğmesi bas
async function pressCalculate(page) {
  // önce metne göre
  if (await clickByText(page, ["Hesapla", "Fiyat", "Fiyatı Hesapla"])) return true;

  // sonra genel XPath (tek sefer)
  if (await clickByXPathOnce(page, "//button[contains(translate(., 'I', 'i'), 'hesapla') or contains(translate(., 'I', 'i'), 'fiyat')]")) return true;
  if (await clickByXPathOnce(page, "//a[contains(translate(., 'I', 'i'), 'hesapla') or contains(translate(., 'I', 'i'), 'fiyat')]")) return true;

  return false;
}

// ---------- endpoints ----------

// health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// probe: açıcıları ve adayları say
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
    page.setDefaultTimeout(60000);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

    await dismissOverlays(page);

    // açıcı metinler
    const openers = ["Tüm Tarihler ve Fiyatlar", "Tüm Tarihler", "Tarihler", "Takvim", "Tüm Tarihler & Fiyatlar"];
    const openCount = {};
    for (const t of openers) {
      const ok = await clickByText(page, [t], ["button", "a", "div", "span"]);
      openCount[t] = { clicked: ok };
      if (ok) break;
    }

    await sleep(800);

    const modalPresent = await page.evaluate(() => {
      return !!document.querySelector(".modal.show, [role='dialog'].show, .modal[style*='display: block']");
    });

    const dateNodes = await collectClickableDateLabels(page);

    const hesaplaCount = await page.evaluate(() => {
      const texts = ["hesapla", "fiyat"];
      const cand = Array.from(document.querySelectorAll("button, a"));
      return cand.filter((el) => {
        const t = (el.innerText || el.textContent || "").toLowerCase();
        return texts.some((w) => t.includes(w));
      }).length;
    });

    res.json({
      ok: true,
      url,
      openers: openCount,
      modalPresent,
      dateCandidates: dateNodes.length,
      hesaplaButtons: hesaplaCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// calc: tarihleri tek tek tıkla → hesapla → fiyat oku
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

    await dismissOverlays(page);

    // Açıcıyı dene
    await clickByText(page, ["Tüm Tarihler ve Fiyatlar", "Tüm Tarihler", "Tarihler", "Takvim"], ["button","a","div","span"]);
    await sleep(600);

    const candidates = await collectClickableDateLabels(page);
    const dates = uniq(candidates.map((c) => normDate(c.label))).slice(0, 20);

    const schedule = [];
    const failed = [];

    // Her tarih için: bul → tıkla → hesapla → fiyat
    for (const d of dates) {
      // aynı sayfada kalıp tekrar arayacağız, bu yüzden aşırı hızlı olmayalım
      // önce d içeren buton/hücreyi metne göre bulup tıkla
      const clicked = await page.evaluate((target) => {
        const all = Array.from(document.querySelectorAll(
          ".modal [data-date], .modal .date, .modal .day, .modal button, .modal a, " +
          "[data-date], .date, .day, button, a, td, div"
        ));
        const re = new RegExp(target.replace(/\./g, "\\."));
        const el = all.find((n) => {
          const lab = n.getAttribute("data-date") || (n.innerText || n.textContent || "");
          return re.test(lab);
        });
        if (!el) return false;
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          return true;
        }
        return false;
      }, d);

      if (!clicked) {
        failed.push({ date: d, reason: "date_not_clickable" });
        continue;
      }

      await sleep(400);

      const pressed = await pressCalculate(page);
      if (!pressed) {
        failed.push({ date: d, reason: "calc_button_not_found" });
        continue;
      }

      // ağ sakinleşsin / UI render olsun
      try {
        if (typeof page.waitForNetworkIdle === "function") {
          await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 });
        } else {
          await sleep(1200);
        }
      } catch {
        await sleep(800);
      }

      const price = await readPrice(page, 8000);
      if (price) schedule.push({ date: d, price });
      else failed.push({ date: d, reason: "price_not_found" });

      // küçük nefes
      await sleep(300);
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

// ---- listen ----
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servis hazır:", PORT);
});
