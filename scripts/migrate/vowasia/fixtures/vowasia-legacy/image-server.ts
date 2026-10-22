/**
 * Local FAKE image host for the snapshot download tests (chặng B-α).
 * Listens on 127.0.0.1:<random port>; the tests reach it through
 * `media.hostRewrite` {"img.example.invalid": "127.0.0.1:<port>"} in explicit
 * rehearsal mode, exactly like the GTP fixture. Never a real host.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const PNG2 = Buffer.concat([PNG, Buffer.from([1, 2, 3])]);
export const OVER_20_MB = 20 * 1024 * 1024 + 1;

export interface ImageServer {
  port: number;
  hits: string[];
  close(): Promise<void>;
}

export async function startImageServer(): Promise<ImageServer> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const p = (req.url ?? "/").replace(/^\/storage\/v1\/object\/public\/media/, "");
    hits.push(p);
    const send = (type: string, body: Buffer | string) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    switch (p) {
      case "/ok.jpg":
      case "/dup.jpg":
        return send("image/jpeg", JPEG);
      case "/ok2.png":
        return send("image/png", PNG);
      case "/nested/deep.png":
        return send("image/png", PNG2);
      case "/svg.svg":
        return send("image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>");
      case "/bad.jpg":
        return send("image/jpeg", "<html>not an image</html>");
      case "/big.jpg": {
        // streamed without content-length: the running byte count must abort it
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.write(JPEG);
        const chunk = Buffer.alloc(1024 * 1024);
        let sent = JPEG.length;
        const pump = () => {
          while (sent < OVER_20_MB) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        res.on("error", () => {});
        return pump();
      }
      case "/redir-off.jpg":
        res.writeHead(302, { location: "https://other.example.invalid/x.jpg" });
        return res.end();
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
