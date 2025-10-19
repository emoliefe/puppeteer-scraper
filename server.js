// server.js
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

const PORT = process.env.PORT || 3000;
// İsteğe bağlı basit güvenlik: URL'de ?token=... veya Header: x-token
const TOKEN = process.env.TOKEN || "";

/* Basit sağlık kontrolü */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

/* Küçük yardımcılar */
function authOk(req) {
  if (!TOKEN) return true;
  const q = req.query.token;
  const h = req.header("x-token");
  return q === TOKEN || h === TOKEN;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

/* /scrape?url=...&date=DD.MM.YYYY (opsiyonel) */
app.get("/scrape", async (req, res) => {
  try {
    if (!authOk(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const url = (req.query.url || "").trim();
    const targetDate = (req.query.date || "").trim(); // ör. 15.11.2025

    if (!url) return res.status(400).json({ error: "URL eksik" });

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
      // puppeteer imajında Chromium yüklü geliyor
    });

    const page = await browser.newPage();

    // Daha stabil olsun diye ufak ayarlar:
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    );
    page.setDefaultTimeout(60_000);

    await page.goto(url, { waitUntil: "networkidle2" });

    // 1) “Tüm Tarihler” butonunu açmayı dener (varsa)
    try {
      const btnXPath = "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZÇĞİÖŞÜ', 'abcdefghijklmnopqrstuvwxyzçğiöşü'), 'tüm tarihler')]";
      const btns = await page.$x(btnXPath);
      if (btns.length) {
        await btns[0].click();
        await page.waitForTimeout(1500);
      }
    } catch (_) {}

    // 2) Eğer 'date' parametresi verildiyse bu tarihi seçip “Hesapla”ya basmayı dener
    let clickedDate = "";
    if (targetDate) {
      try {
        // Tarih hücresi/etiketi tıklaması (metne göre)
        const dateXPath = `//*[contains(normalize-space(.), '${targetDate}')]`;
        const candidates = await page.$x(dateXPath);
        if (candidates.length) {
          await candidates[0].click();
          clickedDate = targetDate;
          await page.waitForTimeout(800);
        }

        // “Hesapla” butonu (çeşitli yazımlar için esnek arama)
        const hesaplaXPath =
          "//*[self::button or self::a or self::*[name()='span'] or self::*[name()='div']]" +
          "[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZÇĞİÖŞÜ', 'abcdefghijklmnopqrstuvwxyzçğiöşü'), 'hesapla')]";
        const hesaplaBtns = await page.$x(hesaplaXPath);
        if (hesaplaBtns.length) {
          await hesaplaBtns[0].click();
          // Hesap sonrası istekler bitsin
          await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30_000 }).catch(() => {});
        }
      } catch (_) {}
    }

    // 3) İçerikten tarih ve fiyatları çıkar
    const text = await page.evaluate(() => document.body.innerText || "");
    await browser.close();

    // Tarihler (DD.MM.YYYY)
    const dateRegex = /\b([0-3]?\d)\.([0-1]?\d)\.(\d{4})\b/g;
    const allDates = unique((text.match(dateRegex) || []).map(s => s.trim()));

    // Fiyatlar: “12.345 TL / ₺12.345,00 / 12345 TL” vb.
    const priceRegex = /(?:₺|\bTL\b)\s*[\d\.]+(?:,\d{2})?|\b[\d\.]+\s*(?:TL|₺)/gi;
    const allPrices = unique((text.match(priceRegex) || []).map(s => s.replace(/\s+/g, " ").trim()));

    // Eğer tek bir tarih seçildi ve “hesapla” yapıldıysa, dönen ilk fiyatı o tarihle eşleştir
    // (Bu kısım hedef siteye göre özelleştirilebilir; gerekirse spesifik selector ver, birlikte netleştiririz.)
    let result = {
      clickedDate: clickedDate || null,
      dates: allDates,
      prices: allPrices,
    };

    if (clickedDate && allPrices.length) {
      result.datePrice = { [clickedDate]: allPrices[0] };
    }

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

/* Önemli: 0.0.0.0'a dinle (container içinde dış arayüzlerden de erişilsin) */
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Puppeteer servisi çalışıyor:", PORT);
});
