import express from 'express';
import { chromium } from 'playwright';
const app = express();
app.use(express.json({ limit: '2mb' }));

async function tryAcceptAll(page, selectors, timeout = 3000) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { try { await el.click({ timeout: 1000 }); return true; } catch {} }
  }
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (el) { await el.click({ timeout: 1000 }); return true; }
      } catch {}
    }
  }
  return false;
}
async function removeOverlays(page) {
  await page.evaluate(() => {
    const killers = [
      '#onetrust-consent-sdk','#onetrust-banner-sdk','#ot-sdk-container',
      '.ot-sdk-row','.onetrust-pc-dark-filter','.onetrust-pc-dark-banner',
      '[data-testid="uc-overlay"]','.uc-overlay','iframe[src*="usercentrics"]',
      '#didomi-host','.didomi-popup','.didomi-consent-popup','[id^="sp_message_container_"]',
      '.cc-window','.cookiebar','.cookie-banner','.cookie-consent','.borlabs-cookie',
      '.js-consent-banner','.cconsent','.CybotCookiebotDialog',
    ];
    killers.forEach(k => document.querySelectorAll(k).forEach(n => n.remove()));
    document.querySelectorAll('[role="dialog"],[aria-modal="true"]').forEach(n => n.remove());
    const html = document.documentElement, body = document.body;
    if (html) { html.style.overflow = 'visible'; html.style.position = 'static'; }
    if (body) { body.style.overflow = 'visible'; body.style.position = 'static'; }
  });
}
async function normalizeDom(page) {
  await page.addStyleTag({
    content: `
      * { scroll-margin: 0 !important; }
      body, html { overflow: visible !important; }
      *[style*="position:fixed"], *[style*="position: sticky"],
      .sticky, .is-sticky { position: static !important; top:auto!important; }
      details { display:block !important; }
    `
  });
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  await page.evaluate(async () => {
    await new Promise(resolve => {
      const step = () => {
        const before = window.scrollY;
        window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
        if (window.innerHeight + window.scrollY + 5 < document.body.scrollHeight) {
          setTimeout(step, 100);
        } else {
          setTimeout(() => { window.scrollTo(0, 0); resolve(); }, 300);
        }
      };
      step();
    });
  });
}
const SELECTORS = [
  '#onetrust-accept-btn-handler','button#onetrust-accept-btn-handler',
  'button:has-text("Alle akzeptieren")','button:has-text("Accept all")','button:has-text("Accept All")',
  'button[data-testid="uc-accept-all-button"]','button:has-text("Ich stimme zu")','button:has-text("Zustimmen")',
  '#didomi-notice-agree-button','button:has-text("I agree")',
  'button.borlabs-cookie-accept','a.borlabs-cookie-accept',
  '#CybotCookiebotDialogBodyLevelButtonAccept','.cc-allow','button:has-text("OK")','button:has-text("Akzeptieren")'
];
async function openPageAndClean(url, viewport, userAgent, timeoutMs) {
  const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'], headless: true });
  const context = await browser.newContext({ viewport, userAgent });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
  await tryAcceptAll(page, SELECTORS, 3000);
  await removeOverlays(page);
  await normalizeDom(page);
  await tryAcceptAll(page, SELECTORS, 1000);
  await removeOverlays(page);
  return { browser, context, page };
}
app.post('/screenshot', async (req, res) => {
  const {
    url,
    viewport = { width: 1440, height: 1200, deviceScaleFactor: 1 },
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    timeoutMs = 120000,
    fullPage = true
  } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing "url" string' });
  let browser, context;
  try {
    const r = await openPageAndClean(url, viewport, userAgent, timeoutMs);
    browser = r.browser; context = r.context;
    const buf = await r.page.screenshot({ fullPage, type: 'png' });
    await context.close(); await browser.close();
    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(buf);
  } catch (e) {
    try { if (context) await context.close(); if (browser) await browser.close(); } catch {}
    console.error('screenshot error', e);
    return res.status(500).json({ error: 'screenshot_failed', detail: String(e) });
  }
});
app.post('/content', async (req, res) => {
  const {
    url,
    viewport = { width: 1440, height: 1200, deviceScaleFactor: 1 },
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    timeoutMs = 120000
  } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing "url" string' });
  let browser, context;
  try {
    const r = await openPageAndClean(url, viewport, userAgent, timeoutMs);
    browser = r.browser; context = r.context;
    const html = await r.page.content();
    await context.close(); await browser.close();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    try { if (context) await context.close(); if (browser) await browser.close(); } catch {}
    console.error('content error', e);
    return res.status(500).json({ error: 'content_failed', detail: String(e) });
  }
});
app.get('/healthz', (_req, res) => res.status(200).send('OK'));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`noconsent-screenshot listening on ${PORT}`));
