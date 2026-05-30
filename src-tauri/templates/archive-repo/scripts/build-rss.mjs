#!/usr/bin/env node
// Generates dist/feed.xml from index.json after the Astro build.

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const indexPath = path.join(root, "index.json");
const outPath = path.join(root, "dist", "feed.xml");

if (!fs.existsSync(indexPath)) {
  console.warn("[rss] index.json not found, skipping feed");
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const items = Object.values(data.articles ?? {})
  .sort((a, b) => b.create_time - a.create_time)
  .slice(0, 100);

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>微信公众号归档</title>
  <link>https://example.github.io</link>
  <description>由 wxmp-cracker 自动同步</description>
  <language>zh-CN</language>
  ${items
    .map(
      (a) => `<item>
    <title>${esc(a.title)}</title>
    <link>${esc(a.link)}</link>
    <pubDate>${new Date(a.create_time * 1000).toUTCString()}</pubDate>
    <author>${esc(a.nickname)}</author>
    <guid isPermaLink="false">${esc(a.aid)}</guid>
    ${a.digest ? `<description>${esc(a.digest)}</description>` : ""}
  </item>`
    )
    .join("\n  ")}
</channel>
</rss>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, xml);
console.log(`[rss] wrote ${items.length} items to ${outPath}`);
