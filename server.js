// ---------- tıkla → hesapla → tarih-fiyat eşle ( /calc ) ----------
app.get("/calc", async (req, res) => {
  if (!ok(req)) return res.status(401).json({ error: "unauthorized" });
  const url = (req.query.url || "").trim();
  const debug = String(req.query.debug || "") === "1";
  if (!url) return res.status(400).json({ error: "URL eksik" });

  const trace = [];
  const step = (msg, extra) => {
    const line = extra ? `${msg} :: ${JSON.stringify(extra).slice(0,400)}` : msg;
    trace.push(line);
    console.log("[CALC]", line);
  };

  let browser;
  try {
    step("launch()");
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1366,900",
        "--lang=tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultTimeout(120000);

    // Bot izini azalt
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8" });

    // Hız için görselleri kapat
    await page.setRequestInterception(true);
    page.on("request", req => {
      const r = req.resourceType();
      if (r === "image" || r === "media" || r === "font") req.abort(); else req.continue();
    });

    step("goto()", { url });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 180000 });

    // KVKK/çerez kapat
    async function dismissOverlays() {
      const xps = [
        "//button[contains(., 'Kabul') or contains(., 'ACCEPT') or contains(., 'Accept')]",
        "//button[contains(., 'Tamam') or contains(., 'Onayla') or contains(., 'Anladım')]",
        "//a[contains(., 'Kabul') or contains(., 'Tamam') or contains(., 'Anladım')]",
      ];
      for (const xp of xps) {
        try {
          const h = (await page.$x(xp))[0];
          if (h) { await h.click({ delay: 20 }); step("overlay dismissed", { xp }); await new Promise(r=>setTimeout(r,300)); }
        } catch {}
      }
    }

    await dismissOverlays();

    // Modal açmayı dene
    step("open dates modal");
    const opened = await (async () => {
      const triggers = [
        "//button[contains(., 'Tüm Tarihler ve Fiyatlar')]",
        "//button[contains(., 'Tüm Tarihler')]",
        "//a[contains(., 'Tüm Tarihler')]",
        "button[data-bs-target*='tarih']",
        "button[data-bs-toggle='modal']",
        ".btn-dates",".btn-calendar",
      ];
      for (const sel of triggers) {
        try {
          const h = sel.startsWith("//") ? (await page.$x(sel))[0] : await page.$(sel);
          if (h) { await h.click({ delay: 20 }); step("clicked trigger", { sel }); await new Promise(r=>setTimeout(r,500)); return true; }
        } catch {}
      }
      return false;
    })();
    step("modal opened?", { opened });

    // Lazy içerik olabilir → hafif scroll turu
    step("light scroll");
    await page.evaluate(() => new Promise(r => {
      let y = 0;
      const t = setInterval(() => {
        y += 400; window.scrollTo(0, y);
        if (y > document.body.scrollHeight) { clearInterval(t); r(); }
      }, 80);
    }));

    // Sayfadaki/Modal içindeki görünen tarih etiketleri
    step("collect dates");
    let dateLabels = await page.evaluate(() => {
      const out = new Set();
      const re = /\b([0-3]?\d)[./]([0-1]?\d)[./](\d{4})\b/;
      const cand = Array.from(document.querySelectorAll(
        ".modal * , [data-date], .date, .day, button, a, li, td, span, div"
      )).slice(0, 2000);
      for (const el of cand) {
        const t = (el.innerText || el.getAttribute("data-date") || "").trim();
        if (re.test(t)) {
          const m = t.match(re);
          const d = `${m[1].padStart(2,'0')}.${m[2].padStart(2,'0')}.${m[3]}`;
          out.add(JSON.stringify({ d, text: t }));
        }
      }
      return Array.from(out).map(s => JSON.parse(s));
    });
    const dates = Array.from(new Set((dateLabels || []).map(x => x.d)));
    step("dates found", { count: dates.length, sample: dates.slice(0,6) });

    // Buton basıldığında fiyatı sayfadan oku
    async function readPrice(deadlineMs = 15000) {
      const end = Date.now() + deadlineMs;
      const priceRe = /(?:₺|\bTL\b)\s*\d{3,6}(?:[.,]\d{2})?|\b\d{3,6}(?:[.,]\d{2})?\s*(?:TL|₺)\b/i;
      while (Date.now() < end) {
        const t = await page.evaluate(() => document.body.innerText || "");
        const m = t.match(priceRe);
        if (m) return m[0].replace(/\s+/g, " ").trim();
        // yaygın sınıflar
        const sel = ["[class*='price']", ".price,.fiyat,.tour-price,.calculated-price,.total-price"];
        for (const s of sel) {
          try {
            const v = await page.$eval(s, el => el.innerText || "");
            const mm = v.match(priceRe);
            if (mm) return mm[0].replace(/\s+/g, " ").trim();
          } catch {}
        }
        await new Promise(r=>setTimeout(r,300));
      }
      return "";
    }

    async function clickDateByText(d) {
      const xp = `//*[contains(normalize-space(.), '${d}')]`;
      const hs = await page.$x(xp);
      if (hs && hs[0]) {
        await hs[0].evaluate(el => el.scrollIntoView({ block: 'center' }));
        await hs[0].click({ delay: 20 });
        return true;
      }
      return false;
    }

    async function clickCalculate() {
      const sels = [
        "//button[contains(., 'Hesapla')]", "//a[contains(., 'Hesapla')]",
        "//button[contains(., 'Fiyat')]",   "//a[contains(., 'Fiyat')]",
      ];
      for (const sel of sels) {
        try {
          const h = (await page.$x(sel))[0];
          if (h) { await h.click({ delay: 20 }); return true; }
        } catch {}
      }
      return false;
    }

    const schedule = [];
    const failed = [];
    let tries = 0;

    for (const d of dates) {
      tries++; if (tries > 25) break;
      try {
        step("try date", { d });
        const okDate = await clickDateByText(d);
        if (!okDate) { failed.push({ date: d, reason: "date_not_clickable" }); continue; }
        await new Promise(r=>setTimeout(r,400));

        const pressed = await clickCalculate();
        step("pressed hesapla?", { pressed });
        if (pressed) await new Promise(r=>setTimeout(r,1000));

        const price = await readPrice(15000);
        step("price read", { d, price });
        if (price) schedule.push({ date: d, price }); else failed.push({ date: d, reason: "price_not_found" });
      } catch (e) {
        failed.push({ date: d, reason: "exception:"+e.message });
        step("exception", { d, msg: e.message });
      }
    }

    const payload = { ok: true, url, schedule, failed };
    if (debug) payload.trace = trace;
    return res.json(payload);
  } catch (e) {
    const payload = { error: e.message, trace };
    return res.status(500).json(payload);
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});
