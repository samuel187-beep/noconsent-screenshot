# server.js
/**
 * NC Monitor Render/Container Service
 * Endpunkte:
 *  - POST /screenshot  → Vollseiten-Screenshot nach Consent + DOM-Normalisierung
 *  - POST /content     → HTML + sichtbarer Text nach Consent + DOM-Normalisierung
 *
 * Playwright >= 1.55 kompatibel.
 */

const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 10000;

// Zeitlimits & Defaults
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT_MS || 120000);
const ACTION_TIMEOUT = Number(process.env.ACTION_TIMEOUT_MS || 15000);
const VIEWPORT = {
  width: Number(process.env.VIEWPORT_WIDTH || 1440),
  height: Number(process.env.VIEWPORT_HEIGHT || 1200),
  deviceScaleFactor: Number(process.env.DEVICE_SCALE_FACTOR || 1),
};

// Realistischer UA
const UA =
  process.env.UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// ---------- Hilfsfunktionen ----------
async function injectDomUtilities(page) {
  await page.addStyleTag({
    content: `
      * { scroll-margin: 0 !important; }
      html, body { overflow: visible !important; }
      *[style*="position:fixed"], *[style*="position: sticky"], .sticky, .fixed {
        position: static !important; inset: auto !important;
      }
    `,
  });

  await page.evaluate(() => {
    // Alle <details> öffnen
    document.querySelectorAll('details').forEach((d) => (d.open = true));
    // Lazy-Load triggern
    document.querySelectorAll('img[loading], img[data-src], source[data-srcset]').forEach((el) => {
      el.removeAttribute('loading');
      if (el.dataset.src) el.setAttribute('src', el.dataset.src);
      if (el.dataset.srcset) el.setAttribute('srcset', el.dataset.srcset);
    });
  });
}

async function autoScroll(page, maxSteps = 20, stepPx = 1200, waitMs = 400) {
  for (let i = 0; i < maxSteps; i++) {
    await page.evaluate((y) => window.scrollBy(0, y), stepPx);
    await page.waitForTimeout(waitMs);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function removeOffendingOverlays(page) {
  await page.evaluate(() => {
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    const kill = (el) => el && el.parentNode && el.parentNode.removeChild(el);

    const selectors = [
      '#onetrust-banner-sdk', '#onetrust-consent-sdk',
      '#usercentrics-root', 'div[id*="usercentrics"]', 'div[class*="usercentrics"]',
      'div[id*="uc-consent"]', 'div[class*="uc-consent"]',
      'div[id*="didomi"]', 'div[class*="didomi"]',
      '[data-testid="uc-overlay"]',
      '.cc-window', '.cookieconsent',
      'iframe[src*="consent"]',
      'div[role="dialog"]', '.ot-sdk-row', '.otFloatingButton', '.sp_veil',
    ];
    selectors.forEach((sel) => document.querySelectorAll(sel).forEach(kill));

    document.querySelectorAll('body *').forEach((el) => {
      try {
        const cs = window.getComputedStyle(el);
        const pos = cs.position;
        const zi = parseInt(cs.zIndex || '0', 10);
        const rect = el.getBoundingClientRect();
        const big = rect.width > vw * 0.6 && rect.height > vh * 0.4;
        const covering = rect.top <= 0 && rect.left <= 0 && rect.bottom >= vh * 0.7;
        if ((pos === 'fixed' || pos === 'sticky' || pos === 'absolute') && (zi > 1000 || big || covering)) {
          el.remove();
        }
      } catch {}
    });
  });
}

async function tryConsent(page) {
  const BUTTON_TEXTS = [
    // DE
    'Alle akzeptieren', 'Zustimmen', 'Akzeptieren', 'Ich stimme zu', 'Einverstanden', 'Cookies akzeptieren',
    // EN
    'Accept all', 'Accept All', 'Allow all', 'Agree', 'I agree', 'Accept',
    // FR/ES/IT
    'Tout accepter', 'Aceptar todo', 'Accetta tutto',
  ];

  const SELECTORS = [
    // OneTrust
    '#onetrust-accept-btn-handler', 'button[aria-label="Alle akzeptieren"]',
    // Usercentrics
    'button[data-testid="uc-accept-all-button"]', 'button:has-text("Einverstanden")',
    // Didomi
    'button#didomi-notice-agree-button', '.didomi-continue-with-recommended',
    // Borlabs
    'a#BorlabsCookieBoxIAB-ButtonAcceptAll',
    // generisch
    'button[aria-label*="accept" i]', 'button[aria-label*="akzept" i]',
  ];

  const tryAllFrames = async () => {
    const frames = page.frames();
    for (const frame of frames) {
      for (const sel of SELECTORS) {
        try {
          const el = await frame.locator(sel);
          if (await el.count()) {
            await el.first().click({ timeout: ACTION_TIMEOUT });
            await page.waitForTimeout(500);
            return true;
          }
        } catch {}
      }
      for (const t of BUTTON_TEXTS) {
        try {
          const btn = frame.getByRole('button', { name: new RegExp(`^\\s*${t}\\s*$`, 'i') });
          if (await btn.count()) {
            await btn.first().click({ timeout: ACTION_TIMEOUT });
            await page.waitForTimeout(500);
            return true;
          }
        } catch {}
      }
    }
    return false;
  };

  for (let i = 0; i < 3; i++) {
    const clicked = await tryAllFrames();
    if (clicked) return true;
    await page.waitForTimeout(500);
  }
  await removeOffendingOverlays(page);
  return false;
}

async function withPage(run, { viewport, url, navTimeout, fullPage }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: viewport || VIEWPORT,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      deviceScaleFactor: viewport?.deviceScaleFactor || VIEWPORT.deviceScaleFactor,
      locale: 'de-DE',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout || NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await tryConsent(page).catch(() => {});
    await injectDomUtilities(page).catch(() => {});
    await autoScroll(page, 18, 1200, 250).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const result = await run(page, { fullPage: Boolean(fullPage) });

    await context.close();
    await browser.close();
    return result;
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}

// ---------- Routen ----------
app.post('/screenshot', async (req, res) => {
  try {
    const { url, viewport, timeoutMs, fullPage } = req.body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'bad_request', detail: "Missing/invalid 'url'." });
    }

    const buf = await withPage(
      async (page, { fullPage }) => page.screenshot({ type: 'png', fullPage: Boolean(fullPage) }),
      { viewport, url, navTimeout: timeoutMs, fullPage }
    );

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: 'screenshot_failed', detail: String(e && e.message ? e.message : e) });
  }
});

app.post('/content', async (req, res) => {
  try {
    const { url, viewport, timeoutMs } = req.body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'bad_request', detail: "Missing/invalid 'url'." });
    }

    const data = await withPage(
      async (page) => {
        const text = await page.evaluate(() => {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
          clone.querySelectorAll('[hidden], [aria-hidden="true"]').forEach((n) => n.remove());
          const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
          let acc = '';
          while (walker.nextNode()) {
            const t = walker.currentNode.nodeValue;
            if (t && t.trim()) acc += t.replace(/\u00A0/g, ' ') + '\n';
          }
          return acc;
        });

        const html = await page.content();
        return { html, text };
      },
      { viewport, url, navTimeout: timeoutMs, fullPage: false }
    );

    res.status(200).json({ data });
  } catch (e) {
    return res.status(500).json({ error: 'content_failed', detail: String(e && e.message ? e.message : e) });
  }
});

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.listen(PORT, () => {
  console.log(`NC Monitor service listening on :${PORT}`);
});
