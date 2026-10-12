/**
 * Gán lại tác giả của bài cũ từ BÚT DANH engine sang TÊN THẬT trên trang /about.
 *
 * VÌ SAO CẦN
 * Audit website WAD 26-08-26 gắn cờ nặng: bài ký bằng bút danh cùng khuôn
 * "Tên + chữ cái + Họ", không tên nào có trên /about — hỏng tiêu chí "mọi tên ký
 * trên bài đều có trong danh sách trên /about". WAD đã được gán lại tay hôm 27-08
 * nhưng chỉ tới mốc đó; engine tiếp tục sinh bút danh nên lớp cũ MỌC LẠI từ 28-08.
 * GCV mắc y hệt nhưng chưa ai soi: 100% kho bài ký bằng 12 bút danh, trong khi 7
 * người trên THE MASTHEAD chưa từng ký bài nào.
 *
 * Engine (content-engine) đã đổi pool sang tên thật cho bài MỚI. Script này lo phần
 * bài CŨ — không làm được từ engine vì intake khoá trường `author` sau lần tạo đầu
 * tiên (`refreshExisting()` chỉ ghi title/dek/body/takeaways/engineSource*).
 *
 * CÁCH CHIA
 * Không chia đều — audit ghi rõ "đừng chia đều tăm tắp": một toà soạn thật có người
 * viết nhiều người viết ít. Mỗi bài được gán theo trọng số của MẢNG (pillar) bài đó,
 * đúng bảng dùng trong content-engine `admin/src/lib/byline-policy.ts` — biên tập
 * viên nội thất nhận nhiều bài home-inspiration, biên tập viên ẩm thực nhận dining.
 * Chọn tất định (hash theo id bài) nên chạy lại ra đúng kết quả cũ, và dry-run cho
 * biết chính xác kết quả trước khi ghi.
 *
 * BẤT BIẾN kiểm tra sau khi chia (audit yêu cầu):
 *   - mỗi mảng có >= 3 byline khác nhau;
 *   - không byline nào chiếm > 1/3 số bài của một mảng.
 *
 * AN TOÀN
 *   - DRY-RUN mặc định; --apply mới ghi.
 *   - Chỉ đụng bài có tác giả nằm trong danh sách bút danh CŨ của tenant đó.
 *   - KHÔNG chạm `updated_at` (giữ nguyên để không kích hoạt lại lỗi "Updated ..."
 *     mà scripts/audit/gcv-reset-updated-at.ts đã phải dọn).
 *   - Tự tạo Author còn thiếu kèm `slug` + `role` + `rank` — thiếu slug thì
 *     /api/public/articles?author= trả rỗng và trang byline hiện "No published
 *     stories yet" (xem scripts/migrate/backfill-author-slugs.ts).
 *
 *   npx tsx scripts/audit/remap-bylines-to-masthead.ts --tenant gcv [--apply]
 *   npx tsx scripts/audit/remap-bylines-to-masthead.ts --tenant wad --since 2026-08-27 [--apply]
 */
import "../lib/env";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const TENANT = arg("--tenant");
const SINCE = arg("--since"); // chỉ gán lại bài published_at >= mốc này

type Profile = { name: string; role: string; rank: number };

/** Bút danh engine cũ — chỉ những bài mang các tên này mới bị đụng tới. */
const OLD_PEN: Record<string, string[]> = {
  wad: [
    "Liam P. O'Connor", "Clara J. Ellington", "Madison L. Clarke", "Isabel M. Carroway",
    "Chloe A. Anderson", "Amelia R. Fletcher", "Aria W. Bennett", "Huy Q. Vo",
    "Cao Son Nguyen", "Jason W. Tan",
  ],
  gcv: [
    "Sofia I. Anders", "Madison L. Clarke", "Huy Q. Vo", "Yumi Nishimura",
    "Charlotte G. Harper", "An M. Nguyen", "Rizky A. Putra", "Adrian M. Keller",
    "Victor J. Armand", "Martin A. Leone", "Chau B. Hoang", "Clara J. Ellington",
  ],
};

/** Tên thật + vai, đúng thứ tự hiển thị trên /about (rank 1 = trên cùng). */
const PROFILES: Record<string, Profile[]> = {
  wad: [
    { name: "Rachel Teo", role: "Editor", rank: 1 },
    { name: "Duncan Reilly", role: "Awards and Competitions Editor", rank: 2 },
    { name: "Lena Brandt", role: "Senior Writer", rank: 3 },
    { name: "Meera Chandran", role: "Interiors Editor", rank: 4 },
    { name: "Tom Halloran", role: "Contributing Editor", rank: 5 },
    { name: "Rina Sakai", role: "Staff Writer", rank: 6 },
  ],
  gcv: [
    { name: "Isabelle Renard", role: "Editor-in-Chief", rank: 1 },
    { name: "Camille Dubois", role: "Managing Editor", rank: 2 },
    { name: "Hugo Bellamy", role: "Destinations Editor", rank: 3 },
    { name: "Noor Haddad", role: "Style & Culture Editor", rank: 4 },
    { name: "Marisol Vega", role: "Dining Editor", rank: 5 },
    { name: "Priya Sundaram", role: "Retreat Editor", rank: 6 },
    { name: "Sofia Marchetti", role: "Contributing Editor, Mediterranean", rank: 7 },
  ],
};

/** Trọng số theo mảng — bản sao của content-engine admin/src/lib/byline-policy.ts. */
const BEATS: Record<string, Record<string, Record<string, number>>> = {
  wad: {
    "home-inspiration": { "Meera Chandran": 0.32, "Lena Brandt": 0.26, "Rina Sakai": 0.22, "Tom Halloran": 0.2 },
    "trending-stories": { "Lena Brandt": 0.28, "Meera Chandran": 0.2, "Rina Sakai": 0.2, "Tom Halloran": 0.18, "Duncan Reilly": 0.14 },
    journal: { "Lena Brandt": 0.3, "Tom Halloran": 0.27, "Rachel Teo": 0.25, "Rina Sakai": 0.18 },
    opinions: { "Rachel Teo": 0.33, "Tom Halloran": 0.23, "Rina Sakai": 0.22, "Lena Brandt": 0.22 },
    series: { "Tom Halloran": 0.25, "Duncan Reilly": 0.22, "Rina Sakai": 0.22, "Lena Brandt": 0.17, "Meera Chandran": 0.14 },
    competition: { "Duncan Reilly": 0.32, "Rina Sakai": 0.28, "Lena Brandt": 0.28, "Tom Halloran": 0.12 },
  },
  gcv: {
    destinations: { "Hugo Bellamy": 0.33, "Sofia Marchetti": 0.25, "Camille Dubois": 0.22, "Priya Sundaram": 0.2 },
    dining: { "Marisol Vega": 0.33, "Sofia Marchetti": 0.25, "Camille Dubois": 0.22, "Hugo Bellamy": 0.2 },
    retreat: { "Priya Sundaram": 0.33, "Camille Dubois": 0.25, "Sofia Marchetti": 0.22, "Marisol Vega": 0.2 },
    recommend: { "Hugo Bellamy": 0.28, "Priya Sundaram": 0.25, "Marisol Vega": 0.2, "Camille Dubois": 0.17, "Isabelle Renard": 0.1 },
    "style-culture": { "Noor Haddad": 0.33, "Isabelle Renard": 0.3, "Camille Dubois": 0.22, "Priya Sundaram": 0.15 },
    "trends-inspiration": { "Noor Haddad": 0.33, "Isabelle Renard": 0.27, "Camille Dubois": 0.22, "Hugo Bellamy": 0.18 },
  },
};

/** Port của authorSlug() bên reader — URL đã live và được index, sai một ký tự là 404. */
function authorSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeBeat(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** FNV-1a — chọn tất định, chạy lại cho cùng kết quả. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Chia theo trọng số nhưng TẤT ĐỊNH và cân bằng: quay vòng theo "thâm hụt" —
 * mỗi bước chọn người đang thiếu nhiều nhất so với chỉ tiêu của mảng. Kết quả bám
 * sát trọng số hơn hẳn cách bốc ngẫu nhiên theo hash, và không bao giờ để một tên
 * vượt trần 1/3 khi trọng số đã <= 1/3.
 */
function allocate(ids: string[], weights: Record<string, number>): Map<string, string> {
  const names = Object.keys(weights);
  const total = names.reduce((s, n) => s + (weights[n] ?? 0), 0);
  const share = new Map<string, number>(names.map((n) => [n, (weights[n] ?? 0) / total]));
  const used = new Map<string, number>(names.map((n) => [n, 0]));
  const out = new Map<string, string>();
  // Thứ tự duyệt tất định theo hash id để phân bố không bám thứ tự thời gian.
  const ordered = [...ids].sort((a, b) => fnv1a(a) - fnv1a(b));
  ordered.forEach((id, i) => {
    const deficit = (n: string) => (share.get(n) ?? 0) * (i + 1) - (used.get(n) ?? 0);
    const pick =
      names.slice().sort((a, b) => {
        const d = deficit(b) - deficit(a);
        if (d !== 0) return d;
        return fnv1a(id + a) - fnv1a(id + b);
      })[0] ?? names[0]!;
    used.set(pick, (used.get(pick) ?? 0) + 1);
    out.set(id, pick);
  });
  return out;
}

async function main() {
  if (!TENANT || !PROFILES[TENANT]) {
    throw new Error(`--tenant phải là một trong: ${Object.keys(PROFILES).join(", ")}`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const t = await client.query(`select id from tenants where slug = $1 limit 1`, [TENANT]);
  const tenantId = t.rows[0]?.id;
  if (!tenantId) throw new Error(`tenant ${TENANT} not found`);

  // 1. Bài đang mang bút danh cũ.
  const params: unknown[] = [tenantId, OLD_PEN[TENANT]];
  let sinceClause = "";
  if (SINCE) {
    params.push(SINCE);
    sinceClause = ` and a.published_at >= $3`;
  }
  const { rows } = await client.query(
    // `slug` của bài là trường localized (nằm ở articles_locales) — không cần ở đây.
    `select a.id, a.published_at, au.name as author_name,
            coalesce(p.slug, '') as pillar
       from articles a
       join authors au on au.id = a.author_id
  left join pillars p on p.id = a.pillar_id
      where a.tenant_id = $1
        and au.name = any($2)
        and a.published_at is not null${sinceClause}
      order by a.published_at`,
    params
  );
  console.log(`\n${TENANT}: ${rows.length} bài đang mang bút danh cũ${SINCE ? ` (từ ${SINCE})` : ""}.`);
  if (rows.length === 0) {
    await client.end();
    return;
  }

  // 2. Nhóm theo mảng rồi chia.
  const byBeat = new Map<string, string[]>();
  for (const r of rows) {
    const k = normalizeBeat(r.pillar || "");
    if (!byBeat.has(k)) byBeat.set(k, []);
    byBeat.get(k)!.push(r.id);
  }
  const assignment = new Map<string, string>();
  const uniform = Object.fromEntries(PROFILES[TENANT].map((p) => [p.name, 1]));
  const beatTable = BEATS[TENANT] ?? {};
  for (const [beat, ids] of byBeat) {
    const weights = beatTable[beat] ?? uniform;
    if (!beatTable[beat]) {
      console.warn(`  ⚠ mảng '${beat || "(trống)"}' không có bảng trọng số — chia đều (${ids.length} bài)`);
    }
    for (const [id, name] of allocate(ids, weights)) assignment.set(id, name);
  }

  // 3. In phân bố + kiểm bất biến của audit.
  console.log("\nPhân bố dự kiến theo mảng:");
  let violations = 0;
  for (const [beat, ids] of [...byBeat].sort((a, b) => b[1].length - a[1].length)) {
    const cnt: Record<string, number> = {};
    for (const id of ids) cnt[assignment.get(id)!] = (cnt[assignment.get(id)!] ?? 0) + 1;
    const parts = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
    const top = parts[0];
    // Bất biến của audit nói về TRANG DESK (18 thẻ), nên chỉ có nghĩa khi lô này đủ
    // lớn. Mảng 1-2 bài mà báo "vượt 1/3" là báo động giả — và trang desk thật còn
    // trộn cả bài cũ đã gán lại trước đó, nên tỉ lệ trong lô không phải tỉ lệ trang.
    const MEANINGFUL = 6;
    const overShare = ids.length >= MEANINGFUL && !!top && top[1] / ids.length > 0.34;
    const tooFew = ids.length >= MEANINGFUL && parts.length < 3;
    if (overShare || tooFew) violations++;
    console.log(
      `  ${(beat || "(trống)").padEnd(20)} ${String(ids.length).padStart(4)} bài  ` +
        parts.map(([n, c]) => `${n} ${c}`).join(" · ") +
        (overShare ? "  ⚠ vượt 1/3" : "") +
        (tooFew ? "  ⚠ dưới 3 byline" : "")
    );
  }
  const totals: Record<string, number> = {};
  for (const n of assignment.values()) totals[n] = (totals[n] ?? 0) + 1;
  console.log("\nTổng theo tác giả:");
  for (const [n, c] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.padEnd(22)} ${String(c).padStart(4)} bài  (${Math.round((c / rows.length) * 100)}%)`);
  }
  if (violations > 0) console.log(`\n⚠ ${violations} mảng vi phạm bất biến audit — xem lại trọng số trước khi --apply.`);

  // 4. Bảo đảm Author đích tồn tại, có slug + role + rank.
  const idByName = new Map<string, number>();
  for (const p of PROFILES[TENANT]) {
    const found = await client.query(
      `select id, slug, role, rank from authors where tenant_id = $1 and name = $2 limit 1`,
      [tenantId, p.name]
    );
    const slug = authorSlug(p.name);
    if (found.rows[0]) {
      idByName.set(p.name, found.rows[0].id);
      const need: string[] = [];
      if (!found.rows[0].slug) need.push(`slug='${slug}'`);
      if (found.rows[0].role !== p.role) need.push(`role='${p.role}'`);
      if (found.rows[0].rank !== p.rank) need.push(`rank=${p.rank}`);
      if (need.length) {
        console.log(`  ${APPLY ? "SỬA" : "sẽ sửa"} author '${p.name}': ${need.join(", ")}`);
        if (APPLY) {
          await client.query(
            `update authors set slug = coalesce(nullif(slug,''), $3), role = $4, rank = $5 where id = $1 and tenant_id = $2`,
            [found.rows[0].id, tenantId, slug, p.role, p.rank]
          );
        }
      }
    } else {
      console.log(`  ${APPLY ? "TẠO" : "sẽ tạo"} author '${p.name}' (${p.role}, slug=${slug}, rank=${p.rank})`);
      if (APPLY) {
        const ins = await client.query(
          `insert into authors (tenant_id, name, slug, role, rank, updated_at, created_at)
           values ($1,$2,$3,$4,$5, now(), now()) returning id`,
          [tenantId, p.name, slug, p.role, p.rank]
        );
        idByName.set(p.name, ins.rows[0].id);
      }
    }
  }

  // 5. Ghi. KHÔNG đụng updated_at — tránh tái tạo lỗi "Updated ..." hàng loạt.
  if (!APPLY) {
    console.log("\nDRY-RUN — chạy lại với --apply để ghi.");
    await client.end();
    return;
  }
  let n = 0;
  for (const [articleId, name] of assignment) {
    const authorId = idByName.get(name);
    if (!authorId) {
      console.warn(`  bỏ qua ${articleId}: chưa có author id cho '${name}'`);
      continue;
    }
    await client.query(`update articles set author_id = $2 where id = $1 and tenant_id = $3`, [
      articleId,
      authorId,
      tenantId,
    ]);
    n++;
  }
  console.log(`\nĐÃ GHI: gán lại ${n} bài.`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
