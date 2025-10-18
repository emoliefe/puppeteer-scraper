const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "";

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ error: "URL eksik" });

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2" });

  const button = await page.$x("//button[contains(., 'Tüm Tarihler')]");
  if (button.length > 0) await button[0].click();
  await page.waitForTimeout(2000);

  const text = await page.evaluate(() => document.body.innerText);
  const dates = [...new Set(text.match(/\d{1,2}\.\d{1,2}\.\d{4}/g))];
  const priceMatch = text.match(/(\d+)\s*(TL|₺)/i);
  const price = priceMatch ? priceMatch[0] : "";

  await browser.close();
  res.json({ tarihler: dates, fiyat: price });
});

app.listen(PORT, () => console.log("✅ Puppeteer servisi çalışıyor:", PORT));
