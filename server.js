```javascript
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Service is running' });
});

// Probe endpoint: Test for presence of key elements like "Tüm Tarihler" button or calendar
app.post('/probe', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'URL is required' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=tr-TR,tr;q=0.9,en-US;q=0.8'],
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Check for "Tüm Tarihler" button
    const tumTarihlerButton = await page.$('button:contains("Tüm Tarihler")') || await page.locator('text="Tüm Tarihler"').elementHandles()[0];

    // Check for "Hesapla" button
    const hesaplaButton = await page.$('button:contains("Hesapla")') || await page.locator('text="Hesapla"').elementHandles()[0];

    // Check for calendar
    const calendar = await page.$('.ui-datepicker-calendar');

    await browser.close();

    res.json({
      ok: true,
      url,
      hasTumTarihler: !!tumTarihlerButton,
      hasHesapla: !!hesaplaButton,
      hasCalendar: !!calendar,
    });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Calc endpoint: Extract dates and prices, interacting if necessary
app.post('/calc', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'URL is required' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=tr-TR,tr;q=0.9,en-US;q=0.8'],
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Optional: Click "Tüm Tarihler" if exists to load all dates
    try {
      const tumTarihler = await page.waitForSelector('text="Tüm Tarihler"', { timeout: 5000 });
      if (tumTarihler) {
        await tumTarihler.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      }
    } catch {} // Ignore if not found

    // Extract from price table if present
    const schedule = await page.evaluate(() => {
      // Find the table with 'Tarih' header
      const tables = Array.from(document.querySelectorAll('table'));
      const priceTable = tables.find(table => {
        const ths = table.querySelectorAll('th');
        return Array.from(ths).some(th => th.textContent.trim() === 'Tarih' || th.textContent.trim().includes('Tarih'));
      });

      if (!priceTable) return [];

      const rows = Array.from(priceTable.querySelectorAll('tbody tr'));
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) return null;

        const date = cells[0].textContent.trim();
        const availability = cells[1].textContent.trim();
        if (availability !== 'Müsait') return null; // Only include available dates

        // Price is in the third cell (İki Kişilik Odada Kişi Başı), take the discounted price after <br>
        const priceHtml = cells[2].innerHTML;
        const prices = priceHtml.split('<br>').map(p => p.trim().replace(/[^\d., €₺TL]+/g, ''));
        const price = prices[1] || prices[0]; // Prefer discounted if available

        return { date, price };
      }).filter(Boolean);
    });

    // If no table found, attempt interactive calendar extraction
    if (schedule.length === 0) {
      // Assume jQuery UI Datepicker
      const hasCalendar = await page.$('.ui-datepicker-calendar');
      if (hasCalendar) {
        // Get current year (from page or assume 2025)
        const currentYear = new Date().getFullYear(); // Or parse from page

        // Get month from .ui-datepicker-month
        const month = await page.evaluate(() => document.querySelector('.ui-datepicker-month')?.textContent.trim());

        // Map month name to number
        const monthMap = {
          'Ocak': '01', 'Şubat': '02', 'Mart': '03', 'Nisan': '04', 'Mayıs': '05', 'Haziran': '06',
          'Temmuz': '07', 'Ağustos': '08', 'Eylül': '09', 'Ekim': '10', 'Kasım': '11', 'Aralık': '12'
        };
        const mm = monthMap[month] || '01';

        // Get all available date links
        const dateElements = await page.$$('.ui-datepicker-calendar td a:not(.ui-state-disabled)');

        for (const dateElem of dateElements) {
          const day = await page.evaluate(el => el.textContent.trim().padStart(2, '0'), dateElem);
          const date = `${day}.${mm}.${currentYear}`;

          // Click date
          await dateElem.click();
          await page.waitForTimeout(500); // Wait for selection

          // Click Hesapla if exists
          const hesapla = await page.$('text="Hesapla"');
          if (hesapla) {
            await hesapla.click();
            await page.waitForSelector('.price', { timeout: 5000 }); // Wait for price to load
          }

          // Extract price (assume .price or similar)
          const price = await page.evaluate(() => {
            const priceElem = document.querySelector('.price') || document.querySelector('[class*="price"]');
            return priceElem ? priceElem.textContent.trim() : 'N/A';
          });

          schedule.push({ date, price });
        }
      }
    }

    await browser.close();

    res.json({ ok: true, url, schedule });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
```
