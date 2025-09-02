/* eslint-disable no-console */
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import LRU from 'lru-cache';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// For resolving paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve your index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Simple API key gate (optional)
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next(); // disabled
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
});

// Basic rate limit
const limiter = rateLimit({ windowMs: 60_000, max: 10 });
app.use('/api/', limiter);

// Cache to avoid hammering Pinterest
const cache = new LRU({ max: 200, ttl: 1000 * 60 * 30 }); // 30 min TTL

// Helper: compute simple difficulty score (0-100)
function computeKD(pins, loadedCount) {
  const top = pins.slice(0, 20);
  const avgSaves = top.length
    ? top.reduce((s, p) => s + (p.saves || 0), 0) / top.length
    : 0;
  const pop = Math.min(1, avgSaves / 500);
  const comp = Math.min(1, loadedCount / 1000);
  return Math.round((0.6 * comp + 0.4 * pop) * 100);
}

// Launch one shared browser for efficiency
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function pinterestSearch({ query, scrolls = 3, login = false }) {
  const cacheKey = `${query}|${scrolls}|${login}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    if (login && process.env.PIN_EMAIL && process.env.PIN_PASSWORD) {
      await page.goto('https://www.pinterest.com/login/', { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="id"]', process.env.PIN_EMAIL);
      await page.fill('input[name="password"]', process.env.PIN_PASSWORD);
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForLoadState('networkidle')
      ]);
    }

    const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Scroll to load more pins
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    }

    const pins = await page.evaluate(() => {
      const results = [];
      const pinAnchors = Array.from(document.querySelectorAll('a[href^="/pin/"]'));
      const seen = new Set();

      pinAnchors.forEach(a => {
        const href = a.getAttribute('href');
        if (!href || seen.has(href)) return;
        seen.add(href);

        const card = a.closest('[data-test-id]') || a.parentElement;
        const img = a.querySelector('img');
        const titleEl = card?.querySelector('div[title], img[alt]');
        const savesEl = card?.querySelector('span[aria-label*="save" i], div:has(svg[aria-label*="save" i])');

        let saves = 0;
        if (savesEl) {
          const t = savesEl.textContent || '';
          const m = t.match(/([\d.,]+)\s*saves?/i);
          if (m) {
            const num = m[1].replace(/[.,]/g, '');
            saves = parseInt(num, 10) || 0;
          }
        }

        results.push({
          pinId: href.replace('/pin/', '').replace(/\/$/, ''),
          url: `https://www.pinterest.com${href}`,
          image: img?.src || '',
          title: (titleEl?.getAttribute('title') || img?.alt || '').trim(),
          saves
        });
      });
      return results;
    });

    const uniquePins = pins.filter((p, i, arr) => arr.findIndex(x => x.pinId === p.pinId) === i);
    const kd = computeKD(uniquePins, uniquePins.length);

    const out = {
      query,
      loadedPins: uniquePins.length,
      keywordDifficulty: kd,
      lowCompetition: kd <= 35,
      sample: uniquePins.slice(0, 50)
    };

    cache.set(cacheKey, out);
    return out;
  } finally {
    await page.close();
    await context.close();
  }
}

app.get('/api/pinterest', async (req, res) => {
  try {
    const query = (req.query.q || '').toString().trim();
    if (!query) return res.status(400).json({ error: 'Missing q' });

    const scrolls = Math.min(10, Math.max(1, parseInt(req.query.scrolls?.toString() || '3', 10)));
    const login = req.query.login === '1';

    const data = await pinterestSearch({ query, scrolls, login });

    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

