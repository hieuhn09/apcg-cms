# Central — `contentType` cho Daily Brief

**Ngày:** 20-08-26
**Repo:** `apcg-cms` (Central CMS) — HEAD tham chiếu `7e54b41`
**Complexity:** SIMPLE (một execute pass)
**Status:** ✅ CODE COMPLETE 20-08-26 — chưa migrate, chưa verify runtime (xem `dtw-web/process/general-plans/reports/brief-display_REPORT_20-08-26.md`)
**Nghiên cứu:** `dtw-web/process/general-plans/references/brief-display-research_REFERENCE_20-08-26.md` (§P8, §P10)
**Thứ tự:** plan này phải deploy **TRƯỚC** `dtw-web/process/general-plans/active/brief-display_PLAN_20-08-26.md`

---

## Overview

content-engine sắp đăng Daily Brief (2 bài/ngày) cho tenant `dtw` qua `/api/engine/intake` như một bài thường, đánh dấu bằng `contentType: "daily-brief"`. Central hiện **bỏ qua** field đó, nên brief sẽ lẫn vào mọi luồng tin của mọi site đọc từ Central.

Plan này làm Central biết lưu và biết lọc theo bản chất nội dung. Central **không** quyết định hiển thị — nó chỉ cung cấp nhãn và một tham số lọc tùy chọn; mỗi web tự chọn bề mặt nào lọc (đúng ranh giới hợp đồng `hop-dong-danh-dau-brief-cho-web_04-08-26.md` §4).

Không có thay đổi hành vi nào cho tenant đang chạy: tham số mới **vắng mặt = không lọc**.

---

## Touchpoints

| File | Thay đổi |
|---|---|
| `src/collections/Articles.ts` | thêm field `contentType` vào tab **"Engine contract"** (cạnh `origin`) |
| `src/migrations/2026MMDD_HHMMSS_add_content_type.{ts,json}` | **MỚI** — generated + chèn tay backfill |
| `src/migrations/index.ts` | đăng ký migration mới |
| `src/payload-types.ts` | regenerate |
| `src/app/api/engine/intake/route.ts` | đọc + whitelist `body.contentType` |
| `src/app/api/public/articles/route.ts` | parse `content_type`, **một** `and.push` |
| `docs/08-content-engine-integration.md` | hợp đồng intake |
| `docs/09-website-integration.md` | hợp đồng public API |
| `scripts/seed.ts` (hoặc chỉnh tay trong `/admin`) | Author desk cho tenant `dtw` |

**Không đụng:** `src/app/api/public/articles/[slug]/route.ts` (trang brief phải mở được), `scopedFind`, access control, bất kỳ collection nào khác.

## Blast radius

- **DB:** 1 enum type mới + 1 cột trên `articles` + 1 cột trên `_articles_v`. Không đụng bảng nào khác.
- **Runtime:** tham số mới optional ⇒ gcv (đang production trên Central) và mọi caller hiện tại **không đổi hành vi một chút nào**.
- **Rủi ro cao nhất:** viết filter sai chiều làm rỗng feed của gcv. Chặn bằng: tham số vắng mặt = no-op, và bước verify đếm `totalDocs` trước/sau (§Verification).

---

## Contract (normative)

### Field `contentType`

```ts
{
  name: "contentType",
  type: "select",
  required: true,
  defaultValue: "article",
  // KHÔNG localized — một bài chỉ có một bản chất, không phụ thuộc ngôn ngữ.
  options: [
    { label: "Article", value: "article" },
    { label: "Daily brief", value: "daily-brief" },
  ],
  admin: {
    readOnly: true,
    description: "Bản chất nội dung. Engine đặt; 'daily-brief' = bản điểm tin máy soạn, không phải bài tin.",
  },
}
```

`required: true` + `defaultValue` là cố ý: Postgres `ADD COLUMN … NOT NULL DEFAULT 'article'` điền sẵn mọi hàng cũ trong một câu lệnh, nên cột **không bao giờ NULL** và filter không dính bẫy `NULL != 'x'` mà hợp đồng cảnh báo.

⚠️ Đã có một field tên `briefs` trên Articles (`Articles.ts:110-118`, khối số liệu label/value/source của bài, **không liên quan**). Đừng đổi tên, đừng đụng vào.

### Intake

```ts
const CONTENT_TYPES = ["article", "daily-brief"] as const;
const contentType =
  isNonEmptyString(body.contentType) && CONTENT_TYPES.includes(body.contentType.trim() as never)
    ? (body.contentType.trim() as (typeof CONTENT_TYPES)[number])
    : "article";
```

Whitelist, không phải pass-through: giá trị lạ → `"article"` (fail-safe về phía "bài thường"), không 400 — engine gửi field lạ không được phép làm hỏng đường đăng bài đang phục vụ 5 ấn phẩm.

Ghi vào `data.contentType` ở **cả nhánh create lẫn update**.

### Public API — tham số `content_type`

Trên `GET /api/public/articles`:

| Giá trị | Hành vi |
|---|---|
| vắng mặt | **không lọc** — giữ nguyên hành vi hiện tại |
| `article` | chỉ bài thường |
| `daily-brief` | chỉ brief |
| giá trị khác | bỏ qua như vắng mặt (không 400) |

```ts
const contentType = url.searchParams.get("content_type");
if (contentType === "article" || contentType === "daily-brief") {
  and.push({ contentType: { equals: contentType } });
}
```

Đặt **cùng chỗ với các filter khác**, trước `scopedFind`. Route dựng đúng một mảng `and` và kết thúc bằng đúng một `scopedFind`, nên một dòng này phủ mọi chế độ: `ids`, `q`, `flag`, `pillar`, `subsection`, `tag`, `author`, `country`, `after_*`, và **`view=refs`**.

⚠️ **Dùng `equals`, không dùng `not_equals`.** Khớp dương an toàn tuyệt đối; `not_equals` phụ thuộc hành vi null của phiên bản Payload đang dùng.

⚠️ **Không tự động lọc chế độ `ids`.** `ids` là đường phân giải theo id cho rail Saved/History của tài khoản người đọc — ai đã lưu một bản brief thì phải thấy lại nó. Caller nào muốn lọc thì tự truyền `content_type`; route không suy diễn.

### Author desk (tenant `dtw`)

`resolveOrCreateAuthor` (`intake/route.ts:476-486`) tìm theo `name` trước rồi mới tạo với `role: "Staff Writer"`. Seed sẵn một hàng để nó nối vào thay vì tạo mới:

```
tenant: dtw · name: "DTW Briefing Desk" · role: "Dailytechwire Newsroom" · city: "Singapore"
```

Không phải sửa code intake. Sửa lại `role` bất cứ lúc nào trong `/admin`, không cần deploy.

---

## Steps

1. **Field** — thêm `contentType` vào tab "Engine contract" của `src/collections/Articles.ts`, ngay trước `origin`.
2. **Migration** — `pnpm payload:migrate:create add_content_type`. Mở file `.ts` sinh ra, xác nhận có đủ **hai** cột: `articles.content_type` và `_articles_v.version_content_type` (bảng version tồn tại vì `versions: { drafts: true }`, `Articles.ts:51`). Nếu Payload để cột version nullable thì chèn thêm:
   ```sql
   UPDATE "_articles_v" SET "version_content_type" = 'article' WHERE "version_content_type" IS NULL;
   ```
   Kiểm `down()` có `DROP COLUMN` cả hai và `DROP TYPE` enum.
3. **index.ts** — thêm entry (Payload thường tự làm; xác nhận).
4. **Types** — `pnpm payload:generate-types`.
5. **Intake** — parse + whitelist theo §Contract, ghi ở cả create và update.
6. **Public API** — parse + một `and.push` theo §Contract.
7. **Author desk** — seed hàng cho tenant `dtw` (script hoặc tạo tay trong `/admin`; tạo tay là đủ, không cần deploy).
8. **Docs** — `docs/08-content-engine-integration.md` (thêm `contentType` vào bảng field intake) + `docs/09-website-integration.md` (thêm `content_type` vào danh sách query param, kèm cảnh báo `ids` không tự lọc).

---

## Verification

Chạy trên **local + dữ liệu thật đã pull** trước khi deploy. `T` = tổng bài published của tenant khi chưa có brief nào.

| # | Lệnh / thao tác | Kỳ vọng |
|---|---|---|
| 1 | `pnpm typecheck` | sạch |
| 2 | `pnpm payload:migrate` trên bản copy DB thật | chạy xong, không lỗi |
| 3 | `SELECT count(*) FROM articles WHERE content_type IS NULL;` | **0** |
| 4 | `SELECT content_type, count(*) FROM articles GROUP BY 1;` | chỉ có `article`, đúng bằng tổng số hàng |
| 5 | `GET /api/public/articles?limit=1` | `totalDocs` = **T** (không đổi so với trước migration) |
| 6 | `GET /api/public/articles?content_type=article&limit=1` | `totalDocs` = **T** |
| 7 | `GET /api/public/articles?content_type=daily-brief&limit=1` | `totalDocs` = **0**, `docs: []` |
| 8 | `GET /api/public/articles?content_type=bogus&limit=1` | `totalDocs` = **T** (bỏ qua như vắng mặt) |
| 9 | `GET /api/public/articles?view=refs&content_type=article&limit=1000` | không lỗi, đếm khớp |
| 10 | POST intake một bài giả có `"contentType":"daily-brief"` | tạo được; `/admin` hiện "Daily brief"; **(5) vẫn = T; (7) = 1** |
| 11 | Lặp lại (10) với byline `DTW Briefing Desk` | **không** sinh Author mới; nối vào hàng đã seed; `role` vẫn là "Dailytechwire Newsroom" |
| 12 | POST intake một bài giả **không** có `contentType` | lưu thành `article` |
| 13 | POST intake với `"contentType":"rác"` | lưu thành `article`, **không** 400 |
| 14 | `GET /api/public/articles/<slug-brief>` | **200** — trang bài brief vẫn mở được |
| 15 | `GET /api/public/articles?ids=<id-brief>` | trả về bài brief (không tự lọc) |

Bước **5** và **6** là bước quan trọng nhất: nếu `totalDocs` tụt xuống gần 0 thì đã viết filter ngược chiều — dừng, đừng deploy.

## Rollback

- Sự cố ở tầng đọc: bên gọi bỏ tham số `content_type` là quay lại hành vi cũ ngay, không cần deploy.
- Sự cố ở schema: `payload migrate:down` một bước (đã kiểm `down()` ở Step 2).
- Cột thừa không gây hại: mọi hàng đều `'article'`, mọi caller cũ không đọc tới.

## Ngoài phạm vi

- Không sửa `/api/public/articles/[slug]`.
- Không thêm surface hiển thị nào — đó là việc của từng web.
- Không đụng chính sách công bố AI / disclosure (chủ dự án đã chốt bỏ qua — xem §P10 của doc nghiên cứu).
