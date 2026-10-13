
import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import { writeFile } from 'node:fs/promises';

const URL = 'https://magicscraper.app/demo/catalogue';
const SCREENSHOT_PATH = 'catalogue-products.png';
const SCALE = 2;

// Group nearby OCR words into horizontal lines
function groupIntoLines(words) {
  const rows = [];

  const sorted = [...words].sort(
    (a, b) => (a.y0 + a.y1) - (b.y0 + b.y1),
  );

  for (const word of sorted) {
    const centerY = (word.y0 + word.y1) / 2;

    let row = rows.find(
      row => Math.abs(row.y - centerY) <= 12,
    );

    if (!row) {
      row = { y: centerY, words: [] };
      rows.push(row);
    }

    row.words.push(word);
    row.y = row.words.reduce(
      (sum, w) => sum + (w.y0 + w.y1) / 2,
      0,
    ) / row.words.length;
  }

  return rows
    .sort((a, b) => a.y - b.y)
    .map(row =>
      row.words
        .sort((a, b) => a.x0 - b.x0)
        .map(word => word.text)
        .join(' ')
        .trim(),
    );
}

// Extract fields from the catalogue's known layout
function parseProduct(lines) {
  if (lines.length < 5) return null;

  const name = lines.slice(0, -4).join(' ');
  const [manufacturer, pricing, availability, sku] =
    lines.slice(-4);

  // The current price appears before any crossed-out price
  const priceMatch = pricing.match(/\$(\d+\.\d{2})/);

  // OCR sometimes drops the decimal point in ratings
  const ratingMatch = pricing.match(/(?:^|\s)([0-5])\.?(\d)\s*$/);
  const skuMatch = sku.match(/NW-\d{4}/i);

  if (!name || !manufacturer || !priceMatch ||
      !ratingMatch || !availability || !skuMatch) {
    return null;
  }

  return {
    name,
    manufacturer,
    price: Number(priceMatch[1]),
    rating: Number(`${ratingMatch[1]}.${ratingMatch[2]}`),
    availability,
    sku: skuMatch[0].toUpperCase(),
  };
}

// 1. Capture the product grid and its card boundaries
const browser = await chromium.launch();

let cardBoxes;

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: SCALE,
  });

  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const grid = page.locator('.grid:has(.product)').last();
  const productCards = grid.locator('.product');

  await productCards.first().waitFor({ state: 'visible' });

  await grid.screenshot({
    path: SCREENSHOT_PATH,
    scale: 'device',
    animations: 'disabled',
    style: `
      header,
      [role="banner"] {
        visibility: hidden !important;
      }
    `,
  });

  const gridBox = await grid.boundingBox();

  if (!gridBox) {
    throw new Error('Product grid not found');
  }

  cardBoxes = [];

  for (let i = 0; i < await productCards.count(); i++) {
    const box = await productCards.nth(i).boundingBox();

    if (!box) {
      throw new Error(`Product card ${i + 1} not found`);
    }

    // Convert viewport coordinates to screenshot coordinates
    cardBoxes.push({
      x0: box.x - gridBox.x,
      y0: box.y - gridBox.y,
      x1: box.x + box.width - gridBox.x,
      y1: box.y + box.height - gridBox.y,
    });
  }
} finally {
  await browser.close();
}

// 2. Recognize text and word positions
const worker = await createWorker('eng');

let words;

try {
  const { data } = await worker.recognize(
    SCREENSHOT_PATH,
    {},
    { blocks: true },
  );

  words = (data.blocks ?? []).flatMap(block =>
    block.paragraphs.flatMap(paragraph =>
      paragraph.lines.flatMap(line =>
        line.words.map(word => ({
          text: word.text.trim(),
          x0: word.bbox.x0 / SCALE,
          y0: word.bbox.y0 / SCALE,
          x1: word.bbox.x1 / SCALE,
          y1: word.bbox.y1 / SCALE,
        })),
      ),
    ),
  );
} finally {
  await worker.terminate();
}

// 3. Match OCR words to cards and extract product data
const products = cardBoxes
  .map(box => {
    const cardWords = words.filter(word => {
      const centerX = (word.x0 + word.x1) / 2;
      const centerY = (word.y0 + word.y1) / 2;

      return (
        centerX >= box.x0 &&
        centerX < box.x1 &&
        centerY >= box.y0 &&
        centerY < box.y1 &&
        word.y1 - word.y0 < 40
      );
    });

    const lines = groupIntoLines(cardWords);

    return parseProduct(lines);
  })
  .filter(Boolean);

// 4. Save the extracted products
await writeFile(
  'products.json',
  JSON.stringify(products, null, 2),
);

console.table(products);
