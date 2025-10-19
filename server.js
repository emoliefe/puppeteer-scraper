const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || ""; // Coolify ENV: TOKEN=uzun_bir_gizli_deger

// Basit auth
app.use((req, res, next) => {
  if (!TOKEN) return next();
  const t = req.headers["x-api-token"] || req.query.token;
  if (t !== TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
});

app.get("/", (_, res) => res.json({ ok: true, service: "Lavinya Puppeteer", ts: Date.now() }));
app.get("/health", (_, res) => res.json({ ok: true }));

function launchOpts() {
  return {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ],
    defaultViewport: { width: 1366, height: 800 }
  };
}

async function openPage(url) {
  const browser = await puppeteer.launch(launchOpts());
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  );
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    // hız için resim/font iptal
    if (["image", "font"].includes(req.resourceType())) return req.abort();
    req.continue();
  });

  await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
  return { browser, page };
}

// Ekrandaki butonu metnine göre bulup tıklar
async function clickButtonByText(page, substrings, timeout = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const clicked = await page.$$eval("button, a, div, span", (nodes, subs) => {
      const hit = nodes.find((n) => {
        const text = (n.innerText || n.textContent || "").trim().toLowerCase();
        return text && subs.some((s) => text.includes(s));
      });
      if (hit) {
        hit.click();
        return true;
      }
      return false;
    }, substrings.map((s) => s.toLowerCase()));
    if (clicked) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

// Tüm tarihleri ve (varsa) sayfada görünen fiyat özetini döndürür
app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "url param gerekli" });

  const { browser, page } = await openPage(url);
  try {
    // 'Tüm Tarihler ve Fiyatlar' butonunu tetikle
    await clickButtonByText(page, ["tüm tarihler", "tüm tarihler ve fiyatlar"]);
    // modal içerik yüklensin
    await page.waitForTimeout(1500);

    // sayfadaki tüm metni al, tarihler ve olası fiyat yakala
    const text = await page.evaluate(() => document.body.innerText);
    const tarihler = Array.from(new Set(text.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g) || []));
    const priceMatch = text.match(/(\d{1,3}(\.\d{3})*|\d+)([.,]\d{2})?\s*(TL|₺|EURO|€|USD|\$)/i);
    const fiyat = priceMatch ? priceMatch[0].replace(/\s+/g, " ") : "";

    res.json({ ok: true, tarihler, fiyat });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// Belirli bir tarih satırındaki "Hesapla"yı tıkla → o tarihin fiyatını oku
app.get("/dates-and-price", async (req, res) => {
  const url = req.query.url;
  const date = (req.query.date || "").trim(); // DD.MM.YYYY
  if (!url || !date) return res.status(400).json({ ok: false, error: "url ve date gerekli" });

  const { browser, page } = await openPage(url);
  try {
    // Modalı aç
    await clickButtonByText(page, ["tüm tarihler", "tüm tarihler ve fiyatlar"]);
    await page.waitForTimeout(1200);

    // Modal/tabloda, içinde belirtilen tarih geçen satırı bulup içindeki 'Hesapla' benzeri butonu tıkla
    const rowClicked = await page.$$eval("*", (nodes, targetDate) => {
      const lower = targetDate.toLowerCase();
      // tarih geçen bir satır/öge bul
      const row = nodes.find((n) => (n.innerText || "").toLowerCase().includes(lower));
      if (!row) return false;
      // satır içinde hesapla/fiyatla butonu ara
      const btn =
        row.querySelector("button") ||
        Array.from(row.querySelectorAll("a,button")).find((b) =>
          (b.innerText || "").toLowerCase().match(/hesapla|fiyat|seç|devam/)
        );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }, date);

    if (!rowClicked) return res.status(404).json({ ok: false, error: "tarih satırı bulunamadı" });

    // Fiyatın ekrana gelmesini bekle (öngörü: modal, toast veya fiyat alanı)
    await page.waitForTimeout(1500);
    const afterText = await page.evaluate(() => document.body.innerText);
    const priceMatch =
      afterText.match(/(\d{1,3}(\.\d{3})*|\d+)([.,]\d{2})?\s*(TL|₺|EURO|€|USD|\$)/i) || [];
    const fiyat = priceMatch[0] ? priceMatch[0].replace(/\s+/g, " ") : "";

    res.json({ ok: true, date, fiyat });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

app.listen(PORT, () => console.log("✅ Puppeteer servis hazır:", PORT));
