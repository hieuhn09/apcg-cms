---
name: plan:vowasia-legacy-migration
description: "Chuyển bài viết VowAsia từ DB Postgres cũ (dùng chung với GTP) sang Central tenant vowasia: tooling bản riêng, chia Giai đoạn A (đọc/discover, làm ngay) và B (import, sau discover)"
date: 16-10-26
feature: vowasia-launch (lưu ở general-plans; repo này không có process/features)
---

# VowAsia legacy migration — PLAN (COMPLEX, 2 giai đoạn)

Date: 16-10-26
Status: PLANNED (chưa EXECUTE). PVL cycle 1 (S1-S8) và cycle 2 (T1-T7, 16-10-26) đã áp dụng vào thân plan; `## Validate Contract` bên dưới là bản vòng 2 (CONDITIONAL) và LỖI THỜI ở các chỗ nêu số file/gap, validate-agent sẽ ghi lại ở vòng sau.

## TL;DR

- **Khuyến nghị: chỉ ENTER EXECUTE MODE cho Giai đoạn A.** B chỉ được thực thi sau khi chủ chạy discover, đưa báo cáo, và chốt các quyết định còn mở (C3, C8, C10, host ảnh/R2, A1).
- Giai đoạn A (không cần biết schema VowAsia): tooling đọc/discover **bản riêng** trong `scripts/migrate/vowasia/` (cấu hình bằng overlay, không hard-code tên bảng/cột/kiểu site id), sửa lỗi keyset (chỉ ở bản vowasia), SQL mẫu do chủ chạy (kiểm tra RLS, tạo role chỉ-đọc `vowasia_migrator` bằng schema/view riêng, xoá role), test, lint, probe Postgres 16 cục bộ, hướng dẫn chủ. Chỉ thêm file mới + 3 dòng script vào `package.json`. **Không file GTP nào đổi một byte.**
- Giai đoạn B (mapping, transform, importer, rollback, verify, redirect/410, rehearsal, runbook): chỉ phác thảo; thiết kế để NHẬN quyết định chưa chốt qua cấu hình, không tự đặt.
- Rủi ro lớn nhất: bật RLS trên bảng dùng chung có thể làm hỏng các site cũ đang chạy. Khuyên **phương án 2** (schema riêng chứa view chỉ có dòng vowasia, không đụng bảng gốc); chủ quyết sau khi chạy SQL đọc.
- Lỗi keyset (cắt micro-giây) và `pages()` không khử trùng/không chốt chặn con trỏ **vẫn còn** ở main hiện tại (xác minh bên dưới); chỉ sửa ở bản vowasia, phần GTP ghi lại như gap để chủ quyết riêng.

Complexity: COMPLEX (2 giai đoạn, vùng tin cậy DB production, nhiều file). Cơ sở: `main` @ `fe88bc4`, nhánh `claude/vowasia-launch`.

---

## Overview: Goal và phạm vi (mục 1)

Goal: đưa **chỉ bài viết** của VowAsia từ DB cũ sang Central (tenant `vowasia`, DB `neondb`), an toàn, có rollback theo run-id, không chạm GTP, không giữ bí mật trong repo.

Trong phạm vi: bài viết (kèm ảnh tải về R2), link nội bộ, ngày đăng/ngày tạo, redirect/410, tác giả (chỉ gán, không tạo). Ngoài phạm vi (C9): dữ liệu cá nhân, người đăng ký, form liên hệ, mọi bảng không phải nội dung bài viết.

Không làm trong plan này: tạo tenant/taxonomy/token/engine record (chủ làm tay; xem Owner-Run), sửa content-engine, sửa web VowAsia.

## 2. Owner Decisions

### ĐÃ CHỐT (chủ chấp nhận gợi ý 16-10-26, ghi nguyên)

| Mã | Quyết định |
|---|---|
| B3 | Làm **bản riêng** cho vowasia: không tham số hoá chung, không đổi hành vi GTP, không đụng file GTP. |
| B4 | Lỗi keyset chỉ sửa ở bản vowasia (test micro-giây, khử trùng theo khoá, chốt chặn con trỏ không tiến). Phần GTP: chủ quyết riêng; plan chỉ ghi gap. |
| C1 | Tác giả: chia đều cho 6 tác giả đã chốt (Serene Chia, Aarti Menon, Danish Iskandar, Hanna Pang, Yumi Nakagawa, Ishaan Bhatt; nguồn `scripts/lib/vowasia-taxonomy.ts`); gom bài liên quan theo quốc gia + quý, không theo pillar; KHÔNG dùng tên chung kiểu "VowAsia Editorial"; importer không tạo tác giả. Mô hình lấy từ `gtp-author-distribution.ts`. |
| C2 | published, archived giữ nguyên; draft nhập thành nháp; rejected bỏ; scheduled nhập thành nháp. Bài archived về mục hay 410: chốt cùng URL sau discover. |
| C4 | Tag: nhập có giới hạn, gom về 6 tag đã chốt, thêm tag mới chỉ khi thật cần. |
| C5 | SEO cũ: bỏ. |
| C6 | Ảnh: tải về R2, tối đa 20 MB/ảnh, **dừng** nếu ảnh hỏng > 2%, bài thiếu ảnh nhập thành nháp. |
| C7 | Bài thiếu ngày đăng: dùng ngày tạo. Ngày đăng và ngày tạo gốc khôi phục bằng SQL do chủ chạy. |
| C9 | Phạm vi CHỈ bài viết; dữ liệu cá nhân và người đăng ký bỏ. |

### CHƯA CHỐT (tooling phải nhận quyết định SAU discover qua cấu hình; plan không tự đặt)

| Mã | Nội dung | Cách tooling nhận |
|---|---|---|
| C3 | URL cũ: origin, mẫu đường dẫn, mục bị bỏ => 410 hay 301 (gợi ý: mục không còn thì 410, bài có chỗ mới thì 301) | Trường `urls.*` trong mapping B (`oldOrigin`, `articlePathTemplate`, `sectionPaths`, `gonePaths`, `extraLegacyPaths`), có cơ chế `_provisional` + `--require-final` như GTP. |
| C8 | Ánh xạ category cũ -> 8 pillar / 27 sub-section (cả real-weddings, directory, press-room; engine bị chặn khỏi 3 pillar này; press-room là single-home) | Bảng `taxonomy.rules` trong mapping B; mặc định rỗng (bài không khớp -> reject có báo cáo, KHÔNG gán đại). Discover A sinh phân bố category để chủ điền. |
| C10 | Mốc cutover, đã có web mới chưa | Chỉ ảnh hưởng thứ tự runbook B và việc bật redirect; không ảnh hưởng A. |
| A1 | Tenant `vowasia` đã tạo + taxonomy đã `--apply` trên production chưa (CHƯA BIẾT) | Điều kiện tiên quyết phải kiểm bằng lệnh ĐỌC do chủ chạy (O1), không giả định. |
| — | Host ảnh cũ và bucket R2 | Overlay (`media.hostAllowlist`, `media.hostRewrite`) giữ NGOÀI repo; discover thống kê host ảnh. |

### Mặc định đã chọn / cần chủ xác nhận (quyết định kỹ thuật/quy trình do plan đề xuất)

1. **O-Q1 (S7): MẶC ĐỊNH CHÉP RIÊNG** `args.ts` và `out-dir.ts` vào `scripts/migrate/vowasia/lib/` (~150 dòng, hai file trung tính, không có tên tenant) để không phụ thuộc file GTP, đúng B3. Không import từ `scripts/migrate/lib/`. Chủ có thể đổi sang import; khi đó thêm test chống drift (symbol tồn tại) vào checklist bước 6.
2. **O-Q2:** phương án role: 2 (schema+view) hay 1 (RLS). Đề xuất 2; chủ CHỐT SAU KHI chạy `01-readonly-inspect.sql`.
3. **O-Q3:** allow-list nguồn mặc định chỉ `articles` + `sites` (tối thiểu cần thiết, theo C9). Thêm bảng tác giả/ảnh cũ chỉ khi chủ yêu cầu (qua overlay).
4. (Đã bỏ khỏi danh sách hỏi, S1) Run-id/`--resume` đã là QUY TẮC CỦA CHỦ, nguyên văn: "Importer chỉ tạo mới, không sửa, không xoá, không bao giờ tạo tác giả. Rollback theo từng run. Lần chạy thứ hai dùng run-id mới, không dùng --resume cho run cũ." Mỗi lần `--apply` là run-id MỚI; không `--resume` run cũ.
5. **O-Q5:** `npm run rehearse:gtp` (~60 phút) KHÔNG bắt buộc sau Giai đoạn A, vì G8 + G7c chứng minh 0 byte GTP đổi và `rehearse-gtp.sh` chỉ dùng file GTP. Mặc định: chạy MỘT lần ở EVL cuối chương trình, sau Giai đoạn B. Chủ quyết (có thể yêu cầu chạy ngay sau A).

## 3. Hard Constraints và Hard Stops

Hard Constraints (không thương lượng):

1. Chủ chạy mọi lệnh GHI lên production và mọi lệnh ĐỌC DB cũ. Plan/agent không giữ, không xin bí mật. Không bảo chủ dán/chụp bí mật: dùng `read -s`; mật khẩu mới dùng `openssl rand -base64 24 | pbcopy`; nhắc `clear` trước khi chụp màn hình. `LEGACY_VOWASIA_DB_URL` chỉ đọc từ biến môi trường, không bao giờ qua argv.
2. Role chỉ-đọc RIÊNG `vowasia_migrator`; SELECT giới hạn theo site id vowasia trên từng bảng trong allow-list, kể cả dòng của bảng `sites`. KHÔNG dùng lại `gtp_migrator`, không đụng role/policy của gtp. Chủ xoá role/policy/view sau khi xong. Repo KHÔNG có SQL role thật của GTP, chỉ có fixture `scripts/migrate/fixtures/gtp-legacy/schema.sql` (~dòng 165-177); SQL mới viết từ đầu, không "bản sao của GTP".
3. Dry-run là mặc định. `--apply` cần terminal tương tác + `--confirm-host`. Banner phải in database `neondb` (dùng `scripts/lib/central-db-name-guard.ts` đã có, gọi SAU `assertLocalOrConfirmed`). Trước MỌI lệnh owner-run có `--apply`: in tên database (`new URL(DATABASE_URL).pathname` phải là `/neondb`).
4. Importer chỉ TẠO MỚI, không sửa, không xoá, không bao giờ tạo tác giả. Rollback theo từng run-id. **Mỗi lần `--apply` dùng run-id MỚI; KHÔNG dùng `--resume` cho run cũ** (quy tắc chủ, nguyên văn: "Lần chạy thứ hai dùng run-id mới, không dùng --resume cho run cũ"). Ghi thử 50 bài rồi ghi phần còn lại = hai run độc lập, run-id khác nhau.
5. Marker bài import của vowasia KHÁC marker GTP: `engineSourceName = "legacy:vowasia"`, không bao giờ chứa `globaltravelpost`.
6. Rehearsal trên dữ liệu tổng hợp: chạy MỘT lần, một mình, nền, timeout 7200000 (~60 phút); không chạy 2 rehearsal song song, không chạy `npm ci` song song. Native PG16 (docker daemon có thể không chạy; dùng cùng cách `rehearse-gtp.sh`: `REHEARSE_MODE=native`).
7. RIPER-5: EXECUTE = opus (1 agent tuần tự vì file gắn chặt), pha khác = sonnet; EVL do `vc-tester` chạy lại độc lập. Thay đổi ngoài phạm vi cần amendment + chữ "đồng ý" của chủ. Commit vào `claude/vowasia-launch`, `push -u`, PR NHÁP. Không in/commit token/secret; không đụng `~/gtp-private`.
8. Không tự đặt mặc định thuộc về chủ (bài học "GTP Newsroom"): không tên tác giả chung, không gán pillar đại, không tự chọn 301/410.
9. KHÔNG đổi hành vi GTP: mọi file GTP giữ nguyên byte, chứng minh bằng G4, G5, G2, G3, G7, G7b, G7c, G8 (diff theo pathspec + test GTP xanh). `rehearse:gtp` không bắt buộc sau A (O-Q5): chạy MỘT lần ở EVL cuối chương trình sau B, hoặc sớm hơn khi chủ yêu cầu.

Hard Stops (dừng, báo chủ, không tự xử lý):

- HS1: bất kỳ lệnh/mã nào sắp GHI vào DB cũ, hoặc chạy bất kỳ DDL nào trên DB cũ ngoài file SQL mẫu do chủ chạy. (DDL trên PG16 tạm cục bộ do chính probe dựng và dọn là được phép; đó không phải DB cũ.)
- HS2: cần sửa một file GTP hoặc file ngoài danh sách Touchpoints (ngoài 3 dòng `package.json`) => dừng, xin amendment.
- HS3: DB banner không phải `/neondb` ở lệnh Central có `--apply`; hoặc site row đọc ra có slug khác `vowasia`.
- HS4: phát hiện bí mật trong repo/log/báo cáo (kể cả tên bảng nhạy cảm của DB dùng chung) => dừng và xoá khỏi artefact trước khi tiếp.
- HS5: kết quả SQL đọc cho thấy phương án role đã chọn có thể ảnh hưởng site cũ (ví dụ cần bật RLS mà role của site cũ không bypass) => không chạy, chủ quyết lại.
- HS6: rehearsal/probe không dọn sạch tiến trình hoặc DB tạm của chính nó.
- HS7: Giai đoạn B bị yêu cầu thực thi khi chưa có discover report + các quyết định ở mục 2 cột CHƯA CHỐT.

## 4. Xác minh lại tooling hiện tại (đọc lại ở `fe88bc4`, KHÔNG dựa báo cáo cũ)

| Điểm | Còn ở main hiện tại? | Bằng chứng | Xử lý trong plan này |
|---|---|---|---|
| `IMPORT_TENANT = "gtp"` + `assertImportTenant` | Có | `scripts/migrate/lib/cli-common.ts:55-59` | Bản vowasia: hằng `vowasia`, không đọc `IMPORT_TENANT_SLUG` khác. |
| `assertGtpSite` (slug phải là `gtp`) | Có | `lib/legacy-reader.ts:~170`, gọi ở `cli-common.ts` `openLegacy` | Bản vowasia: `assertVowasiaSite` (slug cấu hình, mặc định `vowasia`). |
| Allow-list 9 bảng cứng + cột + khoá | Có | `lib/legacy-sql.ts` `ALLOWED_TABLES` | Bản vowasia: registry nạp từ overlay, mặc định `articles`,`sites`. |
| site id phải là UUID | Có | `lib/legacy-sql.ts` hằng `UUID` + `assertSafeQuery (c)`; `cli-spec.ts` `UUID` | Bản vowasia: `siteIdKind` = `uuid`/`integer`/`text-safe`, kiểm theo kiểu. |
| Marker `legacy:globaltravelpost` | Có, 4 nơi | `import-gtp-main.ts:61`, `verify-main.ts:32`, `rollback-main.ts:30`, `gtp-timestamps.ts:14` | Marker riêng `legacy:vowasia` (B), test khẳng định khác marker GTP. |
| Reserved slugs là route GTP | Có | `lib/slug-plan.ts` `DEFAULT_RESERVED_SLUGS` | B: danh sách reserved lấy từ route thật của web VowAsia (chưa biết) qua mapping. |
| Env `LEGACY_GTP_DB_URL` | Có | `db-banner.ts` | Bản riêng `LEGACY_VOWASIA_DB_URL`. |
| Lỗi keyset: `cursorOf` cắt micro-giây | **Còn** | `legacy-sql.ts` `cursorOf`: `c.toISOString()` (driver trả `Date`, mili-giây) | Sửa ở bản vowasia (con trỏ lấy từ `coalesce(created_at, epoch)::text` của chính DB). |
| `pages()` không khử trùng, không chốt chặn con trỏ | **Còn** | `legacy-reader.ts` `pages()` (chỉ `rows.length < pageSize` mới dừng) | Sửa ở bản vowasia: khử trùng theo khoá, ném lỗi nếu con trỏ không tiến. |
| Có mới trên main (đã đọc) | — | `lib/gtp-author-distribution.ts` (chia đều pool, không fallback "GTP Newsroom"), `urls.gonePaths` (410) trong `gtp-mapping.ts`/`gtp-redirects.ts`, `lib/verify-parity-links.ts`, mapping GTP `_provisional: []` | Dùng làm MÔ HÌNH cho B (chép/điều chỉnh vào thư mục vowasia, không import-sửa). |

Gap GTP (chỉ ghi, không sửa trong plan này): hai lỗi keyset ở trên đồng thời tồn tại ở bản GTP. Ảnh hưởng thực tế chỉ khi nhiều dòng cùng mili-giây `created_at` rơi đúng ranh giới trang. Chủ quyết riêng có sửa GTP hay không (cần amendment riêng + chạy lại `rehearse:gtp`).

## 5. Thiết kế

### 5.1 Cấu trúc thư mục (bản riêng)

Tất cả file mới nằm dưới `scripts/migrate/vowasia/`. Không file nào trong `scripts/migrate/` (ngoài thư mục con này) đổi. Test glob của GTP là `scripts/migrate/lib/*.test.ts` (một cấp) nên KHÔNG nhặt test vowasia; `lint:migrate` (`eslint scripts/migrate`) lại phủ cả thư mục mới, nên file mới phải qua lint.

### 5.2 Cấu hình nguồn bằng overlay (không hard-code)

- `legacy-source.vowasia.json` (commit): GIẢ THUYẾT cấu trúc, ghi rõ `"_hypothesis": true`: schema `public`, bảng `articles` và `sites` với tên cột phổ biến; **không site id, không host ảnh, không URL**. Discover xác minh giả thuyết với catalog thật và báo từng cột/bảng lệch (không đoán).
- Overlay (do chủ giữ NGOÀI repo, sinh từ báo cáo discover): `source.siteFilter` (giá trị), `source.siteIdKind`, `source.schema`, `source.tables.*` (đổi tên bảng/cột/khoá), **`source.columnRoles`** (S6: tên cột THẬT ứng với vai `createdAt`, `publishedAt`, `status`, `category`/`section`, `subsection`, `slug`, `title`, `body`, `image`, `name`, `bio`, `beats`; mọi builder đọc tên cột từ vai, không literal `created_at`/`status`/... như bản GTP), `media.hostAllowlist`, `media.hostRewrite` (chỉ A có siteFilter/siteIdKind/schema/tables/columnRoles; media dành B).
- Zod strict: khoá lạ bị từ chối; chuỗi "TODO" bị từ chối; tên bảng/cột phải khớp `^[a-z_][a-z0-9_]*$`; khoá `tables` tối đa 6 bảng; `sites.slug` kỳ vọng mặc định `vowasia`.

### 5.3 SQL: đóng theo cấu trúc (bản riêng của `legacy-sql.ts`)

Giữ nguyên triết lý: builder đóng + vị từ site cố định trong template + lexer lớp hai + `BEGIN READ ONLY` ngắn. Khác biệt có chủ đích:

1. Spec bảng nạp từ cấu hình (một lần, đóng băng) thay vì hằng 9 bảng; mặc định `articles`, `sites`.
2. Site id theo `siteIdKind`: `uuid` (regex như GTP), `integer` (`^[0-9]{1,18}$`), `text-safe` (`^[A-Za-z0-9_-]{1,64}$`, không dấu nháy). `assertSafeQuery` kiểm param[0] đúng kiểu; không dùng chuỗi nối.
3. Keyset (sửa lỗi B4): mỗi trang SELECT thêm cột `coalesce("created_at", $2::timestamptz)::text AS "__cursor_ts"` (cùng biểu thức với `ORDER BY`), con trỏ dùng chuỗi này (độ chính xác micro-giây, kèm offset múi giờ), so sánh bằng `$n::timestamptz`. `cursorOf` KHÔNG qua `Date`.
4. Reader (`pages()`): khử trùng theo khoá (Set các khoá đã thấy; trùng thì bỏ qua và đếm); nếu con trỏ mới bằng con trỏ cũ hoặc nhỏ hơn thì ném `legacy: keyset cursor did not advance; refusing.`; cột `__cursor_ts` bị gỡ khỏi dòng trả ra.
5. Chỉ SELECT; không dùng `JOIN`, `;`, chuỗi literal, comment (lexer lớp hai giữ nguyên các quy tắc).
6. **Builder được chép** từ `legacy-sql.ts` GTP (sửa theo overlay/vai cột): `catalogTables`, `catalogColumns`, `countRows`, `distribution`, `keysetPage`, `sampleRows`, `slugPlanRows`, `siteRow`. Discover cần đủ tám builder này; không builder nào chứa tên bảng/cột literal.
7. **Giới hạn IDENT:** tên schema/bảng/cột chỉ chấp nhận chữ thường snake_case `^[a-z_][a-z0-9_]*$` (không camelCase, không chữ hoa, không dấu cách). Nếu DB cũ không đáp ứng, tooling dừng với thông báo CỐ ĐỊNH: `legacy: identifier not supported by closed builder; amendment required.` (cần amendment, không nới lỏng tự động).

Bảng nhạy cảm của DB dùng chung KHÔNG xuất hiện trong repo/log/báo cáo (bài học A11-S16); test dùng decoy trung tính `secret_table_a..d`.

### 5.4 Hàng rào thật: role chỉ-đọc (SQL do chủ chạy)

Allow-list trong mã chỉ là lớp thứ hai; hàng rào thật là quyền của role. Hai phương án, chủ quyết sau khi chạy `01-readonly-inspect.sql`:

| | Phương án 2 (KHUYÊN) | Phương án 1 |
|---|---|---|
| Cách làm | Schema mới `vowasia_ro` chứa **view** `articles`, `sites` (lọc cứng theo site id vowasia); `vowasia_migrator` chỉ có `USAGE` schema đó + `SELECT` trên view; không quyền gì trên schema `public` | `ENABLE ROW LEVEL SECURITY` trên bảng dùng chung + policy cho `vowasia_migrator` theo site id |
| Ảnh hưởng site cũ | Không (không đổi bảng gốc, không đổi policy) | **Có thể làm hỏng site cũ**: khi RLS bật, role không bypass và không có policy sẽ thấy 0 dòng; chỉ chủ bảng/`BYPASSRLS` không bị ảnh hưởng (trừ `FORCE`) |
| Điều kiện | Chủ DB có `CREATE` trên DB để tạo schema; chủ bảng có `SELECT` | Phải chứng minh MỌI role đang kết nối của site cũ bypass RLS hoặc có policy |
| Dọn dẹp | `DROP SCHEMA vowasia_ro CASCADE; DROP ROLE vowasia_migrator;` | Gỡ policy + (nếu trước đó RLS tắt) `DISABLE ROW LEVEL SECURITY` đúng như trạng thái ban đầu |
| Cột đóng băng | `SELECT *` khoá danh sách cột lúc tạo view (chấp nhận được, nguồn đóng băng) | Không |

`01-readonly-inspect.sql` (đọc thuần) mở đầu bằng `current_database()`, `current_user`, `rolbypassrls` của role hiện tại; liệt kê bảng schema `public` (chủ chỉ báo lại tên bảng LIÊN QUAN tới VowAsia, KHÔNG báo tên bảng nhạy cảm), `relrowsecurity`/`relforcerowsecurity`, `pg_policies` hiện có, kiểu cột `site_id`, và mẫu truy vấn tìm dòng site (chủ sửa tên bảng). Hai file mẫu role không bao giờ tự chạy; `sql/03-drop-role-and-views.sql` để dọn.

**Hardening bắt buộc cho `02` (S4):**

- Role: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT <n>`; `ALTER ROLE vowasia_migrator SET default_transaction_read_only = on`, `statement_timeout`, `idle_in_transaction_session_timeout` (có tiền lệ trong fixture GTP). Mật khẩu KHÔNG nằm trong file SQL (chủ đặt bằng `\password`).
- View: `WITH (security_barrier = true)`; danh sách cột TƯỜNG MINH, KHÔNG `SELECT *`: `sites` chỉ `id`, `slug`, `name`; `articles` chỉ các cột nội dung cần cho migrate, LOẠI cột cá nhân (email, IP, ghi chú nội bộ...); chủ chốt danh sách cột sau O2.
- Truy vấn tự kiểm ở cuối file `02`: view `sites` trả đúng 1 dòng với slug `vowasia`; `has_schema_privilege`/`has_table_privilege` của role trên `public` = false (kể cả `CREATE` trên schema `public` với PG ≤ 14). **Xử lý kết quả (T5a):** nếu bất kỳ quyền nào của role trên `public` báo `true` (nguyên nhân thường gặp: PUBLIC có quyền; PG ≤ 14 PUBLIC có `CREATE` trên schema `public`) hoặc view `sites` không đúng 1 dòng slug `vowasia` thì DỪNG theo HS5: không dùng role, chạy `03` để dọn, báo chủ.
- Ghi chú trong file: KHÔNG `REVOKE ... FROM PUBLIC` (có thể ảnh hưởng site cũ); role là cấp CỤM (cluster-wide), không chỉ cấp database; role kế thừa quyền của `PUBLIC`.
- `03-drop-role-and-views.sql`: `DROP SCHEMA IF EXISTS vowasia_ro CASCADE; DROP OWNED BY vowasia_migrator; DROP ROLE IF EXISTS vowasia_migrator;` (thứ tự này; `DROP OWNED BY` trước `DROP ROLE` để không lỗi khi còn grant).

### 5.5 Marker, tenant, DB name (khoá cho B, hằng số có test từ A)

`vowasia-constants.ts`: `TENANT_SLUG="vowasia"`, `MARKER_SOURCE_NAME="legacy:vowasia"`, `MARKER_ORIGIN="import"`, `CENTRAL_DB_PATHNAME` (lấy lại từ guard có sẵn). Test: khác marker GTP, không chứa `globaltravelpost`.

## 6. Các giai đoạn

### Implementation Checklist: Giai đoạn A — Đọc/discover (EXECUTE ngay sau VALIDATE; không cần biết schema)

Checklist (thứ tự thực hiện; mỗi bước nguyên tử, kèm kiểm tra):

1. Tạo `scripts/migrate/vowasia/lib/vowasia-constants.ts` + `vowasia-constants.test.ts` (marker khác GTP, không chứa `globaltravelpost`, tenant `vowasia`).
2. Tạo `lib/vowasia-config.ts` (zod strict, kiểu site id, bảng/cột, overlay) + `vowasia-config.test.ts` (khoá lạ, "TODO", tên bảng sai, quá 6 bảng, siteIdKind sai, overlay thiếu siteFilter, mặc định đúng 2 bảng) **và (T6c)** parse `legacy-source.vowasia.json` (phải qua zod, không chứa `TODO`) cùng `fixtures/overlay.fixture.json` (phải qua zod). Schema giai đoạn A chấp nhận khoá `media` ở dạng TUỲ CHỌN: validate hình dạng (`hostAllowlist`, `hostRewrite`) nhưng bỏ qua giá trị trong A, để overlay chủ viết một lần dùng được cho cả A lẫn B.
3. Tạo `lib/vowasia-sql.ts` (bản riêng của builder + lexer + `LegacyReadOnlyDb`; đủ tám builder ở §5.3 mục 6) + `vowasia-sql.test.ts`: corpus tấn công (comment, `;`, literal, dollar quote, `JOIN`, comma join, hàm lạ, bảng ngoài allow-list, decoy `secret_table_a..d`), site id `uuid`/`integer`/`text-safe` hợp lệ + không hợp lệ, template khớp tuyệt đối, thứ tự sự kiện `BEGIN`/`QUERY`/`COMMIT`, keyset text có `__cursor_ts`, từ chối `ORDER BY created_at` trên bảng không có `created_at`, **ca overlay đổi tên cột (vai `createdAt` -> tên khác) và `siteIdKind` khác `uuid`, IDENT chữ hoa/camelCase bị từ chối với thông báo cố định (S6)**.
4. Tạo `lib/vowasia-reader.ts` (`LiveVowasiaReader`, `assertVowasiaSite`) + `vowasia-reader.test.ts` với client giả: khử trùng khoá, con trỏ không tiến => lỗi, hai dòng cùng mili-giây khác micro-giây qua ranh giới trang không mất không trùng (mô phỏng bằng client giả tuân theo ngữ nghĩa so sánh text), site slug khác `vowasia` => từ chối.
5. Tạo `lib/vowasia-db-banner.ts` + `vowasia-db-banner.test.ts` (chỉ `host:port/db`, không bao giờ credential; thông báo cố định; `LEGACY_VOWASIA_DB_URL`/`_SSL`/`_CA`).
6. Tạo `lib/args.ts` và `lib/out-dir.ts` (CHÉP RIÊNG từ bản GTP, ~150 dòng, S7; không import file GTP). **T1 (bảo mật, làm TRƯỚC mọi thứ khác ở bước này, red-first):** viết `out-dir.test.ts` trước, gồm (a) `repoRoot()` là thư mục chứa cả `package.json` và `.git`; (b) `assertOutDirSafe(path.join(repoRoot(),"process","vowasia-guard-probe"))` ném `notIgnored` TRƯỚC khi tạo thư mục (khẳng định thư mục không tồn tại sau khi ném); (c) thư mục dưới `scripts/migrate/out/` được chấp nhận (mode 700). Chạy và xác nhận (a)/(b) ĐỎ với bản chép nguyên (bản GTP có `repoRoot()` lùi 3 cấp; ở `scripts/migrate/vowasia/lib/` phải 4 cấp, nên bản chép trỏ về `<repo>/scripts`, thư mục trong repo ngoài `scripts/` bị coi là "ngoài repo" và bỏ qua kiểm git-ignore; repo này công khai). Sau đó sửa: `repoRoot()` lùi 4 cấp (`scripts/migrate/vowasia/lib` -> gốc repo) và đổi comment đầu file từ "GTP" sang trung tính; test xanh. Kèm `args.test.ts` ngắn. Rồi `lib/vowasia-cli.ts` (parse cờ, `runMain` lỗi cố định, exit 2 cho từ chối) kèm `lib/vowasia-cli.test.ts` (T6a): `runMain` trả mã 0 khi thành công, 2 cho từ chối có chủ đích với thông báo cố định, 1 cho lỗi khác; thông báo không chứa URL hay mật khẩu. Nếu chủ đổi sang import (O-Q1): T1 biến mất, thêm test chống drift thay cho bản chép.
7. Tạo `legacy-source.vowasia.json` (giả thuyết) + `fixtures/overlay.fixture.json` (site id giả `...f002`, tên bảng giả).
8. Tạo `discover-vowasia.ts`: đọc catalog, xác minh giả thuyết (báo lệch cột/bảng), đếm theo site, phân bố (status, category/section theo cột cấu hình, năm), phân tích slug (trùng, hoa/thường, ký tự lạ), hình dạng body (HTML/Markdown/JSON, tín hiệu `script`/`iframe`/`on*=`/`javascript:`), thống kê host ảnh + số bài không ảnh, ngày thiếu, ước lượng dung lượng ảnh nếu có cột; ghi `legacy-schema-report.md`, `legacy-mapping.template.json` (cố ý có `TODO`), `query-log.json` vào `scripts/migrate/out/vowasia/` (git-ignored, 700/600). Không in body, không in site id, không in tên bảng ngoài cấu hình.
9. Tạo `sql/01-readonly-inspect.sql`, `sql/02-create-readonly-role-views.sql.template` (phương án 2), `sql/02b-alternative-rls.sql.template` (phương án 1, ghi rõ cảnh báo), `sql/03-drop-role-and-views.sql`. Mọi file có đầu trang: "OWNER-RUN. KHÔNG tự chạy. Đọc `VOWASIA-LEGACY.md` trước." File 01 chỉ SELECT; file 02/03 là DDL do chủ chạy (đây là DDL DUY NHẤT trên DB cũ, do chủ chạy; probe ở bước 10 chạy DDL chỉ trên PG16 tạm cục bộ do chính nó dựng và dọn). **T5a:** cuối file `02` có truy vấn tự kiểm; nếu nó trả `true` cho bất kỳ quyền nào của role trên `public` (kể cả `CREATE` trên schema `public` với PG ≤ 14, thường do PUBLIC có quyền) hoặc view `sites` không đúng 1 dòng slug `vowasia` thì DỪNG theo HS5: không dùng role, chạy `03` để dọn, báo chủ. Ghi hướng dẫn này cả ở đầu file `02` lẫn trong `VOWASIA-LEGACY.md`.
10. Tạo `fixtures/keyset-probe.ts` + `fixtures/keyset-probe.sh` (Hybrid): bật PG16 native cục bộ (cổng trong dải 54331-54339, ví dụ 54336; native PG16 + `runuser`; `mktemp -d`, `trap` dọn), tạo bảng giả `articles`/`sites` (site id kiểu `uuid` rồi `integer`; nhiều site), seed các ca: 2 dòng cùng mili-giây khác micro-giây ở ranh giới trang, nhiều dòng `created_at` y hệt khác `id`, `created_at` NULL, 1970; đọc bằng reader với `pageSize` 1/2/3; khẳng định đọc đủ, đúng một lần, đúng thứ tự; chạy `discover-vowasia.ts` với `LEGACY_VOWASIA_DB_URL` cục bộ + overlay fixture, khẳng định report sinh ra, `query-log.json` toàn `SELECT` có vị từ site, không `BEGIN` không READ ONLY. **Phần role (S3, AC-A8):** áp `sql/02` (điền placeholder từ fixture; mật khẩu sinh trong probe, không nằm trong file `sql/*`), kết nối bằng `vowasia_migrator` và khẳng định: đọc view chỉ ra site vowasia; đọc bảng gốc bị từ chối; INSERT/UPDATE/DELETE/DDL bị từ chối; `relrowsecurity`/`pg_policies`/grant của bảng gốc không đổi trước/sau; áp `sql/03` rồi schema + role biến mất và `DROP ROLE` không lỗi; `02b` chỉ kiểm cú pháp/placeholder. **Khẳng định đầu ra (T6b, AC-A6):** stdout, stderr, `legacy-schema-report.md`, `legacy-mapping.template.json`, `query-log.json` KHÔNG chứa giá trị site id fixture, mật khẩu của role fixture, hay đoạn body mẫu (grep tường minh, xanh = không khớp); thư mục out mode 700, file 600.
11. Tạo `VOWASIA-LEGACY.md` (tiếng Việt, hướng dẫn chủ từng bước, nêu rõ ai chạy gì, in tên database, `read -s`, `clear`).
11b. (T4) Tạo `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (stub Known-Gap AC-A9): kết quả O2-O5 cần thu về, tiêu chí nhận (discover thật: không lệch giả thuyết hoặc lệch đã vào overlay; `query-log.json` toàn SELECT có vị từ site; không bí mật trong báo cáo), ai chạy (chủ), điều kiện/hạn (trước khi mở amendment B). Cổng G13: `test -f` file này. Ghi vào report EXECUTE. File do EXECUTE tạo, KHÔNG tạo ở bước PLAN.
12. Sửa `package.json` (chỉ THÊM 3 dòng script, không đổi dòng nào khác): `migrate:vowasia:discover`, `test:migrate-vowasia`, `probe:migrate-vowasia`.
13. Chạy toàn bộ cổng mục 12 (tại EVL do `vc-tester`), thu bằng chứng, ghi vào report cùng thư mục task.
14. Commit, push, PR nháp (mục 15).

Cổng chuyển A -> B (Hard Stop HS7): chủ hoàn tất O1-O6 (mục 13), gửi `legacy-schema-report.md` đã tự rà (không bí mật, không tên bảng nhạy cảm), chốt C3/C8/C10/host ảnh. Khi đó mở amendment/plan bổ sung cho B.

### Giai đoạn B — Import (CHƯA thực thi được; phác thảo để thiết kế đúng)

Điều kiện tiên quyết: cổng chuyển A -> B ở trên + A1 xác nhận (tenant + taxonomy đã `--apply`, kiểm bằng O1) + chủ duyệt plan bổ sung B.

Thành phần dự kiến (mô hình: tooling GTP hiện tại, chép/điều chỉnh vào `scripts/migrate/vowasia/`, không import-sửa file GTP):

| Thành phần | Điểm thiết kế bắt buộc |
|---|---|
| Mapping (`legacy-mapping.vowasia.json` + zod) | pillar = 8 slug vowasia, `press-room` không sub-section; `taxonomy.rules` (C8) rỗng mặc định => reject có báo cáo; `urls.*` (C3) có `_provisional` + `--require-final` cho lệnh non-local; `tags` gom về 6 tag + thêm có kiểm soát (C4); không trường SEO (C5); `authors.distribute.pool` = 6 tên, cấm fallback tên chung |
| Chuyển đổi (transform) | trạng thái C2 (published/archived giữ; draft, scheduled -> nháp; rejected bỏ); bài thiếu ảnh -> nháp (C6); thiếu ngày đăng dùng ngày tạo (C7); body -> Lexical với làm sạch (`script`, `iframe`, `on*`, `javascript:`) |
| Phân tác giả | bản chép của `gtp-author-distribution.ts`: pool 6, nhóm theo quốc gia + quý, độ lệch tối đa 1; kế hoạch tính TẤT ĐỊNH trên TOÀN tập ở MỖI run (không lưu trạng thái giữa các run), lưu `author-plan.json` của run; importer chỉ tra tác giả đã tồn tại (không tạo) |
| Slug plan | cùng quy tắc xác định (created_at, id) trên toàn tập ở mỗi run; không va slug với bài của run trước (tra slug đã có trong Central); thứ tự chọn `--limit 50` TẤT ĐỊNH (xem "Điểm phải chốt ở amendment B"); reserved slugs lấy từ route web VowAsia (chưa biết) |
| Ảnh | tải về R2, tối đa 20 MB/ảnh, dừng nếu ảnh hỏng > 2%, host chỉ trong `hostAllowlist` (overlay), chống SSRF (đã có mẫu `media-fetch.ts`) |
| Importer | chỉ tạo mới, marker `legacy:vowasia`, `origin=import`, dry-run mặc định, `--apply` cần TTY + `--confirm-host` + `assertCentralDbName`, `--limit`, run-id MỚI cho mỗi lần `--apply` (KHÔNG `--resume` run cũ), journal fsync, báo cáo reject. Bài đã tồn tại (khoá marker + legacy id) bị BỎ QUA, không tạo lại, không sửa. Run-id ghi thành journal theo run dưới thư mục out (mô hình GTP), KHÔNG thêm trường vào `Articles` (không đổi schema) |
| Rollback | theo run-id, chỉ xoá bài mang marker vowasia + tenant vowasia + đúng run-id đó (không chạm run khác), `--include-edited`/`--list-orphans` như GTP |
| Link nội bộ (second pass) | `rewrite-links` theo `slug-map`, dry-run mặc định |
| Ngày đăng/tạo (C7) | `timestamps-fix.sql` sinh sẵn, **chủ chạy**, đầu file nêu `psql -v ON_ERROR_STOP=1`, điều kiện marker vowasia + tenant vowasia |
| Redirect/410 | `urls.gonePaths` -> `{status:410}`, bài có chỗ mới -> 301; chỉ có hiệu lực nếu web mới ship redirect map; bao phủ tối thiểu `--min-coverage` |
| Verify | so khớp số lượng/ngày/tác giả, kiểm công khai bằng read token của tenant (biến `VOWASIA_READ_TOKEN`), kiểm link trong body |
| Fixture + rehearsal | fixture DB cũ tổng hợp (hai site, một là vowasia, id kiểu thật sau discover) + `rehearse-vowasia.sh` (native PG16, một lần, một mình) + `rehearse-assert.ts`. **Ca "lần 2" bắt buộc:** run 1 `--apply --limit 50`; run 2 với run-id MỚI cho phần còn lại; khẳng định: không trùng bài, không sửa bài run 1, tác giả lệch ≤1 trên hợp hai run, rollback run 2 không chạm run 1 |
| npm scripts (dự kiến) | `migrate:vowasia:import`, `:rewrite-links`, `:rollback`, `:redirects`, `:verify`, `:fixture`, `rehearse:vowasia`, `test:migrate-vowasia` (mở rộng) |
| Runbook thật (chủ chạy) | dry-run import -> ghi thử 50 bài (`--apply --limit 50`, run-id A), chủ xem bằng mắt -> ghi phần còn lại (`--apply` với run-id B MỚI, KHÔNG `--resume` run A) -> `rewrite-links` -> SQL khôi phục ngày (chủ chạy) -> verify -> redirect -> gỡ role/view |

**Điểm phải chốt ở amendment B (T7, không chặn A):**

1. "Ghi run-id lên từng bài" = journal theo run dưới thư mục out (mô hình GTP: `slug-map.ndjson`, `createdAtRun`). KHÔNG thêm trường vào `Articles`, không đổi schema.
2. Thứ tự chọn `--limit 50` phải tất định, ví dụ (created_at, id) trên tập đã lọc; kế hoạch slug và tác giả tính trên TOÀN tập ở mỗi run.
3. Bài mang marker do run khác tạo: GTP "không nhận nuôi" (A13-R05). Với vowasia, định nghĩa rõ: BỎ QUA theo legacy id đã có trong Central (không tạo lại, không sửa, không rollback bởi run này) nhưng VẪN tính trong kế hoạch tác giả/slug của run hiện tại; rollback chỉ xoá bài mang đúng run-id của chính nó.

## Acceptance Criteria (mục 7, Giai đoạn A)

Không có file SPEC riêng; tiêu chí suy ra từ các quyết định đã chốt (mục 2) và ràng buộc (mục 3). Mỗi tiêu chí nêu gate chứng minh và chiến lược.

| ID | Tiêu chí | proven by | strategy |
|---|---|---|---|
| AC-A1 | Không file GTP nào đổi (kể cả `package.json` ngoài 3 dòng vowasia) | G7, G8 (diff theo pathspec) | Fully-Automated |
| AC-A2 | Mọi SQL phát ra là SELECT một bảng trong allow-list, có vị từ site cố định; corpus tấn công đều bị từ chối | G1: `vowasia-sql.test.ts` | Fully-Automated |
| AC-A3 | Site id kiểu `uuid`/`integer`/`text-safe` được kiểm đúng kiểu; kiểu sai bị từ chối | G1: `vowasia-sql.test.ts`, `vowasia-config.test.ts` (gồm parse zod `legacy-source.vowasia.json` + overlay fixture) | Fully-Automated |
| AC-A4 | Keyset không mất/trùng dòng khi trùng mili-giây khác micro-giây, `created_at` y hệt, `created_at` NULL, trên PG16 thật | G6: keyset-probe.sh | Hybrid (PG16 native cục bộ) |
| AC-A5 | Khử trùng theo khoá và chốt chặn con trỏ không tiến hoạt động | G1: `vowasia-reader.test.ts` | Fully-Automated |
| AC-A6 | Discover chỉ phát SELECT có vị từ site, ghi báo cáo vào thư mục git-ignored (guard out-dir phủ cả thư mục ngoài `scripts/`), không in id/body/credential | G6 (query-log + grep stdout/stderr/báo cáo), G1 (`vowasia-db-banner.test.ts`, `out-dir.test.ts`, `vowasia-cli.test.ts`) | Hybrid |
| AC-A7 | Marker vowasia khác marker GTP và không chứa `globaltravelpost` | G1: `vowasia-constants.test.ts` | Fully-Automated |
| AC-A8 | SQL mẫu chủ chạy: file 01 chỉ đọc; file 02/03 chỉ tạo/xoá đúng schema `vowasia_ro` + role `vowasia_migrator`; role chỉ đọc đúng site, bảng gốc bị từ chối, không ghi được, RLS/policy/grant bảng gốc không đổi, dọn sạch được; không chứa mật khẩu | G6 phần role (probe PG16 cục bộ áp 02/03) + G9 (review `vc-code-reviewer`) + G10 (grep máy) | Hybrid (+ Agent-Probe + Fully-Automated) |
| AC-A9 | Tooling chạy đúng trên DB cũ THẬT (schema thật, RLS thật, role thật) | Chỉ O2-O5 của chủ | **Known-Gap** (xem dưới) |
| AC-A10 | GTP vẫn xanh | G4, G5, G11 | Fully-Automated + Hybrid |

Known-Gap AC-A9 (không phải trạng thái PASS cuối): hành vi trên DB thật chỉ được chứng minh khi chủ chạy O2-O5. Hệ quả: (1) viết backlog stub `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (nội dung: kết quả O2-O5 cần thu về, tiêu chí nhận); (2) cổng A -> B giữ **CONDITIONAL** tới khi discover thật xanh; (3) plan KHÔNG được tuyên bố hành vi "đã phát triển" là PASS chỉ nhờ Known-Gap (cấm vacuous-green).

## Touchpoints (mục 8)

Mọi file Giai đoạn A là MỚI. Đường dẫn gốc `scripts/migrate/vowasia/`.

| File | Loại | Ghi chú |
|---|---|---|
| `lib/vowasia-constants.ts` | mới | tenant, marker, tên DB |
| `lib/vowasia-constants.test.ts` | mới | AC-A7 |
| `lib/vowasia-config.ts` | mới | zod strict, `siteIdKind`, bảng/cột |
| `lib/vowasia-config.test.ts` | mới | AC-A3 |
| `lib/vowasia-sql.ts` | mới | bản riêng builder + lexer + read-only DB + sửa keyset |
| `lib/vowasia-sql.test.ts` | mới | AC-A2, AC-A3 |
| `lib/vowasia-reader.ts` | mới | reader trực tiếp + khử trùng + chốt chặn |
| `lib/vowasia-reader.test.ts` | mới | AC-A5 |
| `lib/vowasia-db-banner.ts` | mới | `LEGACY_VOWASIA_DB_URL` |
| `lib/vowasia-db-banner.test.ts` | mới | AC-A6 |
| `lib/vowasia-cli.ts` | mới | parse cờ, `runMain` |
| `lib/vowasia-cli.test.ts` | mới | T6a: mã thoát 0/2/1, thông báo cố định, không lộ URL/mật khẩu |
| `lib/args.ts`, `lib/out-dir.ts` (+ `args.test.ts`, `out-dir.test.ts`) | mới | bản CHÉP RIÊNG từ GTP (S7), không import file GTP; T1: `repoRoot()` lùi 4 cấp, comment trung tính, test đỏ-trước |
| `discover-vowasia.ts` | mới | CLI discover |
| `legacy-source.vowasia.json` | mới | giả thuyết cấu trúc, không bí mật |
| `fixtures/overlay.fixture.json` | mới | overlay giả cho probe |
| `fixtures/keyset-probe.ts`, `fixtures/keyset-probe.sh` | mới | Hybrid, PG16 native |
| `sql/01-readonly-inspect.sql` | mới | owner-run, đọc |
| `sql/02-create-readonly-role-views.sql.template` | mới | owner-run, phương án 2 |
| `sql/02b-alternative-rls.sql.template` | mới | owner-run, phương án 1 (không khuyên) |
| `sql/03-drop-role-and-views.sql` | mới | owner-run, dọn |
| `VOWASIA-LEGACY.md` | mới | hướng dẫn chủ |
| `package.json` | **sửa (chỉ thêm 3 dòng)** | `migrate:vowasia:discover`, `test:migrate-vowasia`, `probe:migrate-vowasia` |
| `process/general-plans/active/vowasia-legacy-migration_16-10-26/` | mới | plan này + report EXECUTE/EVL |
| `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` | mới | stub Known-Gap AC-A9 |

Chỉ `package.json` là file hiện có được phép đổi. Docs/context (`docs/12-migration.md`, `process/context/*`) KHÔNG sửa ở A; cập nhật ở UPDATE PROCESS sau, cần lệnh riêng.

## Public Contracts (mục 9)

- CLI: `npm run migrate:vowasia:discover -- [--mapping-overlay <path>] [--site-id <id>] [--out <dir>] [--sample N] [--schema S]`; đọc `LEGACY_VOWASIA_DB_URL` (+ `LEGACY_VOWASIA_DB_SSL`, `LEGACY_VOWASIA_DB_CA`) từ môi trường; exit 0 thành công, 2 từ chối có chủ đích (thông báo cố định), 1 lỗi khác.
- Artefact: `scripts/migrate/out/vowasia/{legacy-schema-report.md, legacy-mapping.template.json, query-log.json}` (git-ignored, 700/600).
- Hằng số xuất cho B: `TENANT_SLUG`, `MARKER_SOURCE_NAME`, `MARKER_ORIGIN` (marker `legacy:vowasia`).
- Không đổi: API công khai/engine/hub, schema Payload, migration Payload, `src/**`.
- Bề mặt bảo mật: role `vowasia_migrator` + schema `vowasia_ro` trên DB CŨ (do chủ tạo/xoá). Không tạo secret trong repo.

## Blast Radius (mục 10)

- Chạm: 26 file mới dưới `scripts/migrate/vowasia/` (đếm từ bảng Touchpoints: 21 file gốc + `args.ts`, `out-dir.ts` + 3 test `args.test.ts`, `out-dir.test.ts`, `vowasia-cli.test.ts` = 26), 1 file backlog (`process/general-plans/backlog/`), thư mục plan, và 3 dòng `package.json`. Tổng file mới ngoài thư mục task: 27.
- Không chạm: bất kỳ file nào khác trong `scripts/migrate/` (GTP), `scripts/lib/`, `scripts/audit/`, `src/`, `docs/`, `process/context/`.
- Runtime: không có (script chạy tay). Không DB Central bị ghi trong A. DB cũ chỉ bị ĐỌC (và DDL role/view do chủ chạy).
- Bằng chứng GTP không đổi: G7 (`git diff --stat` ngoài danh sách phải rỗng), G8 (`git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` thoát 0), kèm G4/G5/G2/G3 xanh (G11 tuỳ chọn, O-Q5).

## Phase Completion Rules

- Giai đoạn A chỉ là `CODE DONE` khi G1-G10 + G7b + G7c + G13 xanh tại EVL (G11 `rehearse:gtp` KHÔNG bắt buộc, chỉ khi chủ yêu cầu, O-Q5); chỉ là `VERIFIED` khi thêm G12 (discover thật do chủ chạy) xanh. Known-Gap AC-A9 giữ cổng A -> B ở CONDITIONAL.
- Giai đoạn B không được bắt đầu (HS7) khi A chưa `CODE DONE` + EVL xanh + cổng chuyển A -> B thoả.

## 11. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| RLS bật trên bảng dùng chung làm hỏng site cũ (đang chạy) | Cao | Khuyên phương án 2 (không đổi bảng gốc); file 01 kiểm RLS/role trước; HS5; phương án 1 chỉ khi chứng minh mọi role site cũ bypass RLS |
| Site id không phải UUID | TB | `siteIdKind` + test 3 kiểu; probe chạy `uuid` và `integer` |
| Tên bảng/cột khác GTP | Cao (chắc chắn có lệch) | Cấu hình bằng overlay; discover báo lệch giả thuyết; không đoán |
| Lỗi keyset (ms) khi trùng ranh giới trang | TB | Sửa ở bản vowasia; probe PG16 + test client giả; khử trùng + chốt chặn |
| Chạy nhầm database (sự cố 13-10-26) | Cao | Banner in `/neondb` trước, `assertCentralDbName` sau `assertLocalOrConfirmed` (B); trước `--apply` chủ in `new URL(...).pathname` |
| Nhận nhầm marker GTP/vowasia | Cao | Marker khác, test khẳng định; rollback/verify điều kiện theo tenant + marker (B) |
| Lộ bí mật/tên bảng nhạy cảm vào repo hoặc log | Cao | `read -s`; URL chỉ qua env; log chỉ `host:port/db`; chủ rà báo cáo trước khi chia sẻ; test decoy |
| Ghi nhầm vào DB cũ | Cao | Builder SELECT-only + lexer + `BEGIN READ ONLY`; role chỉ SELECT là hàng rào thật; HS1 |
| Giả thuyết cấu trúc sai làm discover rỗng/lệch | TB | Discover báo rõ từng lệch, không tự thay; chủ điền overlay; vòng lặp rẻ |
| Probe/rehearsal chồng chéo hoặc để lại tiến trình/PG tạm | TB | Một lần, một mình, nền; `trap` dọn; HS6; cổng riêng 54336 khác rehearsal (54326-54328) |
| Coupling với helper GTP | Thấp | Mặc định CHÉP RIÊNG `args.ts`/`out-dir.ts` (S7) nên không coupling; nếu chủ chọn import thì thêm test chống drift |
| Guard out-dir bản chép trỏ sai gốc repo (`repoRoot()` lùi thiếu cấp): thư mục trong repo ngoài `scripts/` bị coi là "ngoài repo", bỏ qua kiểm git-ignore, báo cáo discover có thể bị commit vào repo CÔNG KHAI | Cao | T1: `repoRoot()` 4 cấp + test đỏ-trước (`package.json`+`.git`, `process/...` ném `notIgnored` trước khi tạo thư mục, `scripts/migrate/out/` được chấp nhận) |
| Bài archived mất URL (C2/C3 chưa chốt) | TB | B nhận quyết định qua `urls.*`; discover liệt kê số bài archived/section |

Dự báo rủi ro (tóm tắt thảo luận 5 góc nhìn): (a) an ninh: đây là điểm mạnh/ yếu nhất ở hàng rào quyền, không phải ở mã; (b) vận hành: rủi ro lớn nhất là thao tác tay của chủ trên DB dùng chung, cần SQL ngắn, có dòng "đọc trước", có HS5; (c) bảo trì: bản riêng làm lặp mã nhưng đúng lựa chọn B3; (d) dữ liệu: ngày/URL/tác giả là nơi hỏng tin cậy, đều để B nhận quyết định; (e) kiểm thử: DB thật là Known-Gap duy nhất, có backlog stub.

Ca biên đã đưa vào test (từ ba hạng mục nguy hiểm nhất: SQL guard, keyset, role SQL): chuỗi `site_id` có dấu nháy/`;`; `created_at` ở 1970; hai dòng cùng micro-giây khác id; trang đúng bằng `pageSize` rồi hết; client trả lặp cùng một trang; bảng `sites` có hai dòng cùng slug; cột `site_id` kiểu `bigint`; tên schema có chữ hoa; mật khẩu/URL không bao giờ lọt vào thông báo lỗi.

## Verification Evidence (mục 12)

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| G1 `npm run test:migrate-vowasia` | Fully-Automated | AC-A2, AC-A3, AC-A5, AC-A6 (banner), AC-A7; T1 (`out-dir.test.ts`: `repoRoot()` 4 cấp, `notIgnored` trước khi tạo thư mục), T6a (`vowasia-cli.test.ts`), T6c (parse zod 2 file JSON) |
| G2 `npm run lint:migrate` | Fully-Automated | chất lượng file mới + GTP không vỡ lint (AC-A10) |
| G3 `npm run typecheck` | Fully-Automated | kiểu đúng toàn repo |
| G4 `npm run test:migrate-gtp` | Fully-Automated | AC-A10 |
| G5 `npm run test:single-home` | Fully-Automated | AC-A10 (guard DB/taxonomy vowasia không vỡ) |
| G6 `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` (`probe:migrate-vowasia`; gồm phần keyset, discover, VÀ phần role áp `sql/02`+`sql/03` bằng role mới) | Hybrid (PG16 native cục bộ cổng 54331-54339; điều kiện: `/usr/lib/postgresql/16/bin`, `runuser`) | AC-A4, AC-A6, AC-A8 |
| G7 `git diff --name-only fe88bc4 -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` chỉ in `package.json` | Fully-Automated | AC-A1 |
| G8 `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` thoát 0 | Fully-Automated | AC-A1, AC-A10 (không file GTP đổi) |
| G7b `git diff -U0 fe88bc4 -- package.json \| grep -E '^\+[^+]'` (loại dòng tiêu đề `+++`): đúng 3 dòng và mọi dòng chứa `vowasia` | Fully-Automated | AC-A1 |
| G7c `! git ls-files --others --exclude-standard \| grep -vE "^(scripts/migrate/vowasia/\|process/general-plans/)"` (rỗng = pass; bắt file MỚI chưa theo dõi mà G7/G8 mù, vì EVL chạy trước commit) | Fully-Automated | AC-A1 |
| G9 Review an toàn các file `sql/*` + `vowasia-sql.ts` bởi `vc-code-reviewer` (sonnet) | Agent-Probe | AC-A8 |
| G10 (dạng `! grep`, rỗng = pass; ranh giới từ, bỏ dòng comment `--`): `! grep -vE "^\s*--" sql/01-*.sql \| grep -nEiw "(insert\|update\|delete\|truncate\|drop\|alter\|grant\|create)"` (ranh giới từ `-w` để `created_at`/`updated_at` không khớp nhầm); `! grep -nEi "password[[:space:]]+'" sql/*`; `! grep -rnEi "postgres(ql)?://" scripts/migrate/vowasia --exclude="*.test.ts" --exclude="keyset-probe.*"` (`postgres://` hợp lệ trong test/probe vì là URL cục bộ giả; `VOWASIA-LEGACY.md` và comment trong `lib/*.ts` KHÔNG được chứa scheme này) | Fully-Automated | AC-A8, HS4 |
| G11 `npm run rehearse:gtp` — KHÔNG bắt buộc sau A (O-Q5; G8 + G7c đã chứng minh 0 byte GTP đổi); chạy MỘT lần, một mình, nền, timeout 7200000, `REHEARSE_MODE=native` ở EVL cuối chương trình sau B, hoặc sớm hơn nếu chủ yêu cầu | Hybrid | AC-A10 (ràng buộc 9) |
| G12 Discover trên DB cũ THẬT (chủ chạy O5) | **Known-Gap** (backlog stub; cổng A -> B CONDITIONAL) | AC-A9 |
| G13 `test -f process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (stub Known-Gap AC-A9 tồn tại; không có thì AC-A9 không hợp lệ) | Fully-Automated | AC-A9 (residual có tên) |

Ghi chú vận hành EVL: `vc-tester` chạy lại độc lập đúng các lệnh trên, tuần tự (G11 và G6 không chạy song song nhau hay song song `npm ci`). Mọi lệnh G1-G10 là đọc/ghi cục bộ trong cây làm việc.

## 13. Owner-Run Steps (danh sách; lời hướng dẫn đầy đủ nằm trong `VOWASIA-LEGACY.md` do EXECUTE A viết)

Giai đoạn A:

- O1: Kiểm A1 bằng lệnh ĐỌC: `npm run audit:add-vowasia-taxonomy` (dry run; in tên database trước; tenant có → xem 49 dòng `exists`/`create`; tenant thiếu → báo "not found"). Ghi kết quả (tenant có/không, taxonomy đã `--apply` chưa).
- O2: Chạy `sql/01-readonly-inspect.sql` trên DB cũ bằng role hiện có của chủ (không dán bí mật). Báo lại: tên bảng liên quan VowAsia, cờ RLS/policy, role hiện tại có `BYPASSRLS` không, kiểu `site_id`, giá trị site id của VowAsia (chỉ nếu chủ thấy an toàn khi chia sẻ qua kênh phù hợp).
- O3: Chọn phương án role (khuyên 2). Chạy `sql/02-create-readonly-role-views.sql.template` (sau khi tự điền placeholder), đặt mật khẩu bằng `openssl rand -base64 24 | pbcopy` + `\password vowasia_migrator`; chạy `clear`.
- O4: `read -s LEGACY_VOWASIA_DB_URL; export LEGACY_VOWASIA_DB_URL` (và `_SSL` nếu cần); không echo, không lưu vào lịch sử.
- O5: Chạy `npm run migrate:vowasia:discover -- --mapping-overlay <overlay ngoài repo>`; tự rà `scripts/migrate/out/vowasia/legacy-schema-report.md` (xoá tên bảng nhạy cảm nếu có) rồi chia sẻ.
- O6: Chốt C3, C8, C10, host ảnh/R2 dựa trên báo cáo.

Giai đoạn B (sau amendment): O7 dry-run import; O8 `--apply --limit 50` (run-id A) + xem bằng mắt; O9 `--apply` phần còn lại với run-id B MỚI (KHÔNG `--resume` run A; bài đã có bị bỏ qua); O10 `rewrite-links`; O11 chạy `timestamps-fix.sql` (C7); O12 verify; O13 redirect/410; O14 chạy `sql/03-drop-role-and-views.sql`. Rollback luôn theo từng run-id. Trước MỌI `--apply`: `node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'` phải in `/neondb`.

## Test Infra Improvement Notes (mục 14)

- `lint:migrate` phủ cả `scripts/migrate`, nên file vowasia chịu chung quy tắc lint; test vowasia ở thư mục con để glob GTP (`lib/*.test.ts`) không nhặt nhầm.
- Kiểm thử keyset hiện chỉ có client giả: nên có probe PG thật (do plan này thêm cho vowasia). Đề xuất riêng cho GTP (ngoài phạm vi, chờ chủ): thêm cùng probe.
- `rehearse-gtp.sh` mất ~60 phút; nên có nhánh "smoke" ngắn nếu chủ muốn rút ngắn EVL (ghi nhận, không làm).
- Cân nhắc sinh `rehearse-vowasia.sh` từ khung chung thay vì chép (ghi nhận cho B).

## 15. Execution strategy, Commit/PR

Strategy (theo `vc-agent-strategy-compare`):

| Pha | Chiến lược | Model |
|---|---|---|
| EXECUTE A | Tuần tự, MỘT agent `vc-execute-agent` (file gắn chặt: sql ↔ reader ↔ config ↔ probe) | opus |
| EVL A | MỘT `vc-tester` chạy lại gate (tuần tự) | sonnet |
| Review an toàn SQL (G9) | `vc-code-reviewer` | sonnet |
| VALIDATE, UPDATE PROCESS, mọi pha khác | xem mục 17 | sonnet |

Commit (trên `claude/vowasia-launch`, không tạo nhánh khác; phân tách commit hạ tầng và tài liệu):

```
feat(vowasia-migrate): add read-only legacy discovery tooling (phase A)

Own copy under scripts/migrate/vowasia (no GTP file changed). Site id kind and
tables come from an overlay; keyset cursor keeps microseconds; reader dedups and
refuses a cursor that does not advance. Owner-run SQL for a vowasia-only
read-only role (schema + views) and its removal. Adds 3 package.json scripts.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012Go8QC9xRBoKkhqh4Y19s5
```

Rồi `git push -u origin claude/vowasia-launch`, mở PR NHÁP (thân PR kết thúc bằng dòng "Generated with Claude Code" + liên kết phiên theo hướng dẫn attribution). Không bao giờ in/commit token; không đụng `~/gtp-private`.

## 16. Dependencies

A không phụ thuộc gì ngoài `main` @ `fe88bc4` (đã gồm `central-db-name-guard`, `vowasia-taxonomy`, tooling GTP) và PG16 native cho G6/G11. B phụ thuộc: A xanh, discover thật, quyết định C3/C8/C10/host ảnh, A1 xác nhận, tenant + taxonomy + token đọc + (nếu cần) engine record do chủ tạo tay.

## Resume and Execution Handoff (mục 17)

1. Plan này; trạng thái: PVL cycle 1 (S1-S8) và cycle 2 (T1-T7) đã áp dụng vào thân plan; Validate Contract hiện là bản vòng 2 (CONDITIONAL, `Accepted by` CHƯA có), cần validate-agent ghi lại. Chưa EXECUTE.
2. Pha kế: VALIDATE (xem khuyến nghị bên dưới), sau đó chủ nói "ENTER EXECUTE MODE" cho **Giai đoạn A** (khuyến nghị duy nhất).
3. EXECUTE phải nhận đúng một đường dẫn plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`.
4. Ngữ cảnh cần đọc: `process/context/all-context.md`, `tests/all-tests.md`, `scripts/migrate/GTP-LEGACY.md`, `scripts/lib/vowasia-taxonomy.ts`, `scripts/lib/central-db-name-guard.ts`, và các file GTP được dùng làm mô hình (đọc, không sửa).
5. Thứ tự checklist A: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 11b → 12 → 13 → 14. Sau khi A xong dừng, chờ O1-O6.
6. Mặc định đã chốt trong plan (chủ có thể đổi trước EXECUTE): chép riêng `args.ts`+`out-dir.ts` (O-Q1); phương án role 2, chốt sau khi chủ chạy `01` (O-Q2); allow-list `articles`+`sites` (O-Q3); `rehearse:gtp` không bắt buộc sau A, chạy một lần ở EVL cuối chương trình sau B (O-Q5). Run-id/`--resume` là quy tắc cứng của chủ (mỗi `--apply` run-id mới, không `--resume` run cũ), không còn là câu hỏi. Ghi mặc định đã dùng vào report.
7. Validator khi bàn giao: `node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs <đường dẫn plan>`.
8. Nếu mất ngữ cảnh: đọc mục 2-4, 6A và 12.

### Execute-agent instructions (E1-E8, từ Validate Contract)

- E1: làm T1 (bước 6) trước mọi thứ khác ở bước đó; test (a)/(b) phải ĐỎ trước khi sửa `repoRoot()` (red-first).
- E2: G7b lọc dòng thêm bằng `grep -E '^\+[^+]'` (loại `+++`); đúng 3 dòng, mọi dòng chứa `vowasia`.
- E3: `VOWASIA-LEGACY.md` và comment trong `lib/*.ts` không chứa `postgres://` hay `postgresql://` (dùng "URL kết nối" hoặc mẫu không có scheme); chỉ test/probe được phép.
- E4: chốt chặn con trỏ CHỈ kiểm: (i) toàn bộ bộ con trỏ bằng nhau => ném lỗi; (ii) trang chỉ chứa khoá đã thấy => ném lỗi. KHÔNG so "nhỏ hơn" trên chuỗi timestamptz-text (offset/định dạng không so được theo từ điển); thứ tự đúng dựa vào ORDER BY của DB.
- E5: probe: kiểm cổng 54336 trống trước khi bật; `mktemp -d` + `trap` dọn PG tạm và thư mục; không chạy song song gate nào khác (HS6); không `npm ci` song song.
- E6: probe không in mật khẩu fixture; mật khẩu sinh trong probe, không nằm trong `sql/*`.
- E7: ghi vào report EXECUTE các mặc định đã dùng (O-Q1, O-Q2, O-Q3, O-Q5) và kết quả từng cổng G1-G10, G7b, G7c, G13; G12 ghi là Known-Gap.
- E8: không sửa file GTP, không sửa `docs/` hay `process/context/` ở A (để UPDATE PROCESS), không chạm `~/gtp-private`.

## 18. Khuyến nghị `vc-agent-strategy-compare` cho pha VALIDATE

Điểm 7 tín hiệu: S2 (bề mặt quyền/DB, DDL role) có, S6 (lớp rủi ro cao: trust-boundary/permission/secret) có, S7 (5+ file) có; S1, S3, S4, S5 không. **Điểm 3/7 = MEDIUM** => khuyến nghị **parallel subagents** (3 agent, độc lập, đọc-chỉ, không cần giao tiếp giữa chừng; model **sonnet**), mỗi agent một chiều:

1. An toàn SQL/quyền: builder đóng, lexer, file `sql/*`, phương án role, bí mật.
2. GTP-không-đổi + blast radius: pathspec diff, `package.json`, glob test, ràng buộc 9.
3. Khả thi kiểm thử: probe PG16 native, keyset, G11, xung đột tài nguyên giữa các gate.

Phương án khác đã so: tuần tự (rẻ nhất, chậm hơn), workflow (thừa cho 3 chiều đọc-chỉ), agent team (không cần: ba chiều không phải phối hợp blast radius). Chi phí ước tính: 3 agent ≈ 3 lượt đọc plan + file mô hình (dưới ngưỡng 30). EXECUTE A: tuần tự một agent opus.

## Validate Contract

Status: CONDITIONAL
Date: 16-10-26
date: 2026-10-16
generated-by: outer-pvl
supersedes: 2026-10-16 (outer-pvl) — vòng 2 có bằng chứng hiện hành sau PVL supplement S1-S8 (cycle 1)
Ghi chú PVL cycle 2 (16-10-26): T1-T7 đã được áp dụng vào thân plan (checklist 2/6/9/10/11b, Touchpoints 26 file + backlog, Blast Radius, Verification Evidence G7b/G13, Phase Completion Rules, HC9, HS1, Risks, §5.4, Giai đoạn B, mục Execute-agent instructions E1-E8). Contract bên dưới là bản vòng 2 và ĐÃ LỖI THỜI ở các điểm: "23/25 file" (nay 26 file mới dưới `scripts/migrate/vowasia/` + 1 backlog), "G1-G11", "bước tạo backlog nằm ở T4". Validate-agent phải ghi lại contract ở vòng sau.

Parallel strategy: sequential
Rationale: score 3/7 (S2 bề mặt quyền/DB, S6 lớp rủi ro cao trust-boundary/secret, S7 5+ file) khuyến nghị parallel-subagents, nhưng phiên VALIDATE này không có công cụ spawn subagent nên 4 chiều Layer 1 + Layer 2 theo section được chạy TUẦN TỰ bởi một agent (chỉ đọc), giống vòng 1. Hạn chế: không có "mắt thứ hai" độc lập; bù bằng đối chiếu trực tiếp mã main @ fe88bc4, mô phỏng thật các cổng G7c/G8/G10 trong repo git tạm, và đo lại baseline.

Bằng chứng vòng 2 (chỉ đọc, không DB, không rehearse:gtp, 16-10-26): `test:migrate-gtp` 69/69 pass; `test:single-home` 267/267 pass; `lint:migrate` 0 lỗi + 1 cảnh báo có sẵn (`seed-gtp-legacy-fixture.ts:179 't50sec'`); `tsc --noEmit` exit 0; `validate-plan-artifact.mjs` 0 FAIL / 0 warning. Hiện tại: G8 exit 0, G7 rỗng, G7c exit 0 (cây sạch). PG16 native (`/usr/lib/postgresql/16/bin`), `runuser`, chạy root, không có listener 543xx. Cổng mô phỏng trong repo git tạm: G7c bắt file untracked ngoài `scripts/migrate/vowasia/` + `process/general-plans/` (exit 1) trong khi G8 mù với file đó (exit 0) và bắt sửa file tracked (exit 1); G10 (cả ba mẫu) dương/âm đúng, `created_at`/`updated_at`/dòng `--` không khớp nhầm.

Kết quả kiểm lại S1-S8 (đọc TOÀN file 485 dòng): S1 ĐÃ XỬ LÝ ĐÚNG (không còn "cùng run-id" hay `--resume` mâu thuẫn: HC4 L74, mục 2 câu 4 L64, bảng Importer L196, Rollback L197, rehearsal "lần 2" L202, runbook L204, O9 L331, Resume #6 L378 đều theo nguyên văn quy tắc chủ; mọi lần nhắc `--resume` còn lại đều là câu CẤM). S2 ĐÚNG (G7c L312, mô phỏng đỏ/xanh). S3 ĐÚNG (checklist 10 có phần role; AC-A8 Hybrid). S4 ĐÚNG (§5.4 hardening + 03 có `DROP OWNED BY`). S5 ĐÚNG (G10 dạng `! grep`, đã mô phỏng). S6 ĐÚNG về nội dung (8 builder, `columnRoles`, giới hạn IDENT + thông báo cố định). S7 ĐÚNG VỀ QUYẾT ĐỊNH nhưng PHÁT SINH BẪY MỚI (T1 dưới đây). S8 ĐÚNG MỘT PHẦN: `cli-common.ts:55-59`, 267 đúng; số file "23" SAI (T3). Nhãn "ĐÃ ÁP DỤNG" của planner chỉ nằm trong contract cũ (nay được thay) và nhãn truy vết `(S1)/(S4)/(S6)/(S7)` trong thân plan là vô hại; câu nói S1-S8 "còn mở" ở thân plan: không còn (chỉ Status L11 và Resume #1 nói "chờ validate lại", đã cập nhật cùng lượt này).

Spot-check trích dẫn tooling GTP (14/14 khớp main @ fe88bc4): `cli-common.ts:55-59` (`IMPORT_TENANT`, `assertImportTenant`), `cli-common.ts:63-77` `openLegacy` gọi `assertGtpSite`; `legacy-reader.ts:171` `assertGtpSite` (slug phải `gtp`); `legacy-reader.ts:79-92` `pages()` chỉ dừng khi `rows.length < pageSize` và `cursorOf` (không khử trùng, không chốt chặn); `legacy-sql.ts:38-53` `ALLOWED_TABLES` đúng 9 bảng; `:73` `UUID`; `:275-283` `cursorOf` cắt micro-giây (`c.toISOString()` L281); 8 builder tồn tại (`:224-267`) + `siteAuthorsRows:270` (không cần cho A); marker `legacy:globaltravelpost` ở đúng 4 nơi (`import-gtp-main.ts:61`, `verify-main.ts:32`, `rollback-main.ts:30`, `gtp-timestamps.ts:14`); `slug-plan.ts:18` `DEFAULT_RESERVED_SLUGS`; `db-banner.ts` `LEGACY_GTP_DB_URL`; `urls.gonePaths` ở `gtp-mapping.ts:185` + `gtp-redirects.ts`; `gtp-author-distribution.ts` (chia đều pool, không fallback "GTP Newsroom"); `fixtures/gtp-legacy/schema.sql` L165-178 (tiền lệ `ALTER ROLE ... SET`); `scripts/lib/central-db-name-guard.ts:67` `assertCentralDbName(url, target)` và `local-db-guard.ts:96` `assertLocalOrConfirmed`.

Xác nhận Giai đoạn A: không đụng file GTP nào; chỉ 25 file MỚI dưới `scripts/migrate/vowasia/` (đếm lại từ bảng Touchpoints: 21 file gốc + `args.ts`, `out-dir.ts` + 2 test) + 1 file backlog + thư mục plan + ĐÚNG 3 dòng `package.json`. Glob GTP `scripts/migrate/lib/*.test.ts` một cấp không nhặt test vowasia; `tsc` (`include **/*.ts`) và `lint:migrate` (`eslint scripts/migrate`) phủ file mới; `.gitignore:43` đã có `/scripts/migrate/out/`; `pg` + `@types/pg` có sẵn trong `node_modules` (phụ thuộc bắc cầu, giống GTP).

Test gates (C3 5-column table):

| criterion id | behavior | strategy | proving test | gap-resolution |
|---|---|---|---|---|
| AC-A1 | Không file GTP đổi; chỉ `package.json` + 3 dòng vowasia; không file untracked lạ | Fully-Automated | G7 + G7b + G8 + G7c (đã mô phỏng: G7c bắt untracked, G8 mù) | B |
| AC-A2 | Mọi SQL phát ra là SELECT một bảng allow-list có vị từ site cố định; corpus tấn công bị từ chối | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-sql.test.ts) | B |
| AC-A3 | Site id `uuid`/`integer`/`text-safe` kiểm đúng kiểu; cột/bảng/vai cột theo overlay; IDENT hoa/camelCase bị từ chối | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-sql.test.ts, vowasia-config.test.ts) | B |
| AC-A4 | Keyset không mất/trùng (cùng ms khác µs, created_at y hệt, NULL, 1970) trên PG16 thật | Hybrid | `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` (precond: PG16 native, runuser, cổng 54336) | B |
| AC-A5 | Khử trùng theo khoá; con trỏ không tiến thì ném lỗi | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-reader.test.ts) | B |
| AC-A6 | Discover chỉ SELECT có vị từ site; báo cáo vào thư mục git-ignored 700/600; stdout/stderr/báo cáo không chứa id site, mật khẩu, body | Hybrid | keyset-probe.sh (query-log + grep đầu ra, xem T6) + vowasia-db-banner.test.ts + out-dir test | B |
| AC-A7 | Marker `legacy:vowasia` khác GTP, không chứa `globaltravelpost` | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-constants.test.ts) | B |
| AC-A8 | SQL role/view: chỉ đọc đúng site, bảng gốc bị từ chối, không ghi được, RLS/policy/grant bảng gốc không đổi, dọn sạch được | Hybrid | probe PG16 áp 02/03 trên fixture cục bộ + G9 (Agent-Probe, bổ sung) + G10 | B |
| AC-A9 | Tooling chạy đúng trên DB cũ THẬT | Hybrid (precondition: chủ chạy O2-O5 trên DB thật; KHÔNG chạy được trong chu kỳ này) | G12: discover thật do chủ chạy | D (backlog stub bắt buộc; residual có tên, KHÔNG phải bằng chứng PASS; xem T4) |
| AC-A10 | GTP vẫn xanh | Fully-Automated | G4 (69), G5 (267), G2, G3; G11 chỉ nếu chủ yêu cầu (O-Q5) | A |

Failing stub (Fully-Automated; dán nguyên văn làm điểm đỏ đầu tiên cho EXECUTE):

- AC-A1: `test("should leave every GTP file byte-identical and create no untracked file outside vowasia", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should leave every GTP file byte-identical and create no untracked file outside vowasia") })`
- AC-A2: `test("should refuse any statement that is not a site-scoped SELECT on an allow-listed table", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should refuse any statement that is not a site-scoped SELECT on an allow-listed table") })`
- AC-A3: `test("should validate site id per siteIdKind and read column roles from the overlay", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should validate site id per siteIdKind and read column roles from the overlay") })`
- AC-A5: `test("should dedup by key and throw when the keyset cursor does not advance", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should dedup by key and throw when the keyset cursor does not advance") })`
- AC-A7: `test("should use marker legacy:vowasia that differs from GTP and never contains globaltravelpost", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should use marker legacy:vowasia that differs from GTP and never contains globaltravelpost") })`
- AC-A10: `test("should keep GTP suites green (test:migrate-gtp 69, test:single-home 267, lint 0 errors, typecheck 0)", () => { throw new Error("NOT IMPLEMENTED — TDD stub: should keep GTP suites green") })`

Legacy line form:
- Giai đoạn A tooling: [Fully-automated: `npm run test:migrate-vowasia`] | [hybrid: `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` + PG16 native] | [agent-probe: G9 review SQL, bổ sung cho hybrid] | [known-gap: AC-A9 DB cũ thật, documented, backlog `vowasia-real-db-validation_NOTE_16-10-26.md`]
- GTP không đổi: [Fully-automated: G4, G5, G2, G3, G7, G7b, G7c, G8] | [hybrid: G11 `rehearse:gtp`, chỉ khi chủ yêu cầu]

Dimension findings:
- Infra fit: CONCERN. Môi trường khả thi (PG16 native, runuser, cổng 54336 trống, baseline xanh, `pg` có sẵn). Bẫy mới (T1): bản CHÉP `out-dir.ts` vào `scripts/migrate/vowasia/lib/` có `repoRoot()` lùi 3 cấp, đúng với `scripts/migrate/lib/` nhưng ở thư mục mới trỏ về `scripts/` (thiếu 1 cấp) nên cổng "thư mục trong repo phải git-ignored" coi mọi thư mục trong repo ngoài `scripts/` là "ngoài repo" (bypass im lặng), và test copy kiểu GTP vẫn xanh vì chỉ thử dưới `scripts/migrate`.
- Test coverage: CONCERN. S2/S3/S5 đã đóng (mô phỏng G7c/G10; AC-A8 Hybrid). Còn: `vowasia-cli.ts` (mã thoát 2/1/0, thông báo cố định) không có test; AC-A6 nói "grep đầu ra" nhưng checklist 10 không có bước khẳng định stdout/stderr/báo cáo không chứa id site/mật khẩu/body; file `legacy-source.vowasia.json` và overlay fixture chưa được test parse bằng zod (T6); bước tạo backlog stub Known-Gap AC-A9 có trong Touchpoints nhưng KHÔNG có trong Checklist A (T4). Known-Gap AC-A9 có tên + stub, không vacuous-green; mọi hành vi đã phát triển còn lại có cổng tự động hoặc Hybrid.
- Breaking changes: PASS. Chỉ file mới + 3 dòng script; không đổi `src/`, API, schema, migration, context/docs.
- Security surface: CONCERN. Hàng rào thật (role/view, `security_barrier`, `NOBYPASSRLS`, `default_transaction_read_only`, `DROP OWNED BY`) đã đúng hướng sau S4. Còn: T1 (guard out-dir, repo CÔNG KHAI) và T5 (file `02` có truy vấn tự kiểm nhưng chưa quy định phải làm gì khi nó báo `true`/≠1 dòng).
- Section 2 Owner Decisions: PASS (B3, B4, C1, C2, C4-C7, C9 khớp; C3/C8/C10/A1/host ảnh nhận qua cấu hình, không hard-code, không tên tác giả chung).
- Section 3 Hard Constraints: CONCERN. HC4 đã ĐÚNG quy tắc chủ (S1 đóng). HC1/checklist 9 nói "DDL DUY NHẤT trong cả plan" và HS1 cấm "chạy bất kỳ DDL nào ngoài file SQL mẫu do chủ chạy", trong khi probe (checklist 10) chạy DDL trên PG16 tạm cục bộ: cần ghi rõ phạm vi "DB cũ / không-local" (T5). HC9 yêu cầu `rehearse:gtp` xanh nhưng O-Q5 nói không bắt buộc sau A (đã có G8+G7c thay thế; thống nhất ở T2).
- Section 5.2/5.3/5.5 + Checklist A 1-14: CONCERN (T1, T4, T6). Nội dung kỹ thuật keyset/`__cursor_ts`/siteIdKind/columnRoles khả thi: template được dựng lại từ args nên thêm cột `__cursor_ts` không phá `assertSafeQuery`.
- Section 5.4 + sql/*: CONCERN (T5 duy nhất); thứ tự `DROP SCHEMA ... CASCADE; DROP OWNED BY; DROP ROLE` đúng; ghi chú không `REVOKE FROM PUBLIC` và role cấp cụm đúng.
- Phase Completion Rules / Blast Radius / Verification Evidence: CONCERN (T2, T3). "G1-G11 xanh" mâu thuẫn với G11 tuỳ chọn; Blast Radius ghi 23 file, Touchpoints đếm 25.
- Giai đoạn B (phác thảo): CONCERN-nhẹ (T7), KHÔNG chặn A. Quy tắc chủ đã đúng; còn 3 điểm thiết kế mơ hồ cần amendment B (xem T7).
- §4 Xác minh tooling: PASS (14/14 trích dẫn khớp, danh sách ở trên).
- Public Contracts: PASS (CLI `--mapping-overlay/--site-id/--out/--sample/--schema`, mã thoát 0/1/2, artefact git-ignored).

Plan updates required (PVL supplement vòng 2; text-only, không đổi phạm vi; SUPPLEMENT REQUEST):
- T1 (SEC, nên làm trước EXECUTE): Checklist bước 6 + Touchpoints: khi CHÉP `out-dir.ts`, `repoRoot()` phải lùi 4 cấp (`scripts/migrate/vowasia/lib` -> root), đổi comment đầu file từ "GTP legacy migration tools" sang trung tính, và `out-dir.test.ts` bản vowasia PHẢI có: (a) `repoRoot()` là thư mục chứa `package.json` và `.git`; (b) `assertOutDirSafe(path.join(repoRoot(),"process","vowasia-guard-probe"))` ném `notIgnored` TRƯỚC khi tạo thư mục (chứng minh guard phủ cả ngoài `scripts/`); (c) thư mục dưới `scripts/migrate/out/` được chấp nhận (mode 700). Chấp nhận thay thế: chủ chọn IMPORT thay vì chép (O-Q1) thì T1 biến mất nhưng phải thêm test chống drift.
- T2: Sửa "Phase Completion Rules" thành: `CODE DONE` khi G1-G10 + G7b + G7c xanh tại EVL (G11 chỉ khi chủ yêu cầu, O-Q5); sửa HC9 thành "GTP không đổi được chứng minh bằng G4, G5, G2, G3, G7, G7b, G7c, G8; `rehearse:gtp` chạy một lần ở EVL cuối chương trình sau B hoặc khi chủ yêu cầu".
- T3: Sửa Blast Radius "23 file mới" thành "25 file mới dưới `scripts/migrate/vowasia/` (21 file gốc + `args.ts`, `out-dir.ts` + 2 test của chúng)".
- T4: Thêm bước vào Checklist A (sau bước 11, trước `package.json`): tạo `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (nội dung: kết quả O2-O5 cần thu về, tiêu chí nhận AC-A9, ai chạy, hạn); thêm cổng "file tồn tại" vào Verification Evidence; ghi vào report EXECUTE. (Known-Gap AC-A9 không hợp lệ nếu stub không tồn tại.)
- T5: (a) Trong `02`: nếu truy vấn tự kiểm trả `true` cho bất kỳ quyền nào của role trên `public`, hoặc view `sites` không đúng 1 dòng slug `vowasia` => DỪNG (HS5): không dùng role, chạy `03` để dọn, báo chủ; nêu nguyên nhân thường gặp (PUBLIC có quyền, PG ≤14 CREATE trên `public`). (b) HS1 và bước 9: thay "DDL DUY NHẤT trong cả plan" bằng "DDL duy nhất trên DB CŨ; probe chạy DDL chỉ trên PG16 tạm cục bộ do chính nó dựng và dọn".
- T6: (a) Checklist 6: thêm test cho `vowasia-cli.ts` (`runMain`: mã thoát 0 thành công, 2 cho từ chối có thông báo cố định, 1 cho lỗi khác; thông báo không chứa URL/mật khẩu). (b) Checklist 10: thêm khẳng định stdout/stderr/`legacy-schema-report.md`/`query-log.json` KHÔNG chứa giá trị site id, mật khẩu của role fixture, hay đoạn body mẫu; quyền thư mục out 700 / file 600. (c) Checklist 2: `vowasia-config.test.ts` parse `legacy-source.vowasia.json` (phải qua zod, không chứa `TODO`) và `fixtures/overlay.fixture.json`; nêu rõ schema A có chấp nhận khoá `media` (khuyến nghị: khai báo tuỳ chọn, validate hình dạng, bỏ qua trong A) để overlay chủ viết một lần dùng được cho cả A lẫn B.
- T7 (đưa vào backlog/Open gaps của B, KHÔNG chặn A): bản amendment B phải chốt (i) "ghi run-id lên từng bài" nghĩa là journal theo run dưới thư mục out (mô hình GTP: `slug-map.ndjson`, `createdAtRun`), KHÔNG thêm trường vào `Articles` (không đổi schema); (ii) thứ tự chọn `--limit 50` phải tất định (ví dụ (created_at, id) trên tập đã lọc), và kế hoạch slug/tác giả tính trên TOÀN tập mỗi run; (iii) hành vi với bài marker do run khác tạo: GTP "không nhận nuôi" (A13-R05), plan nói "bỏ qua" => phải định nghĩa rõ (bỏ qua theo legacy id có trong Central, vẫn tính trong kế hoạch tác giả/slug).

Execute-agent instructions (viết vào contract; không cần sửa plan):
- E1: Thực hiện T1 trước mọi thứ khác ở bước 6; test (b) phải đỏ trước khi sửa `repoRoot()` (red-first).
- E2: G7b: lọc dòng thêm bằng `grep -E '^\+[^+]'` (loại dòng tiêu đề `+++`), mọi dòng thêm phải chứa `vowasia`; đúng 3 dòng.
- E3: G10c: `VOWASIA-LEGACY.md` và comment trong `lib/*.ts` KHÔNG chứa chuỗi `postgres://` hay `postgresql://` (dùng "URL kết nối" hoặc mẫu không có scheme); chỉ test/probe được phép.
- E4: Chốt chặn con trỏ: KHÔNG so sánh "nhỏ hơn" trên chuỗi timestamptz-text (offset/định dạng không so được theo từ điển). Dùng: (i) bằng nhau toàn bộ bộ con trỏ => ném lỗi; (ii) trang chỉ chứa khoá đã thấy => ném lỗi; thứ tự sai dựa vào ORDER BY của DB.
- E5: Probe/rehearsal: kiểm cổng 54336 trống trước khi bật; `mktemp -d` + `trap` dọn PG tạm và thư mục; không chạy song song với bất kỳ gate nào khác (HS6); không `npm ci` song song.
- E6: Probe không in mật khẩu fixture; mật khẩu sinh trong probe, không nằm trong `sql/*`.
- E7: Ghi vào report EXECUTE các mặc định đã dùng (O-Q1, O-Q2, O-Q3, O-Q5) và kết quả từng cổng G1-G10 (+G7b, G7c); G12 ghi là Known-Gap.
- E8: Giữ nguyên: không sửa file GTP, không sửa `docs/`/`process/context/` ở A (cập nhật context để UPDATE PROCESS), không chạm `~/gtp-private`.

Câu hỏi cho chủ (chỉ những câu thật sự cần chủ ở thời điểm này):
- Q-A: Chấp nhận CONDITIONAL này (Known-Gap AC-A9 + gap T1-T7) để ENTER EXECUTE Giai đoạn A, hay chạy thêm MỘT vòng PVL supplement (T1-T6 là sửa chữ, dự kiến đủ để lên PASS về chất lượng, nhưng AC-A9 vẫn là Known-Gap nên cổng A -> B vẫn CONDITIONAL).
- Q-B (= O-Q1): giữ MẶC ĐỊNH chép riêng `args.ts`/`out-dir.ts` (cần T1) hay đổi sang import từ `scripts/migrate/lib/` (không có bẫy T1 nhưng ràng buộc với file GTP, thêm test chống drift).
- Q-C (= O-Q5): `rehearse:gtp` (~60 phút) KHÔNG chạy sau A (G8 + G7c thay thế), chạy một lần ở EVL cuối chương trình sau B; chủ có muốn chạy ngay sau A không.
- (Không phải câu hỏi lúc này) O-Q2 phương án role: chốt sau khi chủ chạy `01`; O-Q3 allow-list mặc định `articles`+`sites`; C3/C8/C10/A1/host ảnh: sau discover (HS7).

Open gaps: AC-A9 (DB cũ thật): known-gap: documented, backlog `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (cổng A -> B giữ CONDITIONAL tới khi discover thật xanh; hiện stub CHƯA tồn tại, bước tạo nó nằm ở T4). Gap GTP (keyset cắt µs + `pages()` không khử trùng) chỉ ghi, chủ quyết riêng. C3/C8/C10/A1/host ảnh: chờ chủ sau discover (HS7). T1-T7 ở trên.

What this coverage does NOT prove:
- G1 (`test:migrate-vowasia`): không chứng minh hành vi trên PG thật, không chứng minh quyền role, không chứng minh schema/RLS thật của DB cũ.
- G6 keyset-probe: chỉ dữ liệu giả, 1 máy PG16 cục bộ; không chứng minh múi giờ/DateStyle/kiểu `created_at` của DB cũ thật (có thể là `timestamp` không múi giờ, hoặc cột tên khác); không thực thi nhánh PG ≤ 14 (PUBLIC có `CREATE` trên schema `public`); không phủ phương án 1 (RLS, `02b` chỉ kiểm cú pháp).
- G7/G7b/G7c/G8/G4/G5: chứng minh GTP không đổi byte và test GTP xanh; không chứng minh `rehearse:gtp` end-to-end (G11 tuỳ chủ).
- G9/G10: review + grep không thay cho áp SQL thật; SQL chạy trên DB cũ là DDL duy nhất trên DB cũ và do chủ chạy; G10 dựa trên regex nên không bắt lệnh nguy hiểm viết lạ (G9 là lớp bổ sung).
- Toàn bộ Giai đoạn A: không chứng minh bất kỳ hành vi import/rollback/redirect nào (Giai đoạn B mới phác thảo, chưa thực thi).
- Không chứng minh tenant `vowasia` + taxonomy đã tồn tại trên production (A1/O1 chủ chạy).

Gate: CONDITIONAL (0 FAIL, 7 CONCERN T1-T7; S1-S8 đã được xử lý đúng ngoại trừ phần dư S7/S8; Giai đoạn A khả thi cơ học, không đụng GTP; Known-Gap AC-A9 là residual có tên, không phải PASS)
Accepted by: CHƯA được chủ chấp nhận. Cycle PVL đã ghi nhận: 1 (S1-S8). Cần: chủ chấp nhận rõ bằng tên các gap (AC-A9, T1-T7) hoặc một vòng supplement cycle 2 (T1-T6) rồi validate lại. Không phải chấp nhận tự động.

## Autonomous Goal Block

SESSION GOAL: VowAsia legacy migration, Giai đoạn A (công cụ đọc/discover bản riêng, không file GTP đổi).
Charter + umbrella plan: N/A — single plan (không có `## Stable Program Goal` trên đĩa).
Autonomy: chỉ chạy sau khi Gate PASS hoặc CONDITIONAL đã được chủ chấp nhận (hiện CHƯA chấp nhận) và theo Execute-agent instructions E1-E8 trong Validate Contract; EXECUTE = 1 agent opus tuần tự; EVL do `vc-tester` chạy lại độc lập.
Hard stops: HS1 ghi DB cũ/DDL ngoài SQL mẫu chủ chạy; HS2 sửa file GTP hoặc ngoài Touchpoints; HS3 banner DB không phải /neondb ở lệnh Central có --apply; HS4 phát hiện bí mật; HS5 phương án role có thể hại site cũ; HS6 không dọn tiến trình/DB tạm; HS7 làm Giai đoạn B khi chưa có discover + quyết định; quy tắc chủ: importer chỉ tạo mới, không tạo tác giả, rollback theo run, mỗi lần `--apply` run-id mới, không --resume run cũ.
Next phase: (1) re-validate (cycle 2 supplement đã áp dụng) bằng vc-validate-agent, HOẶC (2) chủ chấp nhận CONDITIONAL bằng tên gap (AC-A9, T1-T7) rồi EXECUTE Giai đoạn A: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
Validate contract: inline in plan (## Validate Contract).
Execute start: `npm run test:migrate-vowasia` | `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` | G9 review SQL | high-risk pack: yes (quyền/role, trust-boundary).
