/**
 * Fixed-port FAKE image host of the rehearsal (127.0.0.1:3519). Every path under
 * /storage/v1/object/public/media/ answers a small REAL image generated with
 * sharp (deterministic per path; `.png` paths answer PNG), so Payload's image
 * pipeline (resizes) works on it. Never a real host. Started by rehearse-vowasia.sh.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import sharp from "sharp";

const PORT = 3519;
const cache = new Map<string, { type: string; body: Buffer }>();

async function image(p: string): Promise<{ type: string; body: Buffer }> {
  const hit = cache.get(p);
  if (hit) return hit;
  const h = createHash("sha256").update(p).digest();
  const s = sharp({ create: { width: 48, height: 32, channels: 3, background: { r: h[0] as number, g: h[1] as number, b: h[2] as number } } });
  const png = /\.png$/i.test(p);
  const out = { type: png ? "image/png" : "image/jpeg", body: png ? await s.png().toBuffer() : await s.jpeg().toBuffer() };
  cache.set(p, out);
  return out;
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (!url.startsWith("/storage/v1/object/public/media/")) {
    res.writeHead(404);
    res.end();
    return;
  }
  image(url).then(
    (img) => {
      res.writeHead(200, { "content-type": img.type, "content-length": String(img.body.length) });
      res.end(img.body);
    },
    () => {
      res.writeHead(500);
      res.end();
    },
  );
});
server.listen(PORT, "127.0.0.1", () => console.log(`[images] fake image host on 127.0.0.1:${PORT}`));
