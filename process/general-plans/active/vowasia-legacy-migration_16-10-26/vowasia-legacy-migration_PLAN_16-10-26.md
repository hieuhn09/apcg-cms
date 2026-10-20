---
name: plan:vowasia-legacy-migration
description: "Chuyển bài viết VowAsia từ DB Postgres cũ (dùng chung với GTP) sang Central tenant vowasia: tooling bản riêng, chia Giai đoạn A (đọc/discover, làm ngay) và B (import, sau discover)"
date: 16-10-26
feature: vowasia-launch (lưu ở general-plans; repo này không có process/features)
---

# VowAsia legacy migration — PLAN (COMPLEX, 2 giai đoạn)

Date: 16-10-26
Status: PLANNED (chưa EXECUTE). PVL cycle 1 (S1-S8) và cycle 2 (T1-T7) đã áp dụng; validate pass 3 (16-10-26) đã ghi lại `## Validate Contract` (Gate PASS cho EXECUTE Giai đoạn A; AC-A9 là Known-Gap có tên giữ cổng A -> B ở CONDITIONAL). Amendment 1 (16-10-26, chủ duyệt phạm vi: đường SQL Editor của Supabase, +3 file SQL, xem `## Owner-approved scope amendment 1 (16-10-26)`) KHÔNG được validate lại bằng vòng PVL đầy đủ; phủ bằng EVL độc lập + G9.

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

1. Chủ chạy mọi lệnh GHI lên production và mọi lệnh ĐỌC DB cũ. Plan/agent không giữ, không xin bí mật. Không bảo chủ dán/chụp bí mật: dùng `read -s`; mật khẩu mới dùng `openssl rand -hex 24 | pbcopy` (hex, không base64: base64 có thể sinh `+` hoặc `/` làm vỡ URL); nhắc `clear` trước khi chụp màn hình. `LEGACY_VOWASIA_DB_URL` chỉ đọc từ biến môi trường, không bao giờ qua argv.
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
- HS5 (ngoại lệ duy nhất: Amendment 2, đúng hai quan hệ `net._http_response` và `net.http_request_queue` của Supabase pg_net, khớp chính xác schema+tên+relkind `r`): kết quả SQL đọc cho thấy phương án role đã chọn có thể ảnh hưởng site cũ (ví dụ cần bật RLS mà role của site cũ không bypass) => không chạy, chủ quyết lại.
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
4. Reader (`pages()`): khử trùng theo khoá (Set các khoá đã thấy; trùng thì bỏ qua và đếm); chốt chặn con trỏ CHỈ kiểm (i) toàn bộ bộ con trỏ mới bằng bộ con trỏ cũ, hoặc (ii) trang chỉ chứa khoá đã thấy; một trong hai thì ném `legacy: keyset cursor did not advance; refusing.` (KHÔNG so "nhỏ hơn" trên chuỗi timestamptz-text, xem E4); cột `__cursor_ts` bị gỡ khỏi dòng trả ra.
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
6. Tạo `lib/args.ts` và `lib/out-dir.ts` (CHÉP RIÊNG từ bản GTP, ~150 dòng, S7; không import file GTP). **T1 (bảo mật, làm TRƯỚC mọi thứ khác ở bước này, red-first):** viết `out-dir.test.ts` trước, gồm (a) `repoRoot()` là thư mục chứa cả `package.json` và `.git`; (b) `assertOutDirSafe(<đường dẫn thật tới process/vowasia-guard-probe>)` ném `notIgnored` TRƯỚC khi tạo thư mục (khẳng định thư mục không tồn tại sau khi ném); đường dẫn PHẢI dựng ĐỘC LẬP với `repoRoot()`, ví dụ `path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..", "process", "vowasia-guard-probe")` (KHÔNG dùng `path.join(repoRoot(), ...)`: đã mô phỏng 16-10-26, với bản lỗi 3 cấp dạng đó vẫn XANH nhầm vì thư mục lúc đó nằm trong "gốc" sai nên guard vẫn chạy); (c) thư mục dưới `scripts/migrate/out/` được chấp nhận (mode 700). Chạy và xác nhận (a), (b) và (c) ĐỎ với bản chép nguyên (mô phỏng: bản 3 cấp làm (a), (c) và (b)-độc-lập đỏ, và (b) còn THỰC SỰ tạo `<repo>/process/...` vì guard bị bỏ qua) (bản GTP có `repoRoot()` lùi 3 cấp; ở `scripts/migrate/vowasia/lib/` phải 4 cấp, nên bản chép trỏ về `<repo>/scripts`, thư mục trong repo ngoài `scripts/` bị coi là "ngoài repo" và bỏ qua kiểm git-ignore; repo này công khai). Sau đó sửa: `repoRoot()` lùi 4 cấp (`scripts/migrate/vowasia/lib` -> gốc repo) và đổi comment đầu file từ "GTP" sang trung tính; test xanh. Kèm `args.test.ts` ngắn. Rồi `lib/vowasia-cli.ts` (parse cờ, `runMain` lỗi cố định, exit 2 cho từ chối) kèm `lib/vowasia-cli.test.ts` (T6a): `runMain` trả mã 0 khi thành công, 2 cho từ chối có chủ đích với thông báo cố định, 1 cho lỗi khác; thông báo không chứa URL hay mật khẩu. Nếu chủ đổi sang import (O-Q1): T1 biến mất, thêm test chống drift thay cho bản chép.
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
| AC-A10 | GTP vẫn xanh | G4, G5, G2, G3 (G11 chỉ khi chủ yêu cầu, O-Q5) | Fully-Automated (+ Hybrid nếu chạy G11) |

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
| `sql/01e-inspect-single-result.sql` | mới (amendment 1) | owner-run trong SQL Editor; một câu SELECT duy nhất (UNION ALL) |
| `sql/02p-set-password.sql.template` | mới (amendment 1) | owner-run; SQL tự sinh mật khẩu rồi `EXECUTE format(... PASSWORD %L ...)`, chỉ sau khi 02 báo SELF-CHECK OK |
| `sql/03e-drop-in-editor.sql.template` | mới (amendment 1) | owner-run trong SQL Editor; bản của 03, placeholder `__LEGACY_DB_NAME__` |
| `VOWASIA-LEGACY.md` | mới | hướng dẫn chủ (amendment 1: thêm phần "Cách B: SQL Editor của Supabase") |
| `lib/vowasia-db-banner.ts` (+ test) | đã liệt kê ở trên; amendment 1 mở rộng | chấp nhận tên đăng nhập pooler `vowasia_migrator.<mã-project>` |
| `package.json` | **sửa (chỉ thêm 3 dòng)** | `migrate:vowasia:discover`, `test:migrate-vowasia`, `probe:migrate-vowasia` |
| `process/general-plans/active/vowasia-legacy-migration_16-10-26/` | mới | plan này + report EXECUTE/EVL |
| `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` | mới | stub Known-Gap AC-A9 |

Chỉ `package.json` là file hiện có được phép đổi. Docs/context (`docs/12-migration.md`, `process/context/*`) KHÔNG sửa ở A; cập nhật ở UPDATE PROCESS sau, cần lệnh riêng.

## Public Contracts (mục 9)

- CLI: `npm run migrate:vowasia:discover -- [--mapping-overlay <path>] [--out <dir>] [--sample N] [--schema S]`; đọc `LEGACY_VOWASIA_DB_URL` (+ `LEGACY_VOWASIA_DB_SSL`, `LEGACY_VOWASIA_DB_CA`) từ môi trường; exit 0 thành công, 2 từ chối có chủ đích (thông báo cố định), 1 lỗi khác.
- Artefact: `scripts/migrate/out/vowasia/{legacy-schema-report.md, legacy-mapping.template.json, query-log.json}` (git-ignored, 700/600).
- Hằng số xuất cho B: `TENANT_SLUG`, `MARKER_SOURCE_NAME`, `MARKER_ORIGIN` (marker `legacy:vowasia`).
- Không đổi: API công khai/engine/hub, schema Payload, migration Payload, `src/**`.
- Bề mặt bảo mật: role `vowasia_migrator` + schema `vowasia_ro` trên DB CŨ (do chủ tạo/xoá). Không tạo secret trong repo.

## Blast Radius (mục 10)

- Chạm: 29 file mới dưới `scripts/migrate/vowasia/` (đếm từ bảng Touchpoints: 21 file gốc + `args.ts`, `out-dir.ts` + 3 test `args.test.ts`, `out-dir.test.ts`, `vowasia-cli.test.ts` = 26; amendment 1 thêm 3 file SQL `01e`, `02p`, `03e` = 29), 1 file backlog (`process/general-plans/backlog/`), thư mục plan, và 3 dòng `package.json` (không đổi). Tổng file mới ngoài thư mục task: 30.
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
| G10 (dạng `! grep`, rỗng = pass; ranh giới từ, bỏ dòng comment `--`): `! grep -vE "^\s*--" sql/01-*.sql \| grep -nEiw "(insert\|update\|delete\|truncate\|drop\|alter\|grant\|create)"` (ranh giới từ `-w` để `created_at`/`updated_at` không khớp nhầm); `! grep -HnEiw "password" sql/* | grep -vE "^sql/[^:]+:[0-9]+:[[:space:]]*--" | grep -vE "^sql/02p-set-password\.sql\.template:[0-9]+:[[:space:]]*EXECUTE format\('ALTER ROLE vowasia_migrator PASSWORD %L', pw\);$"` (chạy trong `scripts/migrate/vowasia`; danh sách trắng thay lệnh cũ `grep "password[[:space:]]+'"`, vốn mù với 4 biến thể và không còn chữ giữ chỗ `__PASSWORD__` sau Amendment 1 fix cycle: mọi dòng có chữ "password" đều bị bắt, trừ dòng comment `--` và đúng MỘT dòng `EXECUTE format(... PASSWORD %L, pw)` của `02p`. EVL PHẢI chứng minh cổng ĐỎ bằng 6 đột biến trên bản sao tạm NGOÀI repo: `PASSWORD '...'`, `E'...'`, `$$...$$`, PASSWORD rồi xuống dòng, giá trị viết sẵn thay `pw` trên dòng EXECUTE, thêm một `ALTER ROLE ... PASSWORD 'x'` sau dòng EXECUTE; và bản nguyên trạng XANH. Known-Gap: một bí mật viết sẵn KHÔNG chứa chữ "password" không bị bắt); `! grep -rnEi "postgres(ql)?://" scripts/migrate/vowasia --exclude="*.test.ts" --exclude="keyset-probe.*"` (`postgres://` hợp lệ trong test/probe vì là URL cục bộ giả; `VOWASIA-LEGACY.md` và comment trong `lib/*.ts` KHÔNG được chứa scheme này) | Fully-Automated | AC-A8, HS4 |
| G10a (amendment 1) `! grep -vE "^\s*--" sql/01e-*.sql \| grep -nEiw "(insert\|update\|delete\|truncate\|drop\|alter\|grant\|create)"` + khẳng định `01e` chỉ có MỘT câu (một dấu `;` kết thúc) và không meta-lệnh psql (không `\` ở ĐẦU dòng; `\_` trong `LIKE 'pg\_%'` là ký tự thoát LIKE, hợp lệ); probe G6 mở rộng chạy 01e trong giao dịch chỉ đọc bằng role không-superuser, trả đúng MỘT result set | Fully-Automated + Hybrid (PG16 cục bộ) | AC-A8 (mở rộng: 01e/02p/03e), AC-A6 (banner pooler) |
| G11 `npm run rehearse:gtp` — KHÔNG bắt buộc sau A (O-Q5; G8 + G7c đã chứng minh 0 byte GTP đổi); chạy MỘT lần, một mình, nền, timeout 7200000, `REHEARSE_MODE=native` ở EVL cuối chương trình sau B, hoặc sớm hơn nếu chủ yêu cầu | Hybrid | AC-A10 (ràng buộc 9) |
| G12 Discover trên DB cũ THẬT (chủ chạy O5) | **Known-Gap** (backlog stub; cổng A -> B CONDITIONAL) | AC-A9 |
| G13 `test -f process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (stub Known-Gap AC-A9 tồn tại; không có thì AC-A9 không hợp lệ) | Fully-Automated | AC-A9 (residual có tên) |

Ghi chú vận hành EVL: `vc-tester` chạy lại độc lập đúng các lệnh trên, tuần tự (G11 và G6 không chạy song song nhau hay song song `npm ci`). Mọi lệnh G1-G10 là đọc/ghi cục bộ trong cây làm việc.

## 13. Owner-Run Steps (danh sách; lời hướng dẫn đầy đủ nằm trong `VOWASIA-LEGACY.md` do EXECUTE A viết)

Giai đoạn A:

- O1: Kiểm A1 bằng lệnh ĐỌC: `npm run audit:add-vowasia-taxonomy` (dry run; in tên database trước; tenant có → xem 49 dòng `exists`/`create`; tenant thiếu → báo "not found"). Ghi kết quả (tenant có/không, taxonomy đã `--apply` chưa).
- O2: Chạy `sql/01-readonly-inspect.sql` trên DB cũ bằng role hiện có của chủ (không dán bí mật). Báo lại: tên bảng liên quan VowAsia, cờ RLS/policy, role hiện tại có `BYPASSRLS` không, kiểu `site_id`, giá trị site id của VowAsia (chỉ nếu chủ thấy an toàn khi chia sẻ qua kênh phù hợp).
- O3: Chọn phương án role (khuyên 2). Chạy `sql/02-create-readonly-role-views.sql.template` (sau khi tự điền placeholder), đặt mật khẩu: Cách A (psql) bằng `openssl rand -hex 24 | pbcopy` (hex, không base64: `+` hoặc `/` làm vỡ URL) + `\password vowasia_migrator`, rồi `clear`; Cách B (Editor) dùng `02p` tự sinh mật khẩu, chép từ ô kết quả.
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

## Owner-approved scope amendment 1 (16-10-26)

Status: phạm vi do chủ duyệt, ghi tại đây. `## Validate Contract` bên dưới và dòng `Gate: PASS` GIỮ NGUYÊN cho phạm vi ban đầu. Amendment này KHÔNG được validate lại bằng vòng PVL đầy đủ; nó được phủ bằng EVL độc lập (`vc-tester`) + G9 (`vc-code-reviewer`), theo tiền lệ GTP (`gtp-mapping-final_14-10-26`). Giới hạn nói thẳng: không có "mắt thứ hai" ở giai đoạn plan cho 3 file SQL mới và thay đổi banner; rủi ro đó chuyển sang EVL + G9.

**Lý do.** Chủ KHÔNG có mật khẩu `postgres` của project Supabase cũ (tên project `globaltravelpost`, chứa DB cũ của cả VowAsia lẫn GTP cùng schema `public`) và cấm đặt lại mật khẩu (có thể làm site cũ ngừng chạy). Đường `psql` bằng role quản trị vì vậy không đi được. Orchestrator khuyến nghị "Cách 1: chạy bằng SQL Editor của Supabase"; chủ trả lời "ok". Ghi trung thực: "ok" là câu trả lời ngắn cho phương án được khuyến nghị, là xác nhận chung, không duyệt từng chi tiết.

**Thêm vào phạm vi (đều dưới `scripts/migrate/vowasia/`):**

1. `sql/01e-inspect-single-result.sql`: bản của `01` để dán vào ô SQL Editor. Editor chỉ hiện kết quả CÂU CUỐI, nên toàn bộ nội dung `01` (mục 1 tới 6b, gồm 5a, 5c, 5d, 5e, 6b) gộp thành MỘT câu SELECT duy nhất, trả các hàng `(section, item, detail)` bằng `UNION ALL`. Chỉ SELECT, không meta-lệnh psql, không tên bảng gắn cứng ngoài `articles`/`sites`; không in dữ liệu bài, mật khẩu, nội dung cá nhân.
2. `sql/02p-set-password.sql.template`: nay SQL tự sinh mật khẩu ngẫu nhiên (không còn chữ giữ chỗ `'__PASSWORD__'`) và đặt bằng `EXECUTE format('ALTER ROLE vowasia_migrator PASSWORD %L', pw)`; mật khẩu hiện ở ô kết quả cuối (hiện `NOT SHOWN` nếu Editor chạy từng câu riêng, khi đó chạy cả khối). Chỉ chạy SAU khi `02` báo SELF-CHECK OK. Tài liệu dặn xoá snippet và kết quả khỏi lịch sử/saved queries của Editor sau khi chạy.
3. `sql/03e-drop-in-editor.sql.template`: bản của `03` cho Editor: không biến psql (`:'legacy_db'`), dùng placeholder `__LEGACY_DB_NAME__` điền tay như `02`. Giữ NGUYÊN ngữ nghĩa an toàn: một giao dịch, guard tên DB, thứ tự `DROP SCHEMA` -> `DROP OWNED BY` -> `DROP ROLE`, xử lý chủ không-superuser.
4. `VOWASIA-LEGACY.md`: thêm phần "Cách B: SQL Editor của Supabase" từng bước: chép nội dung file vào clipboard bằng `cat đường_dẫn | pbcopy` (không dùng `<` làm chuyển hướng), dán vào Editor, thay placeholder bằng Cmd+H trong Editor, đọc kết quả, báo lại. Vẫn theo quy tắc zsh của chủ (mỗi khối một lệnh, không `#`, không `<...>`, bí mật qua `read -s`, không gửi bí mật vào chat). Ghi rõ hạn chế: chưa thử trong Editor thật, chỉ thử trên PG16 cục bộ; Editor có thể lưu snippet chứa mật khẩu.
5. Công cụ discover: `lib/vowasia-db-banner.ts` (và chỗ liên quan) chấp nhận tên đăng nhập dạng pooler của Supabase `vowasia_migrator.<mã-project>`, khớp CHẶT bằng regex (mã project 20 ký tự chữ thường/số); KHÔNG in phần mã project hay user ra màn hình; kèm test. Tài liệu hướng dẫn dùng host pooler chế độ session (cổng 5432), KHÔNG dùng transaction pooler 6543.
6. Test/probe: mở rộng test và `fixtures/keyset-probe.*` (không thêm file test mới nếu tránh được): 01e trả đúng MỘT result set và chạy được trong giao dịch chỉ đọc bằng role không-superuser; 03e chạy qua `-f` không cần biến psql, và các ca STOP (sai tên DB, placeholder chưa điền) không xoá gì; banner nhận/từ chối đúng tên pooler (nhận `vowasia_migrator.<20 ký tự hợp lệ>`, từ chối mã sai độ dài/chữ hoa/ký tự lạ và các user khác). G10a mở rộng cho 01e (không từ khoá ghi). Quét tĩnh doc mới theo quy tắc zsh.

**Hệ quả số liệu.** File mới dưới `scripts/migrate/vowasia/`: 26 -> 29 (+3 SQL); tổng file mới kể cả backlog: 27 -> 30. `package.json` vẫn +3 dòng. Không file GTP đổi. Các cổng G1-G13 giữ nguyên, thêm G10a cho `01e` (xem Verification Evidence). Checklist: các bước 5, 9, 10, 11 của Giai đoạn A được mở rộng theo 6 mục trên (không thêm bước đánh số mới); EXECUTE làm chúng trong các bước đó.

**Hard stops giữ nguyên (HS1-HS7).** Đặc biệt HS1: DDL trên DB cũ vẫn chỉ qua file SQL mẫu do chủ chạy (nay gồm `02p` và `03e` chạy trong Editor).

**Rủi ro đã biết thêm:**

- (a) Supabase SQL Editor có thể chạy `BEGIN..COMMIT` và hiển thị kết quả khác dự kiến. Known-Gap: chủ là người thử thật đầu tiên; thiết kế fail-closed (các ca STOP không xoá/đổi gì).
- (b) Project Supabase có nhiều hàm `SECURITY DEFINER` ngoài `public` mà PUBLIC có thể gọi, nên `02` có thể STOP vì guard. Chủ chỉ nới có chủ đích bằng `allow_definer_outside_public`, sau khi xem kết quả `01e` mục 5d.
- (c) Mật khẩu KHÔNG còn nằm trong văn bản truy vấn (SQL tự sinh bằng `EXECUTE format`), nên không ai dán/gõ mật khẩu; giảm thiểu còn lại: chỉ đặt sau SELF-CHECK OK, xoá snippet, xoá cả role khi xong (`03e`).
- (d) Rủi ro mới: mật khẩu sinh nằm ở ô kết quả mà Supabase có thể lưu trong lịch sử truy vấn; chủ chép ngay vào trình quản lý mật khẩu, xoá lịch sử/kết quả, và `03e` xoá role khi xong. Known-Gap: không kiểm soát được việc Supabase lưu kết quả.
- (e) Vòng sửa sau Amendment 1 thêm: phím Cmd+Option+F (Mac) thay Cmd+H để thay placeholder trong Editor; `01e` thêm mục 5f, 5g, 5d (mở rộng); guard `SECURITY DEFINER` loại hàm trigger; banner redact tên pooler; Cách B cấm chạy `02b`; doc bảng 11 chỗ `02` có thể dừng. Số file giữ 30.
- (f) Vòng sửa tài liệu cuối (16-10-26): chỉ chữ trong VOWASIA-LEGACY.md và chú thích SQL: tìm `__` không còn dính chú thích 03e; bảng chỗ-02-dừng thêm 'already exists'; cách ghép URL ở B5 không dựa vào clipboard; thêm cảnh báo hạn dùng 14 ngày và khoá cột bảng ở Cách B; bỏ chữ Cmd+H; số file giữ 30.

## Amendment 2 (19-10-26): allow-list of Supabase pg_net relations in file 02

Status: phạm vi do chủ duyệt (trả lời "A", 19-10-26), ghi tại đây. `## Validate Contract` và `Gate: PASS` GIỮ NGUYÊN; Amendment 2 KHÔNG được validate lại bằng PVL đầy đủ, phủ bằng EVL độc lập (`vc-tester`) + G9 (`vc-code-reviewer`, bắt buộc REQUEST/APPROVE trên thay đổi SQL của `02`), theo tiền lệ Amendment 1. Giới hạn nói thẳng: không có "mắt thứ hai" ở giai đoạn plan cho thay đổi SQL; rủi ro chuyển sang EVL + G9.

**Sự kiện quan sát (chủ chạy `01e` trong SQL Editor của project Supabase `globaltravelpost`, 19-10-26):** mục 5f liệt kê hai quan hệ mà PUBLIC với tới được: `net._http_response` (~28 hàng) và `net.http_request_queue` (0 hàng), relkind `r`, owner `supabase_admin`. PUBLIC có DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE trên cả hai và USAGE trên schema `net` (mặc định pg_net của Supabase). Guard hiện tại của `02` kiểm `has_schema_privilege USAGE` nên việc dừng là thật: `02` sẽ DỪNG ở bước tự kiểm B3 ("privilege on a table outside vowasia_ro").

**Quyết định của chủ (nguyên văn): "A"** = cho phép đúng hai quan hệ này theo tên, với role mặc định chỉ-đọc. Chủ cấm REVOKE/GRANT/sửa bất cứ gì trong project cũ (không đổi `net.*`).

**Phạm vi (chỉ những mục sau, không gì khác):**

1. `sql/02-create-readonly-role-views.sql.template`: thêm công tắc có tên `allow_public_relations constant text[]` chứa ĐÚNG `'net._http_response'` và `'net.http_request_queue'` (viết schema-qualified; khớp chính xác `nspname || '.' || relname` VÀ `relkind = 'r'`). Phép tự kiểm "quyền trên bảng ngoài `vowasia_ro`" CHỈ bỏ qua các quan hệ trong danh sách; mọi quan hệ khác vẫn DỪNG. Danh sách KHÔNG phải miễn trừ cả schema. Sau phép kiểm, `RAISE NOTICE` liệt kê những quan hệ được phép mà role với tới được (Editor không hiện NOTICE; chấp nhận).
2. File `02`: dòng `ALTER ROLE vowasia_migrator SET default_transaction_read_only = on` ĐÃ có sẵn (cạnh `statement_timeout`); Amendment 2 KHÔNG thêm dòng thứ hai mà thêm TỰ KIỂM trong cùng giao dịch: `RAISE EXCEPTION` nếu `pg_db_role_setting` không có `default_transaction_read_only=on` cho role (dòng bị xoá/gõ sai thì cả giao dịch huỷ). Nói thẳng trong plan và tài liệu: đây chỉ là MẶC ĐỊNH; ai giữ mật khẩu có thể `SET` tắt nó. Rủi ro dư được chặn bởi: hạn 14 ngày (`VALID UNTIL`), mật khẩu chỉ chủ giữ, xoá role sau khi dùng (`03`/`03e`). Đây là NỚI CÓ GHI NHẬN của HS5 cho đúng hai quan hệ tiện ích mở rộng Supabase, có lý do: PUBLIC đã cấp quyền cho mọi role kể cả `anon`/`authenticated` (SUY LUẬN từ ACL, chưa kiểm lại từng role).
3. `sql/01e-inspect-single-result.sql` (và `01` nếu có mục tương đương): mục 5f vẫn liệt kê các quan hệ nhưng `detail` thêm nhãn `(allowed by 02 allow-list)` cho hai tên trên và hiện quyền bảng của PUBLIC; chú thích đếm-điểm-dừng của `02` phải còn đúng (`02` chỉ dừng với hàng KHÔNG nằm trong allow-list). Giữ thiết kế một result set và thứ tự hàng.
4. Fixture/probe (`fixtures/keyset-probe.ts` / `.sh`, PG16 cổng 54336, DB tạm): thêm ca (a) schema `net` với hai bảng cấp ALL cho PUBLIC: `02` qua, `SHOW default_transaction_read_only` bằng role báo `on`; (b) thêm một bảng PUBLIC-đọc-được thứ ba (`net.other` hoặc `public.other`): `02` DỪNG, không tạo gì (rollback, role vắng); (c) bảng cùng tên khác schema (`net2._http_response`): DỪNG (khớp chính xác); (d) đột biến thiếu setting: DỪNG. Test đơn vị trong `lib/` (test SQL hiện có hoặc file mới nếu bắt buộc) khẳng định template chứa allow-list đúng 2 tên và dòng `ALTER ROLE ... default_transaction_read_only`; đột biến đỏ trước (red-first).
5. Tài liệu: `VOWASIA-LEGACY.md` mục Cách B: nói `02` nay cho qua đúng hai quan hệ Supabase đó (vì sao, giới hạn trung thực ở trên), tuyệt đối không REVOKE/GRANT gì trong `net`. Sửa luôn các mục tài liệu còn tồn: lệnh O1 phải có `--confirm-host`; ghi chú dọn "Recently Deleted" trong Notes sau ghi chú mật khẩu; sửa chữ đầu `03e`. Plan: đã bỏ `--site-id` khỏi hợp đồng CLI (mục Public Contracts) và HS5 đã ghi ngoại lệ Amendment 2.

**Cổng EXECUTE/EVL:** G1 `test:migrate-vowasia`, G2 `lint:migrate`, G3 `typecheck`, G4 `test:migrate-gtp`, G5 `test:single-home`, G6 `keyset-probe.sh` (chạy MỘT MÌNH, cổng 54336), cổng mật khẩu danh sách trắng giữ nguyên với 6 đột biến vẫn đỏ, G7/G7b/G7c/G8/G10a/G10c/G13 như plan, cộng **G14 mới** (ca probe Amendment 2 a-d, chứng minh bằng đột biến đỏ trước). Review độc lập G9-style (`vc-code-reviewer`) bắt buộc trên thay đổi SQL `02`.

**Known-Gap (có tên):** (K1) ĐÃ CÓ BẰNG CHỨNG 19-10-26: chủ chạy `01e`, `02`, `02p`, `03e` trong SQL Editor thật của project `globaltravelpost` (xem `## Amendment 3`, mục 3.1); K2-K6 không đổi trạng thái; (K2, sửa chữ 19-10-26 theo G9 MAJOR-1) role ĐỌC `net._http_response` (nội dung phản hồi HTTP của các tích hợp khác, khoảng 28 dòng) và `net.http_request_queue` VÔ ĐIỀU KIỆN (chỉ-đọc không chặn SELECT); `default_transaction_read_only` chỉ là MẶC ĐỊNH, ghi đè được bằng `SET`; khi tắt, ghi vào `net.http_request_queue` theo thiết kế pg_net có thể khiến máy chủ DB gửi yêu cầu HTTP ra ngoài (chưa kiểm trên pg_net thật), và role có thể sửa giả/xoá dòng `net._http_response`. Lộ mật khẩu migrator vì vậy làm lộ NHIỀU HƠN dữ liệu VowAsia. Giảm thiểu: B3 tới B6 trong một lần ngồi (tạo role, discover, xoá role), khuyến nghị rút `VALID UNTIL` ngắn hơn 14 ngày (giá trị SQL không đổi), mật khẩu chỉ ở clipboard/Notes rồi dọn Recently Deleted, xoá role khi xong. **Chủ xác nhận lại "A" với cách diễn đạt đã sửa: ĐÃ XÁC NHẬN 19-10-26** (xem `## Amendment 3`, mục 3.1). (K3) allow-list đặc thù Supabase: quan hệ tiện ích mở rộng khác ở project khác vẫn DỪNG và cần Amendment mới. (K4, G9 MINOR-4) probe G14 chạy PG16, đích là PG17 có quyền MAINTAIN; lệnh lớp MAINTAIN (VACUUM, REINDEX, CLUSTER, LOCK TABLE) trong phiên chỉ-đọc CHƯA kiểm. (K5, G9 MINOR-1) allow-list chỉ khớp tên + relkind; KHÔNG kiểm bảng có thuộc tiện ích `pg_net` (pg_depend), bảng con kế thừa (pg_inherits), hay trigger/rule trên hai bảng được phép. (K6, G9 MINOR-3) dòng SELECT trạng thái cuối KHÔNG kiểm lại setting chỉ-đọc hay `VALID UNTIL`; chỉ là vấn đề khi chạy psql không có ON_ERROR_STOP (Editor không chạm tới).

**Hard stops giữ nguyên (HS1-HS7):** không ghi production bởi agent, không bí mật, không commit file chứa thông tin đăng nhập, KHÔNG chạm tooling GTP, không chạy gì trên DB thật.

### Verification Evidence bổ sung (Amendment 2)

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| G14a probe: `net` + 2 bảng PUBLIC ALL -> `02` qua; `SHOW default_transaction_read_only` = on | Hybrid (PG16 cục bộ) | AC-A8 (Amendment 2), allow-list đúng hai tên |
| G14b probe: bảng PUBLIC-đọc-được thứ ba -> `02` DỪNG, role vắng | Hybrid | AC-A8 (không phải miễn trừ cả schema) |
| G14c probe: `net2._http_response` -> DỪNG | Hybrid | AC-A8 (khớp chính xác schema+tên) |
| G14d đột biến thiếu setting -> DỪNG | Hybrid | AC-A8 (tự kiểm setting) |
| Test đơn vị `lib/`: template có đúng 2 tên allow-list + dòng ALTER ROLE (đỏ-trước) | Fully-Automated | AC-A8 |
| G9 review `02` SQL | Agent-Probe | AC-A8 |

Bằng chứng EXECUTE (19-10-26): G14a-d xanh trên PG16 cục bộ (cổng 54336, chạy một mình); 5 đột biến `02` (thêm tên thứ ba, bỏ `relkind`, khớp chỉ tên, tắt tự kiểm setting, danh sách rỗng) đều làm probe ĐỎ; chi tiết ở REPORT mục "Amendment 2".

### Checklist EXECUTE (Amendment 2)

1. Viết test đơn vị (allow-list đúng 2 tên, dòng ALTER ROLE, tự kiểm setting) và chứng minh ĐỎ trước. [XONG 19-10-26: 3 test mới trong `vowasia-sql.test.ts`, đỏ 3/3 trước khi sửa]
2. Sửa `02`: `allow_public_relations`, lọc phép kiểm bảng theo allow-list, `RAISE NOTICE`, tự kiểm `pg_db_role_setting`. [XONG 19-10-26]
3. Sửa `01e` (và `01` nếu cần): nhãn `(allowed by 02 allow-list)`, quyền bảng của PUBLIC, giữ một result set. [XONG 19-10-26; `01` không có mục 5f, không sửa]
4. Mở rộng `keyset-probe.ts/.sh` với ca G14a-d; chạy riêng, cổng 54336, dọn tiến trình/DB tạm. [XONG 19-10-26: chỉ sửa `.ts`; thêm ca c' (tên trong danh sách nhưng là view)]
5. Sửa `VOWASIA-LEGACY.md` (Cách B, O1 `--confirm-host`, Recently Deleted, `03e` header). [XONG 19-10-26]
6. Chạy G1-G5, G6, cổng mật khẩu + 6 đột biến, G7/G7b/G7c/G8/G10a/G10c/G13, G14. [XONG 19-10-26: tất cả xanh, xem REPORT mục Amendment 2]
7. Gọi G9-style review độc lập; ghi report; KHÔNG commit nếu chủ chưa yêu cầu. [report XONG; G9 do orchestrator gọi; commit cục bộ theo lệnh orchestrator 19-10-26, chưa push]

## Resume and Execution Handoff (mục 17)

1. Plan này; trạng thái: PVL cycle 1 (S1-S8) và cycle 2 (T1-T7) đã áp dụng; validate pass 3 (16-10-26) ghi Validate Contract `Gate: PASS` cho Giai đoạn A (`Accepted by` CHƯA có chủ; AC-A9 Known-Gap có tên). Amendment 1 (SQL Editor, +3 SQL, banner pooler) đã ghi, chưa validate lại bằng PVL (phủ bằng EVL + G9). Chưa EXECUTE.
2. Pha kế: VALIDATE (xem khuyến nghị bên dưới), sau đó chủ nói "ENTER EXECUTE MODE" cho **Giai đoạn A** (khuyến nghị duy nhất).
3. EXECUTE phải nhận đúng một đường dẫn plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`.
4. Ngữ cảnh cần đọc: `process/context/all-context.md`, `tests/all-tests.md`, `scripts/migrate/GTP-LEGACY.md`, `scripts/lib/vowasia-taxonomy.ts`, `scripts/lib/central-db-name-guard.ts`, và các file GTP được dùng làm mô hình (đọc, không sửa).
5. Thứ tự checklist A: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 11b → 12 → 13 → 14. Sau khi A xong dừng, chờ O1-O6.
6. Mặc định đã chốt trong plan (chủ có thể đổi trước EXECUTE): chép riêng `args.ts`+`out-dir.ts` (O-Q1); phương án role 2, chốt sau khi chủ chạy `01` (O-Q2); allow-list `articles`+`sites` (O-Q3); `rehearse:gtp` không bắt buộc sau A, chạy một lần ở EVL cuối chương trình sau B (O-Q5). Run-id/`--resume` là quy tắc cứng của chủ (mỗi `--apply` run-id mới, không `--resume` run cũ), không còn là câu hỏi. Ghi mặc định đã dùng vào report.
7. Validator khi bàn giao: `node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs <đường dẫn plan>`.
8. Nếu mất ngữ cảnh: đọc mục 2-4, 6A và 12.

### Execute-agent instructions (E1-E8, từ Validate Contract)

- E1: làm T1 (bước 6) trước mọi thứ khác ở bước đó; test (a), (b độc lập với `repoRoot()`) và (c) phải ĐỎ trước khi sửa `repoRoot()` (red-first); đừng dựng (b) từ `repoRoot()` (sẽ xanh nhầm trên bản lỗi).
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

Status: PASS
Date: 16-10-26
date: 2026-10-16
generated-by: outer-pvl
supersedes: 2026-10-16 (outer-pvl) — vòng 2 (CONDITIONAL, T1-T7) đã được thay; vòng 3 có bằng chứng hiện hành sau supplement T1-T7 + E1-E8 và bốn sửa chữ của chính validate pass 3 (xem "Sửa chữ do validate-agent áp dụng")

Parallel strategy: sequential (cho EXECUTE Giai đoạn A: MỘT agent opus tuần tự; EVL một `vc-tester` sonnet; G9 một `vc-code-reviewer` sonnet)
Rationale: 7 tín hiệu = 3/7 (S2 bề mặt quyền/DB: DDL role/view trên DB cũ; S6 lớp rủi ro cao: trust-boundary/permission/secret; S7: 27 file mới). Ngưỡng 2-3 nghiêng về parallel subagents, nhưng đúng theo luật "chiến lược phải khớp công việc": các file gắn chặt (sql ↔ reader ↔ config ↔ probe, và `out-dir.ts` phải làm đỏ-trước), chia song song chỉ tăng nguy cơ lệch giao diện giữa các agent. Số agent: Tuần tự = 1 (execute, opus) + 1 (EVL tester, sonnet) + 1 (reviewer G9, sonnet) = 3; Parallel subagents = 2-3 agent viết + 2 = 4-5; Workflow = thừa (không có số mục lặp); Agent team = 3 thành viên x 2 vòng = 6 (không cần: không có blast radius cần phối hợp giữa chừng). Ngưỡng chi phí (>30 agent): không chạm. Model: sonnet cho mọi pha trừ EXECUTE (opus). Pha VALIDATE này: phiên không có công cụ spawn subagent nên 4 chiều Layer 1 rồi các section Layer 2 được một agent chạy TUẦN TỰ (chỉ đọc, như vòng 1-2); hạn chế: không có "mắt thứ hai" độc lập, bù bằng đối chiếu trực tiếp mã main @ `fe88bc4`, mô phỏng thật trong thư mục tạm ngoài repo, và đo lại baseline.

Bằng chứng vòng 3 (chỉ đọc; không DB, không `rehearse:gtp`; 16-10-26): `test:migrate-gtp` 69/69 pass; `test:single-home` 267/267 pass; `lint:migrate` 0 lỗi + 1 cảnh báo có sẵn (`seed-gtp-legacy-fixture.ts:179 't50sec'`); `tsc --noEmit` exit 0; `validate-plan-artifact.mjs` 0 FAIL / 0 warning (522 dòng). Hiện tại: G8 exit 0, G7 rỗng, G7c rỗng (cây chỉ có thay đổi dưới `process/general-plans/`), G13 exit 1 (đúng: file backlog do EXECUTE bước 11b tạo). PG16 native `/usr/lib/postgresql/16/bin` có; không listener 543xx; cổng 54336 khác dải rehearsal GTP (54326-54328).

Kiểm lại T1-T7 (đọc TOÀN file 522 dòng):
- T1 (guard out-dir): ĐÃ XỬ LÝ nhưng bước (b) viết sai cách; validate pass 3 đã sửa chữ (xem "Sửa chữ do validate-agent áp dụng", mục 3). Mô phỏng thật trong thư mục tạm ngoài repo (git init + `package.json` + `.gitignore` y như repo; chép nguyên `scripts/migrate/lib/out-dir.ts` vào `scripts/migrate/vowasia/lib/`; chạy bằng `tsx --test`): BẢN 3 CẤP (chép nguyên): (a) `repoRoot()` có `package.json`+`.git` ĐỎ; (c) `scripts/migrate/out/...` được chấp nhận ĐỎ (bị coi là chưa ignore); (b)-độc-lập (đường dẫn dựng từ vị trí file, `<repo>/process/x`) ĐỎ và guard bị bỏ qua, thư mục `<repo>/process/...` THỰC SỰ được tạo; NHƯNG (b)-dạng-plan-cũ (`path.join(repoRoot(),"process",...)`) XANH NHẦM, nên "(a)/(b) đỏ-trước" ở bản cũ là sai với (b). BẢN 4 CẤP (`..` x4): cả bốn xanh, thư mục out mode 700. Kết luận: sửa `repoRoot()` lùi 4 cấp đúng; (b) bắt buộc dựng độc lập với `repoRoot()`.
- T2 ĐÚNG: HC9 (L79) = G4, G5, G2, G3, G7, G7b, G7c, G8; Phase Completion Rules = G1-G10 + G7b + G7c + G13; Verification Evidence và E7 khớp; G11 chỉ khi chủ yêu cầu. Chỗ sót duy nhất (AC-A10 còn viết "G4, G5, G11") đã sửa.
- T3 ĐÚNG: đếm lại từ bảng Touchpoints = 26 file dưới `scripts/migrate/vowasia/` (16 file trong `lib/`: 6 cặp code/test gồm `vowasia-cli.ts`, cộng `args`/`out-dir` + 2 test, `discover-vowasia.ts`, 1 JSON cấu hình, 1 overlay, 2 file keyset-probe, 4 file sql, `VOWASIA-LEGACY.md`) + 1 file backlog = 27; `package.json` +3 dòng. Touchpoints, Blast Radius (L276), Checklist 12, G7b, HS2, Public Contracts nhất quán. Không còn "23 file"/"25 file"/"G1-G11" trong thân plan (grep xác nhận).
- T4 ĐÚNG: bước 11b tạo `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (thư mục `backlog/` có sẵn, không git-ignored); G13 `test -f`; thuộc phạm vi G7c (`process/general-plans/` được loại).
- T5 ĐÚNG: truy vấn tự kiểm của `02` + xử lý theo HS5 + chạy `03` (checklist 9, §5.4); HS1/bước 9 ghi "DDL duy nhất trên DB cũ; probe chạy DDL chỉ trên PG16 tạm do chính nó dựng và dọn".
- T6 ĐÚNG: (a) `vowasia-cli.test.ts` mã 0/2/1 (Touchpoints + bước 6); (b) bước 10 có khẳng định stdout/stderr/`legacy-schema-report.md`/`legacy-mapping.template.json`/`query-log.json` không chứa id site, mật khẩu fixture, đoạn body mẫu, mode 700/600; đối chiếu GTP: `query-log.json` chỉ ghi `{id, text}` (không params nên không rò id site: `legacy-sql.ts:503`); (c) bước 2 parse zod hai file JSON, khoá `media` tuỳ chọn.
- T7 ĐÚNG: ba điểm "Điểm phải chốt ở amendment B" nằm đúng chỗ, không chặn A.
- Quy tắc chủ (nguyên văn, L64): "Importer chỉ tạo mới, không sửa, không xoá, không bao giờ tạo tác giả. Rollback theo từng run. Lần chạy thứ hai dùng run-id mới, không dùng --resume cho run cũ." KHỚP nguyên văn; HC4, bảng Importer/Rollback/Fixture/Runbook, O8/O9, Resume #6 đều theo quy tắc; mọi lần nhắc `--resume` là câu CẤM. Quyết định chốt: C1 (6 tác giả đúng tên và nguồn `scripts/lib/vowasia-taxonomy.ts:226-231`, không tên chung, importer không tạo tác giả), C5 (bỏ SEO), C6 (20 MB, dừng nếu > 2%, thiếu ảnh -> nháp), C7, C9 (chỉ bài viết) đều có trong thân plan, không mâu thuẫn.

Spot-check trích dẫn tooling GTP (14/14 khớp main @ `fe88bc4`): `cli-common.ts:55-59` (`IMPORT_TENANT`, `assertImportTenant`) và `openLegacy` gọi `assertGtpSite`; `legacy-reader.ts:171` `assertGtpSite`; `legacy-reader.ts:79,90` `pages()` chỉ dừng khi `rows.length < pageSize`; `legacy-sql.ts:38` `ALLOWED_TABLES`, `:73` `UUID`, `:224-270` đủ 8 builder + `siteAuthorsRows`, `:275-281` `cursorOf` cắt micro-giây (`c.toISOString()`), `:296` danh sách hàm có `coalesce`; `:503` log chỉ `{id,text}`; marker `legacy:globaltravelpost` đúng 4 nơi (`import-gtp-main.ts:61`, `verify-main.ts:32`, `rollback-main.ts:30`, `gtp-timestamps.ts:14`); `slug-plan.ts:18`; `db-banner.ts:10` `LEGACY_GTP_DB_URL`; `gtp-mapping.ts:185` `gonePaths`; `gtp-author-distribution.ts:6` (chia đều pool, không "GTP Newsroom"); `fixtures/gtp-legacy/schema.sql` L175-177 (`ALTER ROLE ... SET`); `scripts/lib/central-db-name-guard.ts:67`, `scripts/lib/local-db-guard.ts:96`; `.gitignore:43`; `package.json:46-47`.

Xác nhận Giai đoạn A: KHÔNG đụng file GTP nào. Chỉ 26 file MỚI dưới `scripts/migrate/vowasia/` + 1 file backlog + thư mục task + ĐÚNG 3 dòng thêm vào `package.json` (G7b). G7c (`git ls-files --others --exclude-standard`, loại `scripts/migrate/vowasia/` và `process/general-plans/`) bắt file untracked ngoài phạm vi mà G7/G8 mù (đã mô phỏng vòng 2). Glob GTP `scripts/migrate/lib/*.test.ts` một cấp không nhặt test vowasia; `tsc` và `lint:migrate` phủ file mới.

Sửa chữ do validate-agent áp dụng vào thân plan ở pass 3 (V6 bước 1; chỉ đổi chữ, không đổi phạm vi/file/cổng; xem `git diff` file plan):
1. Header `Status:` (L11) và Resume #1: bỏ câu "Validate Contract là bản vòng 2 ... LỖI THỜI", thay bằng trạng thái pass 3.
2. §5.3 mục 4 (reader): bỏ "hoặc nhỏ hơn" (mâu thuẫn với E4 cấm so "nhỏ hơn" trên chuỗi timestamptz-text); chốt chặn chỉ kiểm (i) bộ con trỏ bằng nhau, (ii) trang chỉ chứa khoá đã thấy.
3. Checklist bước 6 (T1) + E1: test (b) dựng đường dẫn ĐỘC LẬP với `repoRoot()`; yêu cầu đỏ-trước đổi thành (a), (b độc lập), (c); thêm kết quả mô phỏng.
4. AC-A10 (bảng Acceptance Criteria): bỏ G11 khỏi cột "proven by" (G11 chỉ khi chủ yêu cầu), khớp HC9/Phase Completion Rules.
Ghi chú thực thi (advisory, KHÔNG phải CONCERN) nằm ở E9-E11 bên dưới. Ghi chú đầu contract cũ ("23/25 file", "G1-G11", "bước tạo backlog nằm ở T4") đã bị xoá cùng contract cũ.

Test gates (C3 5-column table):

| criterion id | behavior | strategy | proving test | gap-resolution |
|---|---|---|---|---|
| AC-A1 | Không file GTP đổi; chỉ `package.json` + 3 dòng vowasia; không file untracked lạ | Fully-Automated | G7 + G7b + G8 + G7c (đã mô phỏng: G7c bắt untracked, G8 mù) | B |
| AC-A2 | Mọi SQL phát ra là SELECT một bảng allow-list có vị từ site cố định; corpus tấn công bị từ chối | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-sql.test.ts) | B |
| AC-A3 | Site id `uuid`/`integer`/`text-safe` kiểm đúng kiểu; cột/bảng/vai cột theo overlay; IDENT hoa/camelCase bị từ chối; hai file JSON cấu hình qua zod | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-sql.test.ts, vowasia-config.test.ts) | B |
| AC-A4 | Keyset không mất/trùng (cùng ms khác µs, created_at y hệt, NULL, 1970) trên PG16 thật | Hybrid | `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` (precond: PG16 native, runuser, cổng 54336) | B |
| AC-A5 | Khử trùng theo khoá; chốt chặn con trỏ (bằng nhau / trang chỉ khoá đã thấy) ném lỗi | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-reader.test.ts) | B |
| AC-A6 | Discover chỉ SELECT có vị từ site; guard out-dir phủ cả thư mục ngoài `scripts/`; báo cáo git-ignored 700/600; stdout/stderr/báo cáo không chứa id site, mật khẩu, body; mã thoát 0/2/1 | Hybrid | keyset-probe.sh (query-log + grep đầu ra) + vowasia-db-banner.test.ts + out-dir.test.ts (a, b độc lập, c) + vowasia-cli.test.ts | B |
| AC-A7 | Marker `legacy:vowasia` khác GTP, không chứa `globaltravelpost` | Fully-Automated | `npm run test:migrate-vowasia` (vowasia-constants.test.ts) | B |
| AC-A8 | SQL role/view: chỉ đọc đúng site, bảng gốc bị từ chối, không ghi được, RLS/policy/grant bảng gốc không đổi, dọn sạch được, không chứa mật khẩu | Hybrid | probe PG16 áp 02/03 trên fixture cục bộ + G9 (Agent-Probe, bổ sung) + G10 (grep) | B |
| AC-A9 | Tooling chạy đúng trên DB cũ THẬT | Hybrid (precondition: chủ chạy O2-O5 trên DB thật; KHÔNG chạy được trong chu kỳ này) | G12: discover thật do chủ chạy | D (backlog stub bắt buộc, G13; residual có tên, KHÔNG phải bằng chứng PASS) |
| AC-A10 | GTP vẫn xanh | Fully-Automated | G4 (69), G5 (267), G2, G3 (G11 chỉ nếu chủ yêu cầu, O-Q5) | A (đã đo hôm nay) |

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
- Infra fit: PASS — PG16 native + `runuser` có, cổng 54336 trống và khác dải rehearsal, baseline xanh, `pg` có sẵn; bẫy `repoRoot()` 3 vs 4 cấp đã xác định đúng và sửa (mô phỏng).
- Test coverage: PASS — mọi hành vi đã phát triển trong A có cổng Fully-Automated hoặc Hybrid (kể cả `vowasia-cli.ts`, out-dir, hai JSON cấu hình, đầu ra không rò bí mật); AC-A9 (DB cũ thật) là Known-Gap có tên + stub (G13), không phải lý do để PASS; không vacuous-green.
- Breaking changes: PASS — chỉ file mới + 3 dòng script `package.json`; không đổi `src/`, API, schema Payload, migration, `docs/`, `process/context/`.
- Security surface: PASS — hàng rào thật là role/view (`NOBYPASSRLS`, `security_barrier`, `default_transaction_read_only`, cột tường minh, `DROP OWNED BY`), allow-list + lexer + `BEGIN READ ONLY` là lớp hai; guard out-dir đúng gốc repo công khai; log truy vấn không có params; không bí mật trong repo; STRIDE rà inline (không có Elevation/Info disclosure mở).
- Section 2 Owner Decisions: PASS — B3, B4, C1, C2, C4-C7, C9 khớp; C3/C8/C10/A1/host ảnh nhận qua cấu hình, không hard-code, không tên tác giả chung.
- Section 3 Hard Constraints / Hard Stops: PASS — HC4 đúng nguyên văn quy tắc chủ; HC9 và Phase Completion Rules nhất quán; HS1 phân biệt DB cũ và PG16 tạm.
- Section 4 Xác minh tooling: PASS — 14/14 trích dẫn khớp main @ `fe88bc4`.
- Section 5 Thiết kế (5.1-5.5) + sql/*: PASS — keyset `__cursor_ts` khả thi (lexer GTP đã cho `coalesce`, `::`); chốt chặn con trỏ nhất quán với E4 sau sửa chữ; §5.4 hardening + xử lý kết quả tự kiểm (HS5) đủ.
- Section 6A Checklist 1-14: PASS — thứ tự 1-14 (kể cả 11b) khớp Resume #5; T1 đỏ-trước đúng sau sửa; bước 10 gồm keyset + discover + role + đầu ra không rò bí mật.
- Section 6B (Giai đoạn B phác thảo): PASS cho phạm vi A; ba điểm T7 giữ cho amendment B, thêm lưu ý B bên dưới.
- Acceptance Criteria / Touchpoints / Blast Radius / Verification Evidence / Phase Completion Rules / Resume handoff: PASS — 26 + 1 file, G1-G10 + G7b + G7c + G13, nhất quán.
- Public Contracts: PASS — CLI `--mapping-overlay/--site-id/--out/--sample/--schema`, mã thoát 0/1/2, artefact git-ignored (GTP discover cũng nhận `--site-id`; vowasia có thể bỏ `--site-id` nếu muốn tránh id site trong argv, xem E10).

Plan updates required: none còn lại (mọi sửa chữ đã áp ở trên).

Execute-agent instructions (viết vào contract; E1-E8 giữ từ vòng 2, E1 điều chỉnh theo T8; E9-E11 mới, advisory):
- E1: Thực hiện T1 trước mọi thứ khác ở bước 6; test (a), (b dựng ĐỘC LẬP với `repoRoot()`) và (c) phải ĐỎ trước khi sửa `repoRoot()` (red-first). KHÔNG dựng (b) từ `repoRoot()` (xanh nhầm trên bản lỗi).
- E2: G7b: lọc dòng thêm bằng `grep -E '^\+[^+]'` (loại dòng tiêu đề `+++`), mọi dòng thêm phải chứa `vowasia`; đúng 3 dòng.
- E3: G10c: `VOWASIA-LEGACY.md` và comment trong `lib/*.ts` KHÔNG chứa `postgres://` hay `postgresql://` (dùng "URL kết nối" hoặc mẫu không có scheme); chỉ test/probe được phép.
- E4: Chốt chặn con trỏ: KHÔNG so sánh "nhỏ hơn" trên chuỗi timestamptz-text. Dùng: (i) bằng nhau toàn bộ bộ con trỏ => ném lỗi; (ii) trang chỉ chứa khoá đã thấy => ném lỗi; thứ tự sai dựa vào ORDER BY của DB.
- E5: Probe: kiểm cổng 54336 trống trước khi bật; `mktemp -d` + `trap` dọn PG tạm và thư mục; không chạy song song với bất kỳ gate nào khác (HS6); không `npm ci` song song.
- E6: Probe không in mật khẩu fixture; mật khẩu sinh trong probe, không nằm trong `sql/*`.
- E7: Ghi vào report EXECUTE các mặc định đã dùng (O-Q1, O-Q2, O-Q3, O-Q5) và kết quả từng cổng G1-G10, G7b, G7c, G13; G12 ghi là Known-Gap.
- E8: Giữ nguyên: không sửa file GTP, không sửa `docs/`/`process/context/` ở A (để UPDATE PROCESS), không chạm `~/gtp-private`.
- E9 (advisory): stdout/stderr của discover vowasia KHÔNG in mẫu nội dung bài (GTP in một "title sample" ở `discover-legacy-pg.ts:206`); chỉ in đường dẫn báo cáo và số đếm. Khẳng định này nằm trong grep đầu ra của bước 10.
- E10 (advisory): chèn 3 dòng script vào GIỮA khối `scripts` của `package.json` (không đặt ở dòng cuối khối, vì khi đó dòng cuối cũ phải thêm dấu phẩy và G7b sẽ đếm 4 dòng). Cân nhắc không cần cờ `--site-id` (id site lấy từ overlay) để id site không vào argv/lịch sử shell.
- E11 (advisory): trong bảng Verification Evidence, `\|` ở G7b/G7c/G10 chỉ là dấu thoát của bảng Markdown; khi chạy shell dùng `|` thường.

Lưu ý cho amendment B (KHÔNG chặn A, không phải CONCERN):
- Ngoài ba điểm T7: `rewrite-links` và `timestamps-fix.sql` là bước hậu kỳ SỬA bài đã nhập; quy tắc chủ ("Importer chỉ tạo mới, không sửa") áp cho importer. Amendment B nên nêu rõ hai bước này chỉ tác động bài mang marker `legacy:vowasia` + tenant `vowasia` + đúng run-id đã chọn, là bước riêng (rewrite-links dry-run mặc định; SQL do chủ chạy), và xin chủ xác nhận cách hiểu này.

Câu hỏi cho chủ (chỉ những câu thật sự cần ở thời điểm này):
- Q-1: Có ENTER EXECUTE MODE cho **Giai đoạn A** (khuyến nghị duy nhất) theo đúng đường dẫn plan này không. Đây là cổng của chủ; không có consent EXECUTE nào được suy ra từ Gate PASS.
- Q-2 (= O-Q1): giữ MẶC ĐỊNH chép riêng `args.ts`/`out-dir.ts` (đã có T1 đỏ-trước) hay đổi sang import từ `scripts/migrate/lib/` (không có bẫy T1, nhưng ràng buộc file GTP, thêm test chống drift). Mặc định nếu không trả lời: chép riêng.
- Q-3 (= O-Q5): `rehearse:gtp` (~60 phút) không chạy sau A (G8 + G7c thay thế), chạy một lần ở EVL cuối chương trình sau B; chủ có muốn chạy ngay sau A không. Mặc định nếu không trả lời: không.
- (Không phải câu hỏi lúc này) O-Q2 phương án role: chốt sau khi chủ chạy `01`; O-Q3 allow-list `articles`+`sites`; C3/C8/C10/A1/host ảnh: sau discover (HS7).

Open gaps: AC-A9 (DB cũ thật): known-gap: documented, backlog `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` (stub CHƯA tồn tại ở thời điểm VALIDATE, do EXECUTE bước 11b tạo và G13 kiểm; cổng A -> B giữ CONDITIONAL tới khi discover thật xanh). Gap GTP (keyset cắt µs + `pages()` không khử trùng) chỉ ghi, chủ quyết riêng. C3/C8/C10/A1/host ảnh: chờ chủ sau discover (HS7). Lưu ý B ở trên.

What this coverage does NOT prove:
- G1 (`test:migrate-vowasia`): không chứng minh hành vi trên PG thật, không chứng minh quyền role, không chứng minh schema/RLS thật của DB cũ.
- G6 keyset-probe: chỉ dữ liệu giả, một máy PG16 cục bộ; không chứng minh múi giờ/DateStyle/kiểu `created_at` của DB cũ thật (có thể là `timestamp` không múi giờ, hoặc cột tên khác); không thực thi nhánh PG ≤ 14 (PUBLIC có `CREATE` trên schema `public`); không phủ phương án 1 (RLS, `02b` chỉ kiểm cú pháp).
- `out-dir.test.ts`: chứng minh guard phủ thư mục trong repo ngoài `scripts/` trên cấu trúc repo này; không chứng minh với repo clone ở worktree/đường dẫn lạ ngoài các ca đã thử (mô phỏng validate pass 3 chạy trong thư mục tạm, không phải file thật của vowasia vì chưa tồn tại).
- G7/G7b/G7c/G8/G4/G5: chứng minh GTP không đổi byte và test GTP xanh; không chứng minh `rehearse:gtp` end-to-end (G11 tuỳ chủ).
- G9/G10: review + grep không thay cho áp SQL thật; SQL chạy trên DB cũ là DDL duy nhất trên DB cũ và do chủ chạy; G10 dựa trên regex nên không bắt lệnh nguy hiểm viết lạ (G9 là lớp bổ sung).
- Toàn bộ Giai đoạn A: không chứng minh bất kỳ hành vi import/rollback/redirect nào (Giai đoạn B mới phác thảo, chưa thực thi).
- Không chứng minh tenant `vowasia` + taxonomy đã tồn tại trên production (A1/O1 chủ chạy).

Gate: PASS (0 FAIL, 0 CONCERN còn mở; T1-T7 đã xử lý đúng sau khi validate pass 3 sửa chữ 4 điểm nêu trên; Giai đoạn A khả thi cơ học, không đụng GTP; AC-A9 là Known-Gap có tên giữ cổng A -> B ở CONDITIONAL, không phải bằng chứng PASS). Phạm vi PASS = được phép đề nghị ENTER EXECUTE cho Giai đoạn A; Giai đoạn B chưa thực thi được (HS7).
Accepted by: CHƯA được chủ chấp nhận gì cả. Gate PASS không cần chấp nhận concern; chủ cần (1) nói "ENTER EXECUTE MODE" cho Giai đoạn A, (2) biết rằng AC-A9 vẫn là Known-Gap (xác nhận ở cổng A -> B). Cycle PVL đã ghi nhận: 2 vòng supplement (S1-S8, T1-T7) + pass 3 (validate-agent tự sửa 4 điểm chữ).

## Autonomous Goal Block

SESSION GOAL: VowAsia legacy migration, Giai đoạn A (công cụ đọc/discover bản riêng dưới scripts/migrate/vowasia, không file GTP đổi một byte).
Charter + umbrella plan: N/A — single plan (không có `## Stable Program Goal` trên đĩa).
Autonomy: theo feedback_autonomous_phase_execution.md, nhưng EXECUTE chỉ bắt đầu sau lệnh "ENTER EXECUTE MODE" của chủ cho đúng plan này; EXECUTE = 1 agent vc-execute-agent (opus) tuần tự theo checklist 1-14 và E1-E11; EVL do vc-tester chạy lại độc lập; G9 do vc-code-reviewer. Autonomy chỉ bỏ các điểm dừng phê duyệt, không bỏ việc spawn subagent.
Hard stops: HS1 ghi DB cũ hoặc DDL trên DB cũ ngoài SQL mẫu chủ chạy; HS2 sửa file GTP hoặc ngoài Touchpoints (ngoài 3 dòng package.json); HS3 banner DB không phải /neondb ở lệnh Central có --apply, hoặc site row slug khác vowasia; HS4 phát hiện bí mật trong repo/log/báo cáo; HS5 phương án role có thể hại site cũ hoặc truy vấn tự kiểm của 02 báo true/khác 1 dòng; HS6 probe không dọn tiến trình/DB tạm; HS7 làm Giai đoạn B khi chưa có discover thật + quyết định C3/C8/C10/host ảnh. Quy tắc chủ: importer chỉ tạo mới, không sửa, không xoá, không bao giờ tạo tác giả; rollback theo từng run; lần chạy thứ hai dùng run-id mới, không dùng --resume cho run cũ. Không in/commit bí mật; không chạm ~/gtp-private; không chạy rehearse:gtp trừ khi chủ yêu cầu.
Next phase: EXECUTE (sau "ENTER EXECUTE MODE" của chủ): process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
Validate contract: inline in plan (## Validate Contract), Gate: PASS, generated-by: outer-pvl, 16-10-26.
Execute start: T1 đỏ-trước (out-dir.test.ts: a, b độc lập, c) rồi checklist A 1-14 | G1 `npm run test:migrate-vowasia` | G6 `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` | G2 `npm run lint:migrate` | G3 `npm run typecheck` | G4 `npm run test:migrate-gtp` | G5 `npm run test:single-home` | G7, G7b, G7c, G8, G10, G13 | G9 review SQL | high-risk pack: yes (quyền/role, trust-boundary).

---

## Amendment 3 (19-10-26): kết quả Giai đoạn A thật + kế hoạch Giai đoạn B

Status: PLANNED cho B (chưa EXECUTE). HS7 nay ĐƯỢC MỞ cho việc LẬP PLAN B: đã có discover thật + quyết định C8/C3/C10/ảnh. Việc THỰC THI B vẫn cần: PVL của mục này (`### Validate Contract (Chặng B-α)`: PASS 19-10-26; `### Validate Contract (Chặng B-β)`: B-0b đã đo 20-10-26, Amendment 4 written; awaiting inner PVL), xác nhận A1 (O1), và trả lời các câu hỏi mở ở mục 3.9. `## Validate Contract` ở trên chỉ phủ Giai đoạn A, không phủ B.

### 3.1 Sự kiện: chạy thật Giai đoạn A (19-10-26, chủ chạy, một lần ngồi)

- Chủ xác nhận lại lựa chọn "A" (Amendment 2) với cách diễn đạt rủi ro đã sửa (K2). Đã thay dòng PENDING ở Amendment 2.
- SQL Editor của Supabase, project `globaltravelpost`, tất cả do chủ chạy:
  - `01e` sạch: 5c `can-add-schemas` false; `password_encryption` scram-sha-256; 5d = 0; 5f chỉ có hai bảng `net` trong allow-list; 5g không có; chưa có role `vowasia_migrator` từ trước.
  - `02` lần 1 DỪNG ở hàng rào placeholder (không tạo gì: hàng rào chạy đúng). `02` lần 2: `SELF-CHECK OK`.
  - `02p` sinh mật khẩu (orchestrator không bao giờ thấy).
  - discover qua session pooler `aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`, `ssl=require` (KHÔNG kiểm chứng chỉ: giới hạn được chấp nhận, ghi Known-Gap KB-1), thoát 0.
  - `03e`: `CLEANUP OK`, `vowasia_policies_left` = 0; `articles`/`sites` `rls_enabled` = true (như trước khi chạy).
- K1 nay có bằng chứng trên SQL Editor thật. K2-K6 giữ nguyên trạng thái (không có bằng chứng mới).
- Không ghi gì vào Central/`neondb`. Overlay `~/vowasia-private/overlay.json` giữ lại (chỉ chứa site id), ngoài repo.
- Hệ quả: role `vowasia_migrator` ĐÃ BỊ XOÁ. Đọc DB cũ lần nữa (Giai đoạn B) cần tạo role lại (xem 3.6).

### 3.2 Sự kiện: báo cáo discover (số liệu, không chứa bí mật)

| Mục | Kết quả |
|---|---|
| Tổng bài vowasia | 368; lệch giả thuyết cột/bảng: 0 |
| status | published 229, archived 107, draft 20, rejected 12 |
| section | wedding-business 149, venues 93, style 70, destination-weddings 48, planning 8 |
| subsection | industry-news 125, hotels-resorts 88, honeymoons 31, rings-jewelry 26, people 19, flowers-decor 18, trends 16, guides 15, beauty 5, data-insights 5, gowns-attire 5, by-destination 4, budgets-costs 3, expert-advice 3, pre-wedding-shoots 2, checklists 1, etiquette-traditions 1, rỗng 1 |
| Năm tạo | toàn bộ 2026; 0 dòng thiếu `created_at`; 139 dòng thiếu `published_at` |
| slug | 0 rỗng, 0 trùng, 0 chữ hoa, 0 ký tự ngoài `[a-z0-9-]`, dài nhất 90 |
| body | `body_sections` dạng JSON: 200/200 mẫu; 0 tín hiệu `script`/`iframe`/`on*`/`javascript:`/`img` trong mẫu |
| ảnh bìa | `featured_image` host `<old-project-ref>.supabase.co`: 359; 9 bài không ảnh bìa |

Ghi chú nghiên cứu:
- Phát hiện cũ 13-10-26 (`content-engine` `vowasia-legacy-db-findings_REF_13-10-26.md:60`) đếm được 8 ảnh trong 818 section thân bài của bài published. Vậy thân bài CÓ ảnh; mẫu 200 dòng của discover bỏ sót. Importer phải xử lý ảnh thân bài, không tin "0 img".
- `media_assets` có 0 dòng cho vowasia (không dùng bảng này).
- Project cũ hiện banner "exceeding usage limits": RỦI RO project bị tạm dừng. Phải chép ảnh sớm (xem 3.5 bước B-M, R-B1).

### 3.3 Quyết định của chủ (19-10-26), ghi nguyên

| Mã | Quyết định |
|---|---|
| C8 | pillar = slug section cũ (`wedding-business`, `venues`, `style`, `destination-weddings`, `planning`). Sub-section = cùng slug, TRỪ: `people`->`people-planners`, `rings-jewelry`->`rings-jewellery`, `trends`->`trend-reports`, `guides`->`destination-guides`, `budgets-costs`->`budgets-real-costs`, `checklists`->`checklists-timelines`. Subsection rỗng -> chỉ pillar. Dòng nào có cặp (section, subsection) không khớp bảng này -> REJECT có báo cáo, KHÔNG đoán. (Bảng chéo theo cặp CHƯA đo; đây là suy luận từ tổng; xem KB-2.) |
| C3 | URL cũ: `vowasia.com/article/[slug]`. 301 (chủ nói 301; site phục vụ 308, xem ghi chú U10 dưới bảng) về `/<pillar>/<slug>` (GIỮ slug; route mới `/[pillar]/[article]`, Q4). Bài rejected: 410 (Q1). Nháp: không vào map. |
| C10 | Chưa có ngày cutover. VowAsia GIỮ TỐI (dark). |
| Ảnh | Tải qua HTTPS CHỈ từ host `<old-project-ref>.supabase.co` (overlay `media.hostAllowlist`); cả ảnh bìa VÀ ảnh thân bài; lưu vào bucket R2 dùng chung của Central dưới tiền tố tenant `vowasia/`; tạo bản ghi Media MỚI trong Central; credit lấy từ `featured_image_credit`. Node ảnh trong thân bài phải trỏ id Media MỚI của Central ngay lúc import (bài học sự cố brief-asia `fix-body-upload-refs`). `copy-media.ts` (R2 -> R2) KHÔNG áp dụng. 9 bài không ảnh bìa -> nhập thành nháp. |
| Giữ nguyên | C1 (6 tác giả chia đều, không tạo tác giả), C2 (published/archived giữ; draft và scheduled -> nháp; rejected bỏ), C4 (chỉ 6 tag đã chốt), C5 (bỏ SEO cũ), C6 (ảnh tối đa 20 MB, dừng nếu ảnh hỏng > 2%, ảnh lỗi -> nháp), C7 (thiếu ngày đăng -> ngày tạo), C9 (chỉ bài viết). |

**Ghi chú orchestrator (PVL-S1, U10), chủ cần được báo:** chủ nói "301". `vowasia-web` @ `da9716c` phục vụ map chính xác bằng **308** (`src/lib/redirect-middleware.ts:41`, và chuẩn hoá dấu `/` cuối cũng 308 ở `:46`); 410 ở `:39`. 308 là chuyển hướng VĨNH VIỄN, tương đương 301 với công cụ tìm kiếm (khác 301 ở chỗ giữ nguyên phương thức HTTP). Plan từ nay viết "chuyển hướng vĩnh viễn (308)". Không đổi code web. Nếu chủ muốn đúng mã 301 thì đó là việc của `vowasia-web`, ngoài plan này. Áp dụng cả cho các mục chuyển về trang pillar của Q9. Orchestrator sẽ báo chủ điều này.

**Trả lời bổ sung 19-10-26 (đóng Q1, Q4-Q11):**

| Mã | Trả lời |
|---|---|
| Q5 + Q5b (chủ) | DUYỆT cách snapshot, KÈM tải ảnh trong CÙNG một lần ngồi. CLI mới ghi NGOÀI repo: snapshot đã lọc site của bài VowAsia + dòng `sites`, kèm sha256; VÀ tải mọi ảnh bìa + ảnh thân bài (cùng luật media-fetch đã cứng hoá: chỉ host `<old-project-ref>.supabase.co`, tối đa 20 MB, kiểm magic bytes, cấm SVG) vào kho ảnh cục bộ có manifest (url -> sha256, bytes, mime). Mọi bước đo, rehearsal và import thật CHỈ đọc snapshot + kho ảnh cục bộ; import thật upload từ kho lên R2 của Central, KHÔNG đọc project cũ thêm lần nào. Lý do: banner vượt hạn mức của project cũ. Lần ngồi snapshot = một lần B3-B6 (tạo role, chạy snapshot, xoá role). |
| Q2, Q3 | Trả lời bằng bước ĐO chạy trên snapshot (không cần DB). Vẫn CHẶN B-2/B-3 tới khi đo xong. |
| Q1 (chủ) | 12 bài rejected: URL cũ trả 410. Bài nháp KHÔNG vào redirect map (như plan). |
| Q8 (chủ) | C1 phân tác giả = round-robin TRONG từng pillar qua 6 tác giả, thứ tự tất định: sắp theo `created_at` tăng dần, hoà thì `id` tăng dần; tác giả theo thứ tự cố định trong `scripts/lib/vowasia-taxonomy.ts`. Thay mô hình "quốc gia + quý". |
| Q4 (orchestrator đã kiểm) | Route bài của `vowasia-web` là `/[pillar]/[article]` (`src/app/[slug]/[article]/page.tsx`). Cũ `vowasia.com/article/[slug]` -> chuyển hướng vĩnh viễn (308, xem U10) `/<pillar>/<slug>`. Map đúng là `src/redirects/redirect-map.json` (KHÔNG phải `src/lib/redirect-config.ts`, đó là luật mẫu, trần 200). Reserved slug: đã kiểm ở VALIDATE (Q4b, mục 3.9). |
| Q6 (orchestrator) | G15a-c là các ca probe NẰM TRONG G6 (keyset-probe), không phải cổng riêng. Cổng mới bắt đầu từ G16 là đúng. |
| Q9 (chủ chọn "Chuyển về trang pillar") | URL cũ của CẢ 107 bài archived VÀ 9 bài không ảnh bìa nhập thành nháp -> chuyển hướng vĩnh viễn (map `redirect-map.json` của `vowasia-web`, phục vụ 308) về trang pillar `/<pillar>` của bài đó. Khi biên tập viên sau này đăng một bài như vậy, sinh lại map để URL cũ đi thẳng `/<pillar>/<slug>`. 12 bài rejected vẫn 410; nháp từ trạng thái cũ draft/scheduled vẫn KHÔNG vào map (không đổi). |
| Q10 (chủ chọn "Theo chuyên mục con") | Tag lấy CHỈ từ sub-section (sau ánh xạ C8), tất định: `honeymoons` -> tag `honeymoons`; `hotels-resorts` -> `wedding-venues`; `gowns-attire` và `rings-jewellery` (cũ `rings-jewelry`) -> `bridal-fashion`; `industry-news` -> `wedding-industry`; mọi sub-section khác (và rỗng) -> không tag. Cột `tags` cũ KHÔNG dùng để gắn tag (B-0b vẫn đo để ghi lại). `indian-weddings` và `elopements` không bao giờ được gắn lúc import. Có test bảng này (B-2). |
| Q11 (chủ chọn "Cho phép, chỉ trên bài do chính lần chạy đó tạo") | `rewrite-links` và `timestamps-fix.sql` là bước cập nhật sau import ĐƯỢC PHÉP, CHỈ trên dòng do CHÍNH run đó tạo (marker `legacy:vowasia` + tenant vowasia + id có trong journal của run); cả hai dry-run mặc định; rollback của run phải hoàn tác/bao phủ chúng. Đây là ngoại lệ có ghi nhận của nguyên tắc "importer chỉ tạo mới". |
| Q12 (chủ, 20-10-26, trả lời PVL B-β C7) | Nguyên văn: "Dừng ngay". Nghĩa: lỗi ở tầng lưu trữ lúc upload (sai khoá R2, R2 sập, lỗi mạng) làm DỪNG lần chạy TRƯỚC khi tạo bài đó; không tạo bài nháp thiếu ảnh; sửa nguyên nhân rồi chạy lại với run-id MỚI. C6 ("ảnh lỗi -> nháp", dừng nếu > 2%) vẫn áp dụng cho ảnh hỏng/thiếu trong snapshot/manifest (kho cục bộ). |
| Q7 (orchestrator, mặc định kỹ thuật) | Import chỉ-đọc các hàm thuần GTP + test chặn (đỏ nếu chúng đổi); chép mọi thứ mang tên/hằng GTP. D-B1 CHỐT. |

Hệ quả số (ước tính, kiểm lại ở dry-run): nhập 356 bài (368 - 12 rejected); 336 bài published/archived (229 + 107), trong đó tối đa 9 bài không ảnh bìa thành nháp, nên giữ published/archived từ 327 tới 336 bài (số chính xác lộ ở dry-run); (sửa PVL-S1, U18: số 249 cũ sai) 20 draft -> nháp; 9 bài không ảnh bìa -> nháp.

### 3.4 Thiết kế B (tái dùng tooling GTP ở mức nào)

Nguyên tắc giữ B3: KHÔNG sửa file GTP nào. Hai cách dùng lại:
- **Import chỉ-đọc (cho phép)** các hàm THUẦN, không mang tên tenant, đã có test: `lib/media-fetch.ts` (`fetchImageWithRetry`, chống SSRF, sniff MIME, giới hạn kích thước), `lib/lexical-body.ts` (`htmlToLexical`, `nodeTypes`, `plainText`), từ `lib/gtp-transform.ts` các hàm trung tính (`sanitizeLegacyHtml`, `escapeHtml`, `publishedAtFor`, `isoOrNull`, `hostAllowed`, `stripPhotoLabel`, `wordCount`; KHÔNG dùng `sectionsToHtml` cho thân bài có ảnh, xem bước 4; KHÔNG import `stableFilename`/`storedFilenameMatches` vì mang tiền tố `gtp-` ở `gtp-transform.ts:377`, chép sang vowasia với tiền tố `vowasia-`), `lib/run-dir.ts` (`RunDir`, `checkRunId`, journal ndjson; bọc thông điệp `RUN_MESSAGES.exists` ở `run-dir.ts:60` vì nó bảo "pass --resume", trái HC4; KHÔNG lấy `assertOutDirSafe` qua `run-dir.ts:10` vì nó trỏ `out-dir.ts` của GTP, vowasia dùng guard riêng và có test khẳng định), `lib/failure-controls.ts`, `lib/rollback-rules.ts` (`untouched`), `lib/load-guard.ts` (`runGuarded`). **D-B1 = import (CHỐT, Q7)** (khác O-Q1 của A) vì các file này lớn, có test, và chép sẽ tạo drift; kèm test chống drift (PVL-S1, U5): (a) golden test ghim sha256 của TỪNG file GTP được import (mẫu `golden-normalise.json`), đỏ khi một byte đổi; (b) test hành vi vowasia cho các hàm an ninh được import (host allow-list, magic bytes/cấm SVG, trần kích thước), đỏ khi GTP nới lỏng. Test "symbol tồn tại" một mình KHÔNG đủ. 
- **Chép riêng vào `scripts/migrate/vowasia/lib/`** mọi thứ mang tên/hằng GTP: marker, `IMPORT_TENANT`, mapping zod, `import-gtp-main.ts`, `rollback-main.ts`, `verify-main.ts`, `gtp-redirects.ts`, `gtp-author-distribution.ts`, `slug-plan.ts` (reserved slugs GTP), `gtp-timestamps.ts`, `stableFilename` + `storedFilenameMatches` (tiền tố `vowasia-`, U4).

Đường dữ liệu (theo thứ tự):
1. Nguồn: CHỈ snapshot + kho ảnh cục bộ (3.6, Q5). `LiveVowasiaReader` chỉ dùng bởi CLI snapshot. Importer không có đường đọc DB cũ.
2. Kế hoạch toàn tập (tất định, tính lại mỗi run, không lưu trạng thái giữa run): status (C2), taxonomy (C8 bảng cứng 3.3), slug (giữ slug cũ; va reserved của `vowasia-web` -> reject có báo cáo, không đổi slug ngầm, vì C3 giữ slug), tác giả (Q8: round-robin trong từng pillar qua 6 tác giả theo thứ tự cố định của `scripts/lib/vowasia-taxonomy.ts`; bài trong pillar sắp `created_at` rồi `id`; độ lệch ≤ 1 trong mỗi pillar), thứ tự `--limit` theo (`created_at`, `id`).
3. Ảnh (từng bài, trước khi tạo bài): thu mọi URL ảnh (bìa + thân bài) -> tra manifest kho cục bộ (url -> sha256, bytes, mime), kiểm lại sha256 tệp -> tạo Media trong Central, tenant `vowasia`, tên tệp `stableFilename` bản vowasia (tiền tố `vowasia-`), R2 tiền tố `vowasia/` (cùng cơ chế upload Payload như GTP; KHÔNG dùng `copy-media.ts`) -> ghi `media-map.ndjson` của run. Ảnh đã có (khớp `storedFilenameMatches` trong tenant vowasia) thì DÙNG LẠI, không tải lại (tạo-mới-only cho bài, dùng-lại cho media). Ảnh thiếu trong manifest/lỗi lúc tải ở snapshot/sha256 sai -> bài thành nháp + dòng báo cáo; với ảnh THÂN bài (PVL-S2, U24): bỏ hẳn đoạn ảnh đó khỏi thân bài (không bao giờ giữ URL host cũ), bài thành nháp, ghi một dòng báo cáo (nhất quán C6; vì vậy luật 'còn URL host cũ -> reject' ở bước 4 không bao giờ bị kích hoạt bởi ảnh hỏng); > 2% ảnh lỗi -> DỪNG (C6). Việc tải (`fetchImageWithRetry`, host allow-list, 20 MB, magic bytes, cấm SVG) xảy ra ở CLI snapshot, không ở import.
**[Superseded for B-beta by Amendment 4 §4.2.2 (body.en is text: escaped, split on blank lines, never parsed as HTML; no `sanitizeLegacyHtml`); kept as history.]** 4. Thân bài (sửa PVL-S1, U3): KHÔNG đi đường `sectionsToHtml` -> `<img>` -> `htmlToLexical`, vì `sectionsToHtml` (`gtp-transform.ts:219`) escape mọi chữ và bỏ section không có heading/body (`:243`) nên section ảnh mất im lặng, và `<img>` qua `convertHTMLToLexical` sinh node upload PENDING không có id Media (`@payloadcms/richtext-lexical` `dist/features/upload/server/nodes/conversions.js` `$convertUploadElement`), đúng lớp lỗi brief-asia. Thay bằng bước riêng `vowasia-body.ts`: duyệt `body_sections` -> chuỗi đoạn (chữ / ảnh); đoạn chữ -> HTML đã làm sạch (`sanitizeLegacyHtml`, cấm `script`/`iframe`/`on*`/`javascript:`) -> `htmlToLexical`; đoạn ảnh -> chèn thẳng node upload đã tuần tự hoá `{type:"upload",version:3,relationTo:"media",value:<id Media Central mới>,fields:{},id:<hex>}` (tiền lệ `scripts/migrate/import-gcv-legacy.ts:338-418`). Hậu kiểm: 0 node upload pending; mọi node `upload` có `value` là id Media tồn tại trong tenant vowasia; còn URL host cũ trong thân bài -> reject. Hình dạng phần tử ảnh trong `body_sections`: đo bằng B-0b trên snapshot (Q3, chặn B-3).
5. `title`/`excerpt` là jsonb: hình dạng đo bằng B-0b trên snapshot (Q2, chặn B-2). Importer từ chối (reject có báo cáo) mọi giá trị không đúng hình dạng đã chốt, không đoán.
6. Tạo bài: chỉ CREATE, `engineSourceName = "legacy:vowasia"`, `origin = "import"`, tenant `vowasia`, ngày đăng theo C7, credit ảnh bìa từ `featured_image_credit`, tag theo C4/Q10 (KHÔNG BAO GIỜ tạo tag, pillar, sub-section hay tác giả; thiếu -> DỪNG, xem Amendment 4 §4.3 bước 2, PVL B-β C13). Bài có legacy id đã nằm trong Central (marker vowasia + tenant vowasia, ở bất kỳ run nào) -> BỎ QUA, không sửa. Không bao giờ tạo tác giả (tác giả thiếu -> DỪNG run).
   Luật bỏ-qua / nhận-về / sập (PVL-S1, U6; không có `--resume`, legacy id KHÔNG lưu trên Articles nên nhận diện = (tenant, slug) + marker + journal cục bộ):
   - KHÔNG BAO GIỜ nhận về (adopt) một dòng vào run hiện tại. Không chép `handleExisting` của GTP (`import-gtp-main.ts:381-406`), vì nó nhận dòng marker chưa có journal vào run đang chạy, khiến rollback run B xoá nhầm dòng của run A.
   - Trước MỖI lệnh create: ghi một dòng intent `{legacyId, slug, runId, startedAt}` vào `intent.ndjson` của run, fsync. Sau MỖI lần thử create (PVL-S2, U19) ghi một dòng kết quả vào `outcome.ndjson`, fsync: `{legacyId, slug, result:"created", id}` hoặc `{legacyId, slug, result:"failed", reason}`; khi `created` thì ghi tiếp `slug-map.ndjson`.
   - Dòng intent "treo" = intent không có dòng outcome. Rollback chỉ quy một dòng intent treo về một bài Central khi ĐỦ cả năm điều kiện: (a) không có outcome `failed` cho intent đó; (b) bài khớp (tenant vowasia, slug) + marker `legacy:vowasia`; (c) id bài KHÔNG nằm trong `slug-map.ndjson` hay `outcome.ndjson` của BẤT KỲ run nào khác trong `--runs-dir`; (d) `version === 1` (trừ khi `--include-edited`); (e) `createdAt >= startedAt` của run đó (cùng ý với luật mồ côi GTP `rollback-main.ts:110`). Thiếu một điều kiện -> không xoá, in ra để chủ xử lý. Intent có outcome `failed` thì rollback bỏ qua.
   - Preflight `--apply` (U19): nếu BẤT KỲ run nào trong `--runs-dir` còn dòng intent treo -> TỪ CHỐI chạy, in run-id + slug; chủ giải quyết bằng `migrate:vowasia:rollback -- --run-id <run đó>` (rollback ghi dòng outcome `resolved` cho từng intent treo đã xử lý, xoá được hay không) rồi mới chạy run mới. Không có cờ vượt.
   - Preflight `--apply` (thêm): liệt kê mọi bài marker `legacy:vowasia` trong tenant vowasia KHÔNG có trong journal/intent của bất kỳ run nào -> TỪ CHỐI chạy, in danh sách (không có cờ vượt; chủ dùng rollback run tương ứng hoặc gỡ tay).
   - Va slug với bài vowasia KHÔNG mang marker -> reject có báo cáo (C3 giữ slug, không đổi tên).
7. Journal theo run (PVL-S1, U17: NGOÀI repo, cạnh snapshot, ví dụ `~/vowasia-private/runs/<run-id>/`, cờ `--runs-dir` bắt buộc với `--apply`; kiểm bằng guard MỚI nghiêm `assertOutsideRepo` (PVL-S2, U22: từ chối MỌI đường dẫn nằm trong cây làm việc git, kể cả thư mục bị git-ignore; `assertOutDirSafe` hiện có CHẤP NHẬN thư mục git-ignore trong repo nên KHÔNG đủ, giữ nguyên nó cho discover); lý do: `git clean -fdx` hoặc clone lại sẽ xoá journal và mất khả năng rollback theo run): `intent.ndjson`, `outcome.ndjson` (U19), `slug-map.ndjson` (legacy id, slug, id Central, baselineVersion/UpdatedAt), `media-map.ndjson`, `timestamps-baseline.json` (U7), `author-plan.json`, `rejects.ndjson`, fsync từng dòng. Không thêm trường vào `Articles`.
**[Superseded for B-beta by Amendment 4 §4.4 item 8 / G28 (CF1: `--min-coverage` numerator = published rows WITH an entry; ratio never above 1) and §4.4 item 9 / §4.2.3 (per-link rewrite answer file); kept as history.]** 8. Sau import: `rewrite-links` (second pass, dry-run mặc định, chỉ bài của run, link `/article/[slug]` nội bộ -> bài mới), `timestamps-fix.sql` (sinh sẵn, chủ chạy, `ON_ERROR_STOP`, điều kiện marker + tenant), `redirects` (PVL-S1, U10: sinh mục cho `vowasia-web` `src/redirects/redirect-map.json`, object; giá trị = chuỗi đường dẫn hoặc `{"status":410}`; khoá chuẩn hoá bằng `normalise-path.ts` trung tính của GTP (import, ghim sha256); phục vụ bởi `src/lib/redirect-middleware.ts` với 308 vĩnh viễn; map dựng từ TRẠNG THÁI Central sau import (PVL-S2, U24), không từ dự đoán: với mỗi URL cũ của bài nguồn: bài đã nhập và đang công khai (published) -> `/<pillar>/<slug>`; bài archived đã nhập -> trang pillar `/<pillar>` (Q9); bài có status cũ published/archived nhập thành nháp vì thiếu ảnh bìa -> `/<pillar>` (Q9); bài có status cũ published nhập thành nháp vì ảnh hỏng trong kho (C6) -> CÂU HỎI MỞ cho chủ (O-B12, mục 3.9), KHÔNG có mặc định: bộ sinh map DỪNG và liệt kê các bài này cho tới khi chủ trả lời (dự kiến 0 bài vì manifest 0 lỗi) (sửa PVL B-β F1, 20-10-26: bỏ "orchestrator default" cũ); bài không nhập vì status `rejected` -> `{"status":410}`; bài bị importer từ chối vì lý do khác (cặp C8 lạ, sai hình dạng title/excerpt, va slug) -> KHÔNG có mục trong map, liệt kê trong báo cáo tới khi giải quyết; nháp từ draft/scheduled cũ (chưa từng công khai) không vào map. Sinh lại map khi bài được đăng. `--min-coverage` = (số URL có mục map) / (số bài nguồn có status `published` ở site cũ).) KHÔNG dùng `src/lib/redirect-config.ts` (luật mẫu, `MAX_PATTERN_RULES` = 200), `verify`. `rewrite-links` và `timestamps-fix.sql` CHỈ đụng dòng do CHÍNH run đó tạo (Q11 đã chốt: ngoại lệ có ghi nhận; dry-run mặc định; rollback của run hoàn tác/bao phủ chúng).

CLI (dự kiến; hợp đồng mới, chỉ thêm):
- `migrate:vowasia:import` — dry-run mặc định; `--apply` cần TTY + `--confirm-host=<host>` + banner `neondb` (`assertLocalOrConfirmed` rồi `assertCentralDbName`); `--run-id <mới>` bắt buộc với `--apply`, từ chối nếu thư mục run đã tồn tại; KHÔNG có `--resume`; `--limit N`; `--snapshot <dir>` (bắt buộc; kiểm sha256 snapshot + manifest ảnh); `--expect-sha256 <digest>` (bắt buộc với `--apply`, digest MANIFEST chủ ghi lại ở OB3, U16a; manifest ghi sha256 của `snapshot.ndjson` nên MỘT digest neo cả dòng bài lẫn ảnh, PVL-S2 U23 chọn cách này, không thêm cờ `--expect-snapshot-sha256`; import kiểm sha256 `snapshot.ndjson` khớp giá trị trong manifest); `--runs-dir <ngoài repo>` (kiểm bằng `assertOutsideRepo`) (U17, U22); `--mapping-overlay <ngoài repo>`.
  - Preflight R2 (PVL-S1, U8): với Central KHÔNG phải cục bộ, `--apply` TỪ CHỐI nếu thiếu bất kỳ biến nào trong `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (thiếu thì Payload rơi về đĩa cục bộ, `payload.config.ts:60-66`, ảnh production sẽ chỉ nằm trên máy Mac). Cùng lỗ hổng tiềm ẩn ở importer GTP: chỉ ghi chú, B3 cấm sửa GTP.
  - Dry-run và run-id (PVL-S1, U9): dry-run KHÔNG BAO GIỜ tạo thư mục run có tên; dry-run từ chối `--run-id` và luôn ghi vào `dry-<timestamp>`. Vì vậy `--apply --run-id A` sau một dry-run không bị chặn (khác GTP `import-gtp-main.ts:181`).
  - `hostRewrite` (PVL-S1, U16c): overlay có `hostRewrite` (`vowasia-config.ts:73`) thì snapshot TỪ CHỐI trừ khi đích là host cục bộ (`localhost`/`127.0.0.1`/`::1`) VÀ đang ở chế độ rehearsal; nếu không `media-fetch.physicalUrl` sẽ tải `http://<đích>` mà ghi lại host hợp lệ.
- `migrate:vowasia:rollback -- --run-id <id>` — dry-run mặc định; chỉ xoá bài có marker vowasia + tenant vowasia + có trong journal của đúng run đó (dòng intent treo chỉ được quy theo năm điều kiện ở 3.4 bước 6, U19) + `untouched` (bài đã sửa tay giữ lại trừ `--include-edited`); `untouched` so với `timestamps-baseline.json` của run (cơ chế `rollback-main.ts:56` + `rollback-rules.ts`), vì sau OB9 `updated_at` đã đổi (U7); Media do run tạo chỉ xoá khi không bài nào khác dùng, kể cả dùng qua node `upload` trong THÂN bài (GTP chỉ xét `heroImage`, `rollback-main.ts:142`, không đủ cho vowasia, U7); `--list-orphans`.
- `migrate:vowasia:snapshot` (MỚI, Q5): đọc DB cũ qua role tạm, ghi snapshot + sha256 + kho ảnh + manifest NGOÀI repo (`--out` và thư mục kho ảnh kiểm bằng `assertOutsideRepo`, U22; quyền 600). `migrate:vowasia:measure` (MỚI): đo trên snapshot, không DB (Q2/Q3, bảng chéo C8 KB-2).
- `migrate:vowasia:rewrite-links`, `:redirects`, `:verify`, `:fixture`, `rehearse:vowasia`.
- `package.json`: chỉ THÊM dòng script (không đổi dòng nào khác): chặng B-α thêm 2 dòng (`migrate:vowasia:snapshot`, `migrate:vowasia:measure`); chặng B-β thêm 7 dòng còn lại; tổng 9.

### 3.5 Implementation Checklist: Giai đoạn B (thứ tự; mỗi bước có test đỏ-trước khi hợp lý)

**Chia hai chặng (PVL-S1, U14), mỗi chặng một validate contract riêng:**
- **Chặng B-α**: B-0, B-0b, B-1, fixture tối thiểu cho snapshot/measure (phần của B-11). Cổng (PVL-S2, U21): G1-G5, G6, G7 + G7b (gốc = commit trước B-α; đúng 2 dòng `package.json` mới, mọi dòng chứa `vowasia`), G7c, G8, G20, G21, phần snapshot của G18, G22 trên snapshot/measure. -> EVL -> chủ chạy OB1-OB4 + OB3b.
- **Giữa hai chặng**: plan-supplement ghi kết quả đo Q2/Q3/KB-2 (Q9/Q10/Q11 đã chốt 19-10-26), rồi inner PVL riêng cho B-β.
- **Chặng B-β**: B-2..B-14, toàn bộ G16-G22 (G19 đầy đủ), cộng G1-G8 chạy lại với G7/G7b gốc = commit cuối B-α, đúng 7 dòng `package.json` mới. Không EXECUTE B-β trước khi contract B-β có `Gate: PASS` (hoặc CONDITIONAL được chủ chấp nhận).

0. B-0 `snapshot-vowasia.ts` + `lib/snapshot-vowasia-main.ts` + test (Q5): chỉ SELECT qua builder đóng; ghi snapshot ndjson + sha256 + kho ảnh + manifest ngoài repo; luật ảnh như media-fetch; tóm tắt số ảnh lỗi. Bổ sung PVL-S1:
   - (U1) Danh sách cột cố định cho lần nạp lại `__ARTICLE_COLUMNS__` của `02` VÀ cho snapshot, không cột cá nhân (C9): `id`, `site_id`, `slug`, `status`, `section`, `subsection`, `title`, `excerpt`, `body_sections`, `featured_image`, `featured_image_credit`, `tags`, `created_at`, `published_at`, `updated_at`. Bảng `sites`: `id`, `slug`, `name`. Mở rộng `columnRoles` (`legacy-source.vowasia.json` hiện 9 vai) thêm `excerpt`, `imageCredit`, `tags`, `updatedAt`. Snapshot TỪ CHỐI chạy khi một vai bắt buộc chưa ánh xạ hoặc cột không có trong view (một lần ngồi, thiếu cột = phải ngồi lại). Tên cột thật lấy từ catalog lúc snapshot, khác giả thuyết -> sửa ở overlay, không đoán.
   - (U2) Thu URL ảnh TỔNG QUÁT trước khi biết Q3: duyệt MỌI giá trị chuỗi trong `body_sections` và các cột text/jsonb đã chụp; giữ URL có host trong allow-list; báo số URL dạng ảnh ở host khác (không tải). Manifest khoá theo URL chính xác. Test: fixture có ảnh nằm dưới khoá lạ chưa biết.
   - (U16a/b) Manifest liệt kê sha256 TỪNG tệp; tệp trong kho đặt tên bằng sha256 nội dung, không bao giờ dùng chuỗi trong manifest làm đường dẫn; manifest ghi thêm sha256 của `snapshot.ndjson` (U23); in digest của manifest để chủ ghi lại (dùng cho `--expect-sha256` ở import, neo cả dòng bài lẫn ảnh). Import kiểm lại magic bytes + kích thước từng tệp.
   - (U16d) Thứ tự trong lần ngồi: đọc dòng -> ghi snapshot -> chủ chạy `03e` (xoá role) -> TẢI ẢNH từ URL đã thu (không cần DB). Role sống ngắn nhất có thể.
   - (U16c) Luật `hostRewrite` như mục CLI 3.4.
0b. B-0b `measure-vowasia.ts` + test: trên snapshot, in hình dạng jsonb `title`/`excerpt` (Q2), vị trí/trường ảnh trong `body_sections` (Q3), bảng chéo (section, subsection) (KB-2), và cột `tags` (giá trị khác nhau + số lần, U12; CHỈ để ghi lại, Q10 không dùng cột này). Kết quả chốt B-2/B-3.
1. B-1 `lib/vowasia-mapping.ts` + test: zod strict; bảng C8 cứng (5 pillar, 6 đổi tên sub-section, rỗng -> chỉ pillar, cặp lạ -> reject); kiểm mọi pillar/sub-section đích tồn tại trong `scripts/lib/vowasia-taxonomy.ts` (sub-section phải thuộc đúng pillar); `urls.oldOrigin = https://vowasia.com`, `articlePathTemplate = /article/{slug}`, đích `/{pillar}/{slug}`, `_provisional` + `--require-final`; `media.hostAllowlist` từ overlay, test từ chối host khác.
**[Superseded for B-beta by Amendment 4 §4.2.2 / §4.4 (body text is escaped, not "cleaned" as HTML); kept as history.]** 2. B-2 `lib/vowasia-transform.ts` + test: status C2 (rejected -> skip, draft/scheduled -> nháp), C6 thiếu ảnh bìa -> nháp, C7, `title`/`excerpt` theo hình dạng đo ở B-0b (khác -> reject; CHẶN tới khi đo), làm sạch thân bài, tag theo bảng Q10 (hàm thuần sub-section -> tag; test kỳ vọng: `honeymoons`->`honeymoons`, `hotels-resorts`->`wedding-venues`, `gowns-attire`->`bridal-fashion`, `rings-jewellery`->`bridal-fashion`, `industry-news`->`wedding-industry`, sub-section khác/rỗng -> 0 tag, không bao giờ `indian-weddings`/`elopements`, cột `tags` cũ bị bỏ qua), chống drift symbol GTP đã import (D-B1).
3. B-3 `lib/vowasia-body.ts` + test: `body_sections` -> Lexical; ảnh thân bài -> node `upload` với id Media mới; hậu kiểm "0 URL host cũ còn lại"; ca thật hoá từ hình dạng Q3 (fixture có ít nhất 1 section chứa ảnh, ca 8/818).
4. B-4 `lib/vowasia-author-distribution.ts` (round-robin trong pillar, Q8) + test: thứ tự tất định (`created_at`, `id`), lệch ≤ 1 trong mỗi pillar, tính trên TOÀN tập nên hợp hai run vẫn đúng; không fallback tên chung; tác giả thiếu trong Central -> DỪNG.
5. B-5 `lib/vowasia-slug-plan.ts` + test: giữ slug cũ; reserved = `page` (đoạn thứ hai duy nhất trùng route `vowasia-web`, Q4b đã kiểm); va -> reject; va với bài vowasia không marker -> reject (U6); thứ tự `--limit` tất định.
6. B-6 `lib/vowasia-media.ts` + test: đọc kho cục bộ theo manifest, kiểm sha256 + digest `--expect-sha256` + magic bytes/kích thước lại (U16), tên tệp `stableFilename` bản `vowasia-` (U4), dùng lại media đã có, ngưỡng 2% -> dừng, KHÔNG có đường mạng, R2 tiền tố `vowasia/` (khẳng định cấu hình tiền tố tenant, không phải đường dẫn tự ghép).
7. B-7 `lib/import-vowasia-main.ts` + `import-vowasia.ts` (qua `runGuarded`): dry-run mặc định, cổng `--apply` (TTY, `--confirm-host`, banner `neondb`, run-id mới, không `--resume`, preflight R2 U8, `--expect-sha256`, `--runs-dir` ngoài repo U17), dry-run không tạo thư mục run có tên (U9), journal fsync gồm dòng intent trước create (U6) và dòng outcome sau mỗi lần thử (U19), preflight từ chối khi còn intent treo ở bất kỳ run nào (U19), `--runs-dir` qua `assertOutsideRepo` (U22), skip theo legacy id đã có, KHÔNG adopt, preflight từ chối dòng marker lạ (U6), không tạo tác giả; móc test giết tiến trình giữa create và journal.
8. B-8 `rollback-vowasia.ts` + `lib/rollback-vowasia-main.ts` + test: chỉ đúng run-id; dòng intent treo quy theo năm điều kiện (U19); test bắt buộc: (1) sập trước create rồi run B tạo cùng slug rồi rollback A -> bài của B còn nguyên; (2) create thất bại rồi run B rồi rollback A -> bài của B còn nguyên; (3) sập sau create trước journal -> rollback A xoá đúng bài đó; không chạm run khác; không chạm bài GTP (marker khác); giữ Media còn được dùng ở node `upload` trong thân bài bất kỳ (U7); `untouched` theo `timestamps-baseline.json` (U7).
**[Superseded for B-beta by Amendment 4 §4.4 (numbering and paths: B-9a/B-9b, B-12 verify, B-13 rehearsal under `fixtures/`, B-14 docs); kept as history.]** 9. B-9 `rewrite-links-vowasia.ts` (Q11: chỉ dòng của run, dry-run mặc định, rollback bao phủ), `build-vowasia-redirects.ts` (+ test định dạng `redirect-map.json`: khoá qua `normalise-path`, `/article/[slug]` -> `/<pillar>/<slug>`, `{"status":410}` cho rejected, nháp không vào map, map dựng từ trạng thái Central theo 3.4 bước 8 (U24; test: archived -> `/<pillar>`, nháp vì thiếu ảnh bìa (gốc published/archived) -> `/<pillar>`, nháp từ draft/scheduled cũ -> không mục + có trong báo cáo, nháp vì ảnh hỏng gốc published -> bộ sinh DỪNG (O-B12); bài được đăng sau đó thì map sinh lại trỏ `/<pillar>/<slug>`; bài bị importer từ chối -> không mục + có dòng báo cáo), `--min-coverage` với mẫu số = bài nguồn status `published`), `verify-vowasia.ts` (số lượng theo status, ngày, tác giả lệch ≤ 1, mọi node `upload` trỏ Media tồn tại, không URL host cũ, kiểm công khai qua `VOWASIA_READ_TOKEN` chỉ khi chủ đặt biến).
**[Superseded for B-beta by Amendment 4 §4.4 (numbering and paths: B-9a/B-9b, B-12 verify, B-13 rehearsal under `fixtures/`, B-14 docs); kept as history.]** 10. B-10 `timestamps-fix.sql` sinh theo run (đầu file: OWNER-RUN, `psql -v ON_ERROR_STOP=1`, điều kiện marker `legacy:vowasia` + tenant vowasia + id trong journal của run, Q11; rollback của run phải bao phủ).
**[Superseded for B-beta by Amendment 4 §4.4 (numbering and paths: B-9a/B-9b, B-12 verify, B-13 rehearsal under `fixtures/`, B-14 docs); kept as history.]** 11. B-11 Fixture `fixtures/vowasia-legacy/` (DB cũ tổng hợp: 2 site, một là vowasia, site id kiểu thật theo overlay; đủ ca: 5 status, cặp C8 hợp lệ + 1 cặp lạ, subsection rỗng, thiếu `published_at`, thiếu ảnh bìa, thân bài có ảnh, ảnh host lạ, ảnh hỏng, jsonb title/excerpt) + server ảnh cục bộ giả host allow-list (để test CLI snapshot) và kho ảnh + manifest mẫu (để test import).
**[Superseded for B-beta by Amendment 4 §4.4 (numbering and paths: B-9a/B-9b, B-12 verify, B-13 rehearsal under `fixtures/`, B-14 docs); kept as history.]** 12. B-12 `rehearse-vowasia.sh` + `rehearse-assert.ts` (native PG16, Central cục bộ tạm, MỘT lần, MỘT mình, nền, timeout 7200000; PVL-S1 U15: cổng riêng 54346 (DB giả cũ), 54347 (Central tạm), 3518 (Central dev) và server ảnh giả 3519, kiểm cổng trống trước khi chạy, `npm ci` TẮT mặc định (HC6), khẳng định Media có `prefix === "vowasia"`; R2 thật KHÔNG được tập (đĩa cục bộ), ghi là tồn dư; thêm ca sập: giết giữa create và journal rồi rollback đúng run đó; ca U19: giết TRƯỚC create, chạy run mới (sau khi rollback A giải quyết intent treo, vì preflight chặn) và khẳng định rollback A không chạm bài của run sau): snapshot từ DB giả -> measure -> dry-run; run A `--apply --limit 50`; run B (run-id MỚI) phần còn lại; khẳng định không trùng bài, run A không bị sửa, tác giả lệch ≤ 1 trên hợp, node upload trỏ Media mới, 0 URL host cũ; chạy lại run C (run-id mới) => 0 bài mới (idempotent bằng skip); rollback run B không chạm run A; rollback toàn bộ => 0 bài marker vowasia; đột biến (đổi marker, bỏ skip, tắt allow-list host) phải làm assert ĐỎ.
**[Superseded for B-beta by Amendment 4 §4.4 (numbering and paths: B-9a/B-9b, B-12 verify, B-13 rehearsal under `fixtures/`, B-14 docs); kept as history.]** 13. B-13 Cập nhật `VOWASIA-LEGACY.md` (phần B, tiếng Việt, từng bước chủ chạy) và `package.json` (7 dòng chặng B-β; 2 dòng chặng B-α đã thêm ở B-0/B-0b).
14. B-14 Chạy cổng (3.7) tại EVL bởi `vc-tester`; report trong thư mục task; commit/push nhánh, PR nháp.

Bước B-M (sớm, vì rủi ro project cũ bị tạm dừng; ĐÃ DUYỆT Q5+Q5b): làm B-0 trước mọi bước khác, chủ chạy OB2-OB4 ngay khi B-0 qua EVL. Ghi chú cũ: chụp snapshot NGUỒN (3.6) trước khi code B xong, để không phụ thuộc project cũ còn sống. Ảnh tải trong cùng lần ngồi snapshot (Q5b, đã duyệt).

### 3.6 Bước chủ chạy thật và khuyến nghị nguồn đọc

Hai cách (role cũ đã bị xoá):
- (i) **Lặp lại B3-B6 trong MỘT lần ngồi cho mỗi lần đọc**: tạo role (`02`, `02p`), chạy import đọc trực tiếp DB cũ, xoá role (`03e`). Nhược: mỗi run (dry-run, run A 50 bài, run B) cần DB cũ còn sống + role sống lâu hơn; project cũ có thể bị tạm dừng giữa chừng; rủi ro K2 kéo dài.
- (ii) **Snapshot (ĐÃ DUYỆT 19-10-26, kèm tải ảnh)**: MỘT lần ngồi: `02`/`02p` -> lệnh mới `migrate:vowasia:snapshot` (chỉ SELECT qua builder đóng đã có, chỉ `articles`+`sites` của vowasia, ghi `snapshot.ndjson` + sha256 vào thư mục NGOÀI repo, ví dụ `~/vowasia-private/snapshot-<ngày>/`, quyền 600) -> `03e`. Mọi run sau (dry-run, A, B, rehearsal đối chiếu) đọc `--source snapshot:<file>`, kiểm sha256 trước khi chạy. Ưu: role sống vài phút, không phụ thuộc project cũ, các run tất định trên cùng dữ liệu. Nhược: thêm 1 CLI (bước B-0 mới, trước B-1); dữ liệu cá nhân? không có (chỉ bài viết, C9). Ảnh tải vào kho cục bộ + manifest trong cùng lần ngồi; import không đọc project cũ.

Danh sách chủ chạy (theo khuyến nghị ii; ai chạy: CHỦ, máy Mac). OB1-OB4 + OB3b thuộc chặng B-α; OB5 trở đi chỉ sau contract B-β (U14):
- OB1 (= O1) dry-run `npm run audit:add-vowasia-taxonomy -- --confirm-host=<host>`: tenant `vowasia` + 49 dòng taxonomy đã có (A1). Tenant/taxonomy/6 tác giả thiếu -> DỪNG.
- OB2 SQL Editor: `02` (điền placeholder; `__ARTICLE_COLUMNS__` = đúng danh sách cột ở B-0, U1) -> `02p` (mật khẩu ở clipboard).
- OB3 `read -s LEGACY_VOWASIA_DB_URL; export ...` rồi `npm run migrate:vowasia:snapshot -- --mapping-overlay ~/vowasia-private/overlay.json --out ~/vowasia-private/snapshot-<ngày>`; lệnh chỉ đọc DÒNG và ghi snapshot rồi dừng; ghi lại digest snapshot in ra. Sau OB4 (`03e`) chạy `npm run migrate:vowasia:snapshot -- --download-images --snapshot <dir>` (không DB) để tải ảnh; ghi lại digest manifest (dùng cho `--expect-sha256`; manifest chứa sha256 của `snapshot.ndjson` nên một digest này neo cả hai, U23), xem số ảnh lỗi (U16d).
- OB3b `npm run migrate:vowasia:measure -- --snapshot <dir>` (không DB), gửi kết quả (Q2/Q3/KB-2).
- OB4 SQL Editor: `03e` -> `CLEANUP OK`; dọn mật khẩu (Notes + Recently Deleted); `unset LEGACY_VOWASIA_DB_URL`.
- OB5 In tên database (`node -e ...` phải ra `/neondb`); kiểm đủ 4 biến `R2_BUCKET`/`R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` trong `.env.local` (chỉ in TÊN biến, không in giá trị; importer cũng từ chối nếu thiếu, U8), rồi dry-run import từ snapshot; gửi báo cáo dry-run (số theo status, reject, ảnh lỗi, tác giả).
- OB6 `--apply --limit 50 --run-id <A> --runs-dir ~/vowasia-private/runs --expect-sha256 <digest>`; sau đó sao lưu `~/vowasia-private/` (journal + snapshot + kho ảnh) sang ổ khác (U17); xem bằng mắt trong /admin (tenant vowasia, ảnh bìa + ảnh thân bài, tác giả, pillar).
- OB7 `--apply --run-id <B MỚI>` phần còn lại (KHÔNG `--resume`; bài của A bị bỏ qua).
- OB8 `rewrite-links` dry-run rồi `--apply`; OB9 chạy `timestamps-fix.sql` (Neon, `ON_ERROR_STOP`); OB10 `verify`; OB11 sinh mục `redirect-map.json`, chuyển cho `vowasia-web` KHI có cutover (C10: chưa, giữ tối).
- OB12 (U16e) Lưu giữ: sau verify và sau cutover, chủ xoá hoặc lưu trữ mã hoá snapshot + kho ảnh + journal (journal giữ tới khi chắc không cần rollback nữa).
- Rollback bất cứ lúc nào: `migrate:vowasia:rollback -- --run-id <id>` (dry-run trước).

### 3.7 Cổng (G1-G14 giữ nguyên, G15a-c nằm trong G6, + mới từ G16)

**[Superseded for B-beta by Amendment 4 §4.5 "Phase-A gates kept for B-beta" (exact list and commands; G22 replaces G9); kept as history.]** Cổng A vẫn chạy lại để chứng minh không vỡ: G1-G5, G6, G7c, G8 (GTP không đổi byte; G7/G7b theo từng chặng (U21): B-α gốc = commit trước B-α, đúng 2 dòng `package.json` mới; B-β gốc = commit cuối B-α, đúng 7 dòng mới; mọi dòng chứa `vowasia`; G1 và G6 chạy lại vì `vowasia-config.ts`/`legacy-source.vowasia.json` đổi (U20)), G9 (review mọi SQL/CLI ghi), G10/G10a/G10c, G13, G14. G15a-c là ca probe bên trong G6, không phải cổng riêng; cổng mới bắt đầu từ G16 (Q6).

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| G16 `npm run test:migrate-vowasia` mở rộng (mapping C8, transform, body: 0 node upload pending + node upload tuần tự hoá trỏ id mới (U3), author, slug, media tiền tố `vowasia-` (U4), rollback rules gồm tham chiếu thân bài + baseline (U7), redirect định dạng `redirect-map.json` (U10), chống drift D-B1 bằng ghim sha256 + test hành vi (U5)) | Fully-Automated | AC-B1 C8 đúng bảng, cặp lạ reject; AC-B2 C2/C6/C7; AC-B4 round-robin trong pillar tất định, lệch ≤1, không tạo tác giả; AC-B11 redirect vĩnh viễn (308); AC-B12 bảng tag Q10 |
| G17 test cổng `--apply`: thiếu TTY, thiếu/sai `--confirm-host`, DB không `/neondb`, run-id đã tồn tại, có cờ `--resume`, Central không cục bộ mà thiếu biến R2 (U8), dry-run kèm `--run-id` / dry-run tạo thư mục có tên (U9), `--runs-dir` trong repo kể cả thư mục git-ignore (U17, U22), còn intent treo ở run bất kỳ (U19), thiếu/sai `--expect-sha256` (U16), dòng marker lạ không có journal (U6) -> từ chối | Fully-Automated | AC-B5 an toàn ghi |
| G18 test media: CLI snapshot (host lạ, http, > 20 MB, redirect sang host khác, magic bytes sai, SVG -> loại; URL dưới khoá lạ vẫn được thu (U2); `hostRewrite` không cục bộ -> từ chối (U16c); tệp kho đặt tên theo sha256 (U16b)); import đọc kho (sha256 sai/thiếu -> nháp, > 2% -> dừng, không gọi mạng); node `upload` trỏ id mới | Fully-Automated | AC-B3 ảnh |
| G19 `npm run rehearse:vowasia` (MỘT lần, một mình, nền, timeout 7200000, `REHEARSE_MODE=native`, cổng riêng 54346/54347/3518/3519, U15) gồm ca run A/B/C + ca sập giữa create và journal rồi rollback run đó (U6) + ca sập trước create / create thất bại rồi run sau, rollback A không chạm bài run sau (U19) + rollback + Media `prefix === "vowasia"` + đột biến đỏ | Hybrid (PG16 cục bộ + Central cục bộ tạm) | AC-B5, AC-B6 rollback theo run, AC-B7 lần chạy thứ hai |
| G20 `git diff --quiet <base> -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` (GTP 0 byte) + `npm run test:migrate-gtp` | Fully-Automated | AC-B8 không đổi GTP |
| G21 test snapshot + measure: sha256 snapshot/manifest sai -> từ chối; measure không mở kết nối DB; ghi chỉ ngoài repo (`assertOutsideRepo`: thư mục trong repo, kể cả git-ignore, -> từ chối, U22); sha256 `snapshot.ndjson` khác giá trị trong manifest -> từ chối (U23); chỉ SELECT trong query-log | Fully-Automated | AC-B9 snapshot an toàn |
| G22 review `vc-code-reviewer` trên import/rollback/snapshot/SQL sinh ra | Agent-Probe | AC-B5, AC-B9 |
| G23 dry-run + run thật trên `neondb` (chủ chạy OB5-OB10) | **Known-Gap** (backlog stub; giữ B ở CONDITIONAL tới khi chủ chạy) | AC-B10 dữ liệu thật |
| G16b test redirect (B-9): mục map dựng từ trạng thái Central (U24) | Fully-Automated | AC-B11, AC-B13 |
| G11 `rehearse:gtp` (EVL B-β, CHỈ sau khi G19 đã kết thúc; không bao giờ chạy song song với G19 hay probe khác; xem 4.5) | Hybrid | ràng buộc 9 |

Danh sách AC giai đoạn B (PVL-S2, U25): AC-B1 C8 đúng bảng, cặp lạ reject; AC-B2 C2/C6/C7; AC-B3 ảnh (kho, sha256, node upload trỏ id mới, ảnh thân bài hỏng -> bỏ đoạn + nháp); AC-B4 round-robin tác giả; AC-B5 an toàn ghi; AC-B6 rollback theo run, không bao giờ chạm bài run khác (gồm intent treo, U19); AC-B7 lần chạy thứ hai 0 bài mới; AC-B8 không đổi GTP; AC-B9 snapshot an toàn, chỉ ngoài repo; AC-B10 dữ liệu thật; AC-B11 redirect vĩnh viễn (308): published -> `/<pillar>/<slug>`, archived và nháp-vì-thiếu-ảnh-bìa (Q9) -> `/<pillar>`, nháp từ draft/scheduled cũ -> KHÔNG mục, chỉ có trong báo cáo (C3, Q1, Q9), nháp-vì-ảnh-hỏng gốc published -> DỪNG chờ chủ (O-B12), rejected -> 410, importer từ chối -> không mục + báo cáo; với dữ liệu thật: 349 mục (12 x 410 + 337 x 308); AC-B12 bảng tag Q10 (5 cặp sub-section -> tag, còn lại 0 tag, không `indian-weddings`/`elopements`, bỏ cột `tags` cũ); AC-B13 `--min-coverage` mẫu số = bài nguồn status `published`.

### 3.8 Touchpoints, Public Contracts, Blast Radius (Giai đoạn B)

- Touchpoints (PVL-S2, U20; mọi đường dẫn dưới `scripts/migrate/vowasia/` trừ khi ghi khác; file ngoài danh sách -> HS2 dừng):
  - Chặng B-α, file ĐÃ CÓ (giai đoạn A) được sửa: `lib/vowasia-config.ts` (thêm `excerpt`, `imageCredit`, `tags`, `updatedAt` vào enum `ROLE_NAMES`, U1) + test của nó; `legacy-source.vowasia.json` (thêm 4 vai `columnRoles`, U1); `fixtures/overlay.fixture.json` và mọi fixture/test giai đoạn A đọc cấu hình đó (để vai mới hợp lệ); `package.json` (2 dòng). Vì đầu vào cấu hình/reader đổi nên chạy lại G1 và G6.
  - Chặng B-α, file MỚI: `snapshot-vowasia.ts`, `lib/snapshot-vowasia-main.ts` (+ test); `lib/vowasia-mapping.ts` (+ test, B-1; sửa chữ PVL-S3 V-W1: B-1 thuộc chặng B-α theo dòng chia chặng ở 3.5); `measure-vowasia.ts`, `lib/measure-vowasia-main.ts` (+ test); `lib/assert-outside-repo.ts` (+ test, guard nghiêm U22); `lib/vowasia-stable-filename.ts` (+ test, bản `stableFilename` tiền tố `vowasia-`, U4); `lib/gtp-import-pins.ts` hoặc tệp ghim sha256 tương đương (+ test, U5); fixture tối thiểu snapshot/measure dưới `fixtures/vowasia-legacy/` và server ảnh giả.
  - Chặng B-β, file ĐÃ CÓ được sửa: `VOWASIA-LEGACY.md`; `package.json` (7 dòng); fixture `fixtures/vowasia-legacy/**` mở rộng.
  - Chặng B-β, file MỚI: `lib/vowasia-{transform,body,author-distribution,slug-plan,media}.ts` (+ test), `lib/{import,rollback,verify,rewrite-links}-vowasia-main.ts` (+ test), CLI `import-vowasia.ts`, `rollback-vowasia.ts`, `rewrite-links-vowasia.ts`, `build-vowasia-redirects.ts` (+ test), `verify-vowasia.ts`, `lib/vowasia-timestamps.ts` (+ test, bản sao bộ sinh `gtp-timestamps.ts` cho B-10), `fixtures/rehearse-vowasia.sh`, `fixtures/rehearse-assert.ts`, `fixtures/rehearse-bootstrap.ts`, `fixtures/vowasia-legacy/seed-vowasia-legacy-fixture.ts` (đường dẫn chốt ở Amendment 4 §4.4 mục 11, 13); backlog stub G23.
  - Chỉ ĐỌC (import) các file GTP liệt kê ở 3.4.
- Public Contracts mới: 9 npm script; định dạng snapshot + manifest ảnh; journal run (định dạng ndjson riêng vowasia, NGOÀI repo); marker `legacy:vowasia`; mục cho `vowasia-web` `src/redirects/redirect-map.json` (giá trị chuỗi hoặc `{"status":410}`, khoá qua `normalise-path`, phục vụ 308 vĩnh viễn bởi `src/lib/redirect-middleware.ts:41`; KHÔNG phải `src/lib/redirect-config.ts`). Không đổi schema Payload, không migration, không đổi API.
- Blast Radius: dữ liệu Central tenant `vowasia` (bài + Media + object R2 dưới `vowasia/`) KHI chủ chạy `--apply`; không chạm tenant khác (mọi truy vấn qua tenant filter; rollback lọc marker + tenant + run). Tenant vowasia đang TỐI nên không ảnh hưởng người đọc. DB cũ: chỉ đọc qua role tạm.
- Rủi ro chính: R-B1 project cũ bị tạm dừng (giảm bằng snapshot + ảnh sớm, Q5/Q5b đã duyệt); R-B2 node ảnh thân bài trỏ sai (giảm bằng hậu kiểm + verify); R-B3 cặp C8 lạ nhiều hơn dự kiến (dry-run lộ ra, reject, chủ quyết); R-B4 Media trùng khi chạy lại (dùng lại theo tên tệp ổn định); R-B5 webhook revalidate vowasia lỗi khi lưu bài (best-effort, như GTP; ghi chú).

### 3.9 Câu hỏi mở cho chủ

Đã đóng 19-10-26: Q1, Q4, Q5, Q5b, Q6, Q7, Q8, Q9 (về trang pillar), Q10 (tag theo sub-section), Q11 (cho phép, chỉ dòng của run) (xem bảng "Trả lời bổ sung" ở 3.3).

Còn mở / còn chặn: **[For B-beta: Q2, Q3 and KB-2 are closed by Amendment 4 §4.1; only O-B5 and O-B12 remain open.]**
- **[Closed by Amendment 4 §4.1: `object{en}`, 370/370.]** Q2 Hình dạng jsonb `title`/`excerpt`: đo bằng B-0b trên snapshot. CHẶN B-2.
- **[Closed by Amendment 4 §4.1.]** Q3 Vị trí/trường ảnh trong `body_sections`: đo bằng B-0b trên snapshot. CHẶN B-3.
- Q4b ĐÃ TRẢ LỜI (VALIDATE 19-10-26, `vowasia-web` @ `da9716c`): route bài là `src/app/[slug]/[article]/page.tsx` (hai đoạn); route khác duy nhất dưới pillar là phân trang `src/app/[slug]/page/[n]`. Reserved slug đoạn thứ hai duy nhất: `page` (phòng thủ). `preview`, `api`, `search`, `feed.xml` và các khoá DOCS chỉ là đoạn đầu, không bao giờ là pillar. Không pillar/khoá DOCS nào là `article`, nên `/article/<slug>` trống cho map. Discover: 0 slug không an toàn.
- KB-2 đối chiếu (VALIDATE 19-10-26): tổng khớp đúng nếu mọi subsection nằm dưới pillar tự nhiên: wedding-business 149 = 125+19+5; venues 93 = 88+4+1 (rỗng); style 70 = 26+18+16+5+5; destination-weddings 48 = 31+15+2; planning 8 = 3+3+1+1. Mọi đích C8 có trong `scripts/lib/vowasia-taxonomy.ts` đúng pillar. Số học không phải bằng chứng (hoán đổi có thể cân nhau) nên bảng cặp B-0b vẫn bắt buộc; rủi ro thấp.

- O-B12 (mở 20-10-26, PVL B-β F1): bài có status cũ published bị nhập thành nháp vì ảnh hỏng/thiếu trong kho (C6) thì URL cũ chuyển đi đâu? Q9 chỉ nói bài archived và bài thiếu ảnh bìa; C3 nói "Nháp: không vào map". Hai luật đã viết không quyết rõ ca này, nên KHÔNG có mặc định: bộ sinh map DỪNG và liệt kê. Dự kiến 0 bài (manifest 0 lỗi), nên không chặn B-β; chỉ chặn OB11 nếu thật sự có bài như vậy.
- O-B5 (mở 20-10-26, PVL B-β C2): 4 URL trong chữ thân bài ngoài allow-list: chủ xem phân loại ở dry-run OB5 và trả lời trước OB6 (xem Amendment 4 §4.2.3). **[Answer form: per-link answer file, Amendment 4 §4.2.3.]**

Known-Gap B (có tên): KB-1 TLS pooler không kiểm chứng chỉ (`ssl=require`); KB-2 bảng chéo cặp (section, subsection) chưa đo (dry-run sẽ lộ); KB-3 G23 dữ liệu thật; KB-4 ảnh thân bài chỉ biết qua mẫu cũ 8/818; KB-5 K2-K6 Amendment 2 vẫn áp dụng cho lần tạo role kế tiếp. KB-6 (U15) rehearsal không tập R2 thật (đĩa cục bộ); upload R2 chỉ chứng minh ở G23. **[KB-2 closed by Amendment 4 §4.1: zero rejects.]**

### 3.10 Chiến lược thực thi

`vc-agent-strategy-compare`: S2, S6, S7 có (3/7). Khuyến nghị PVL: 3 parallel subagents sonnet (an toàn ghi/rollback; dữ liệu/mapping/ảnh; khả thi rehearsal). EXECUTE: 1 agent opus tuần tự (file gắn chặt). EVL: `vc-tester` sonnet; G19 chạy một mình.

### Validate Contract (Chặng B-α)

Status: PASS
Date: 19-10-26
date: 2026-10-19
generated-by: inner-pvl: phase-B (chặng B-α)

Phạm vi PASS: CHỈ chặng B-α (B-0 snapshot, B-0b measure, B-1 mapping, fixture tối thiểu snapshot/measure + server ảnh giả, các file MỚI/SỬA của chặng B-α ở 3.8). Chặng B-β (B-2..B-14) KHÔNG được EXECUTE: nó chờ kết quả đo B-0b (Q2, Q3, KB-2) do chủ chạy (OB3b), một plan-supplement ghi kết quả đo, rồi inner PVL riêng với contract riêng (xem `### Validate Contract (Chặng B-β)` bên dưới). Không có contract trước đó cho Giai đoạn B nên không có dòng `supersedes:`; `## Validate Contract` (Giai đoạn A, outer-pvl, 16-10-26) giữ nguyên, không bị thay.

Parallel strategy: sequential (EXECUTE B-α: MỘT `vc-execute-agent` opus tuần tự; EVL: MỘT `vc-tester` sonnet; G22: MỘT `vc-code-reviewer` sonnet)
Rationale: 7 tín hiệu = 3/7 (S2 bề mặt DB cũ qua role tạm; S6 trust-boundary/secret: URL DB cũ trong env, kho ảnh tải từ host ngoài; S7: khoảng 14 file mới + 4 file sửa). Ngưỡng 2-3 nghiêng parallel subagents, nhưng các file gắn chặt (snapshot dùng config, guard, pins, mapping cùng một cây test) nên tuần tự là đúng việc. Model: opus chỉ cho EXECUTE; còn lại sonnet.

Bằng chứng PVL-S3 (chỉ đọc, 19-10-26, HEAD `84928ca`, cây sạch trước khi ghi contract): `validate-plan-artifact.mjs` 0 FAIL / 0 warning; `test:migrate-vowasia` 59/59; `test:migrate-gtp` 69/69; `lint:migrate` 0 lỗi + 1 cảnh báo có sẵn (`seed-gtp-legacy-fixture.ts:179 't50sec'`); `typecheck` exit 0; `git diff --quiet fe88bc4 HEAD -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` exit 0; G7 hiện chỉ in `package.json` (3 dòng giai đoạn A); G7c rỗng.

Kiểm lại U19-U25 (cycle 2) trong plan đã supplement (`84928ca`):
- U19 ĐÃ XỬ LÝ: dòng outcome sau mỗi lần thử create (L696); intent treo chỉ quy về bài khi đủ 5 điều kiện (a) không `failed`, (b) (tenant, slug) + marker, (c) id không thuộc run khác, (d) `version === 1`, (e) `createdAt >= startedAt` (L697); preflight `--apply` từ chối khi BẤT KỲ run nào còn intent treo, rollback ghi `resolved` (L698); B-7 (L734), B-8 ba ca bắt buộc (L735), B-12 ca U19 (L739), G17 (L771), G19 (L773), AC-B6 (L781). Kịch bản cycle 2 (sập trước create, run B tạo cùng slug, rollback A xoá nhầm) nay không xảy ra: run B không chạy được khi A còn intent treo, và sau khi A được resolve thì intent không còn "treo".
- U20 ĐÃ XỬ LÝ: Touchpoints chia theo chặng, liệt kê file giai đoạn A bị sửa kèm lý do (L786) và mọi file mới (L787, L789); G1/G6 chạy lại (L766). Đối chiếu code: `ROLE_NAMES` ở `vowasia-config.ts:65` là enum strict (`:68`), mọi vai `.optional()`, nên thêm 4 vai không làm hỏng overlay fixture; `discover-vowasia.ts:103` chỉ ghi "role skipped" khi cột vai không có, không chặn. Test mới nằm ở `lib/*.test.ts` được glob `test:migrate-vowasia` (`package.json:49`) tự nhặt, nên không phải đổi dòng `package.json` nào. Một lệch chặng còn sót (B-1 `vowasia-mapping.ts` thuộc B-α theo L717 nhưng nằm trong danh sách B-β) đã được validator sửa chữ, xem V-W1.
- U21 ĐÃ XỬ LÝ: B-α có G6, G7 + G7b (gốc riêng, đúng 2 dòng), G7c (L717); B-β gốc = commit cuối B-α, 7 dòng (L719, L766).
- U22 ĐÃ XỬ LÝ: guard mới `assertOutsideRepo` từ chối cả thư mục git-ignore trong repo (L701, L710, L787), `assertOutDirSafe` giữ nguyên cho discover; G17/G21 có ca thư mục git-ignore trong repo (L771, L775). Đối chiếu code: `scripts/migrate/vowasia/lib/out-dir.ts` đúng là CHẤP NHẬN thư mục git-ignore trong repo.
- U23 ĐÃ XỬ LÝ: manifest ghi sha256 của `snapshot.ndjson`, MỘT digest `--expect-sha256` neo cả dòng bài lẫn ảnh (L705, L724, L754); G21 có ca lệch (L775).
- U24 ĐÃ XỬ LÝ (với một chỗ chưa chặt ở B-β, xem CF1): ảnh thân bài hỏng -> bỏ đoạn ảnh, nháp, dòng báo cáo (L690); map dựng từ trạng thái Central, nhập-nhưng-không-công-khai -> `/<pillar>` từng là mặc định của orchestrator (L702) [ĐÃ RÚT 20-10-26, PVL B-β F1: map theo đúng C3/Q1/Q9, xem Amendment 4 §4.2.7]; bị importer từ chối -> không mục + báo cáo; G16b + AC-B11/AC-B13 (L778, L781).
- U25 ĐÃ XỬ LÝ: G16 ghi "redirect vĩnh viễn (308)" và AC-B12 (L770); danh sách AC-B1..AC-B13 riêng (L781).

Sửa chữ do validate-agent áp dụng ở PVL-S3 (V6 bước 1; chỉ đổi nhãn chặng, không đổi phạm vi/file/cổng):
- V-W2 (dòng Status đầu Amendment 3): trỏ tới hai contract theo chặng thay cho tên placeholder cũ.
- V-W1 (3.8 Touchpoints): chuyển `lib/vowasia-mapping.ts` (+ test, B-1) từ danh sách "Chặng B-β, file MỚI" sang "Chặng B-α, file MỚI", khớp dòng chia chặng L717 (B-1 thuộc B-α). Không sửa thì EXECUTE B-α có thể dừng ở HS2 khi viết B-1.

Test gates (C3 5-column table, chặng B-α; gốc `BASE_BA = 84928ca`, hoặc bất kỳ commit sau đó chỉ đổi `process/`; executor kiểm lúc bắt đầu `git diff --name-only 84928ca HEAD -- . ':(exclude)process'` phải rỗng và ghi `BASE_BA` vào report):

| criterion id | behavior | strategy | proving test | gap-resolution |
|---|---|---|---|---|
| AC-B9, AC-B3 (phần snapshot), AC-B1 (B-1) | snapshot/measure/mapping/guard/pins/stableFilename đúng; test mới ở `lib/*.test.ts` | Fully-Automated | G1 `npm run test:migrate-vowasia` (59 test cũ vẫn xanh + test mới; gồm G18 phần snapshot và G21) | B |
| AC-B9 | snapshot chỉ SELECT qua builder đóng, cột bắt buộc thiếu -> từ chối, sha256 snapshot/manifest sai -> từ chối, measure không mở DB, ghi chỉ ngoài repo (`assertOutsideRepo`, kể cả thư mục git-ignore trong repo và symlink trỏ vào repo -> từ chối) | Fully-Automated | G21 (trong G1): `snapshot-vowasia-main.test.ts`, `measure-vowasia-main.test.ts`, `assert-outside-repo.test.ts` | B |
| AC-B3 (phần tải ảnh) | host lạ, http, > 20 MB, redirect sang host khác, magic bytes sai, SVG -> loại; URL dưới khoá JSON lạ vẫn được thu (U2); `hostRewrite` không cục bộ hoặc ngoài chế độ rehearsal -> từ chối (U16c); tệp kho đặt tên theo sha256 (U16b) | Fully-Automated | G18 phần snapshot (trong G1), server ảnh giả cục bộ | B |
| D-B1 | chống drift hàm GTP import chỉ-đọc: ghim sha256 từng file + test hành vi an ninh | Fully-Automated | `gtp-import-pins` test (trong G1) | B |
| AC-B1 | bảng C8 cứng: 5 pillar, 6 đổi tên, rỗng -> chỉ pillar, cặp lạ -> reject, mọi đích có trong `vowasia-taxonomy.ts` đúng pillar | Fully-Automated | `vowasia-mapping.test.ts` (trong G1) | B |
| AC-A* (không vỡ A) | config/reader/discover/role SQL vẫn đúng sau khi thêm 4 vai | Hybrid (PG16 native cục bộ, cổng 54331-54339; điều kiện `/usr/lib/postgresql/16/bin`, `runuser`) | G6 `npm run probe:migrate-vowasia` (chạy MỘT MÌNH) | A |
| chất lượng | lint + kiểu | Fully-Automated | G2 `npm run lint:migrate` (0 lỗi), G3 `npm run typecheck` (exit 0) | A |
| AC-B8 | GTP không đổi | Fully-Automated | G4 `npm run test:migrate-gtp` (69/69), G5 `npm run test:single-home`, G8/G20 `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` exit 0 | A |
| AC-B8 | chỉ file được phép đổi | Fully-Automated | G7 `git diff --name-only 84928ca -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` chỉ in `package.json`; G7b `git diff -U0 84928ca -- package.json \| grep -E '^\+[^+]'` đúng 2 dòng (`migrate:vowasia:snapshot`, `migrate:vowasia:measure`), mọi dòng chứa `vowasia`, VÀ `git diff -U0 84928ca -- package.json \| grep -E '^-[^-]'` rỗng; G7c `! git ls-files --others --exclude-standard \| grep -vE "^(scripts/migrate/vowasia/\|process/general-plans/)"` | B |
| HS1 (SQL không đổi) | B-α không chạm SQL chủ chạy | Fully-Automated | `git diff --quiet 84928ca -- scripts/migrate/vowasia/sql` exit 0; G10/G10a/G10c và G13 chạy lại như giai đoạn A | A |
| AC-B5, AC-B9 | review snapshot/measure/guard/pins/mapping (secret không in, không ghi ngoài thư mục chỉ định, chỉ SELECT) | Agent-Probe | G22 `vc-code-reviewer` (sonnet) | B |
| AC-B9 (dữ liệu thật) | snapshot thật trên DB cũ (OB2-OB4 + OB3b), 368 dòng, số ảnh lỗi, digest | (residual, xem dưới) | chủ chạy; kết quả ghi vào report task | C |

Failing stub (G1/G21, red-first, tên khớp kịch bản):
test("should refuse a snapshot --out inside the repo even when git-ignored", () => { throw new Error("NOT IMPLEMENTED — TDD stub: assertOutsideRepo refuses in-repo git-ignored dir") })
test("should refuse to snapshot when a required column role is not in the view catalog", () => { throw new Error("NOT IMPLEMENTED — TDD stub: snapshot refuses missing required column") })
test("should refuse import input when snapshot.ndjson sha256 differs from the manifest", () => { throw new Error("NOT IMPLEMENTED — TDD stub: manifest anchors snapshot digest") })
test("should never open a DB connection in measure", () => { throw new Error("NOT IMPLEMENTED — TDD stub: measure is offline") })
Failing stub (G18 phần snapshot):
test("should collect an allow-listed image URL found under an unknown JSON key", () => { throw new Error("NOT IMPLEMENTED — TDD stub: generic URL collection U2") })
test("should reject SVG, wrong magic bytes, over 20 MB, non-https and off-allowlist redirects", () => { throw new Error("NOT IMPLEMENTED — TDD stub: hardened fetch rules") })
test("should refuse hostRewrite outside explicit rehearsal mode", () => { throw new Error("NOT IMPLEMENTED — TDD stub: hostRewrite U16c") })
Failing stub (D-B1):
test("should fail when any imported GTP file changes by one byte", () => { throw new Error("NOT IMPLEMENTED — TDD stub: sha256 pins") })
Failing stub (AC-B1):
test("should map the 6 renamed sub-sections and reject an unknown (section, subsection) pair", () => { throw new Error("NOT IMPLEMENTED — TDD stub: C8 table") })
Failing stub (G7b, lệnh, không phải test file): đỏ trước khi thêm 2 dòng (đếm 0), xanh khi đúng 2.

Legacy line form:
- snapshot/measure/mapping/guard: Fully-automated: `npm run test:migrate-vowasia`
- không vỡ A: hybrid: `npm run probe:migrate-vowasia` + precondition PG16 native, chạy một mình
- GTP không đổi: Fully-automated: `npm run test:migrate-gtp`; `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'`
- phạm vi file: Fully-automated: G7, G7b, G7c như bảng
- review: agent-probe: `vc-code-reviewer` trên file B-α
- snapshot thật: known-gap: documented (owner-run OB2-OB4, OB3b)

Dimension findings:
- Infra fit: PASS — guard mới nghiêm cho snapshot `--out`/kho ảnh; cổng probe riêng; không chạm Central, không R2, không DB ở B-α trừ lần đọc DB cũ do chủ chạy.
- Test coverage: PASS — mọi hành vi B-α có cổng Fully-Automated (G1/G21/G18 phần snapshot) hoặc Hybrid (G6); snapshot thật là residual có tên.
- Breaking changes: PASS — chỉ thêm 2 dòng `package.json`; thêm vai tuỳ chọn vào enum (tương thích ngược); không đổi schema Payload, API, GTP.
- Security surface: PASS — chỉ SELECT qua builder đóng; URL DB chỉ qua env; kho ảnh ngoài repo, quyền 600; repo PUBLIC nên fixture chỉ dùng host giả (E-B5). High-risk pack: có (trust-boundary/secret).
- 3.1/3.2/3.3 sự kiện và quyết định: PASS
- 3.4 thiết kế: PASS (phần B-β có CF1-CF5 cho PVL B-β)
- 3.5 checklist/chặng: PASS — B-α khả thi cơ học: reader `pages()` nhận danh sách cột bất kỳ đã có trong catalog (`vowasia-reader.ts:79-87`), builder `keysetPage` sẵn (`vowasia-sql.ts:181-193`), không cần sửa builder/reader.
- 3.6 bước chủ: PASS
- 3.7 cổng: PASS
- 3.8 touchpoints: PASS sau V-W1
- 3.9 câu hỏi mở: PASS (Q2/Q3/KB-2 chặn B-β theo thiết kế)

Execute-agent instructions (chặng B-α):
- E-B1 Red-first: viết các failing stub ở trên trước code; ghi trong report test nào đỏ trước.
- E-B2 `LiveVowasiaReader.pages()` LẶNG LẼ bỏ cột không có trong catalog (`vowasia-reader.ts:85`: `columns.filter((c) => known.has(c))`). Snapshot PHẢI tự kiểm mọi cột của vai bắt buộc với `reader.columns("articles")` sau `loadCatalog()` và TỪ CHỐI trước khi đọc dòng (L722 U1). Không sửa reader (file giai đoạn A ngoài danh sách sửa).
- E-B3 `assertOutsideRepo`: so `realpath` của tổ tiên gần nhất đang tồn tại (bắt symlink trỏ vào repo) với `repoRoot()` của `scripts/migrate/vowasia/lib/out-dir.ts` (4 cấp); bằng hoặc nằm trong -> từ chối. Có test: thư mục git-ignore trong repo, symlink ngoài repo trỏ vào repo, thư mục chưa tồn tại ngoài repo (chấp nhận, tạo mode 700).
- E-B4 Chế độ rehearsal cho `hostRewrite` phải là cờ CLI tường minh, mặc định tắt (không suy ra từ env), test cả hai nhánh.
- E-B5 Repo PUBLIC: fixture và test chỉ dùng host giả (`*.invalid`/`localhost`), không bao giờ ghi ref project cũ thật, không dữ liệu thật, không URL DB.
- E-B6 Tệp ghim sha256 (U5) ghim NGAY ở B-α TOÀN BỘ file GTP liệt kê ở 3.4 để import chỉ-đọc (`media-fetch.ts`, `lexical-body.ts`, `gtp-transform.ts` + `gtp-mapping.ts` mà nó import kiểu, `run-dir.ts` + `out-dir.ts` (GTP) mà nó import, `failure-controls.ts`, `rollback-rules.ts`, `load-guard.ts`, `normalise-path.ts`), để B-β không phải sửa tệp ghim.
- E-B7 Test mới đặt trong `scripts/migrate/vowasia/lib/*.test.ts` (glob G1); không đổi dòng script nào có sẵn.
- E-B8 Snapshot ghi `query-log.json` (chỉ SELECT) vào thư mục ra như discover; không in site id, URL DB, mật khẩu, nội dung bài ra stdout/stderr.
- E-B9 Trước OB2: so 15 tên cột ở L722 với báo cáo schema của discover trên máy chủ (mục 6b của 01) để `02` điền đúng ngay lần đầu.
- E-B10 G6 chạy MỘT MÌNH; không chạy song song `npm ci` hay probe khác; `rehearse:vowasia`/`rehearse:gtp` KHÔNG chạy ở B-α.
- E-B11 Không sửa file GTP, SQL (`sql/**`), `VOWASIA-LEGACY.md` (B-β), hay file nào ngoài 3.8 B-α -> HS2 dừng.

Open gaps:
- Snapshot thật (OB2-OB4 + OB3b) chỉ chứng minh khi chủ chạy; bằng chứng cần thu: digest snapshot + digest manifest, 368 dòng, số ảnh tải lỗi, kết quả measure (Q2/Q3/KB-2). Gap-resolution C (đi vào plan-supplement giữa hai chặng).
- KB-1 (TLS pooler không kiểm chứng chỉ), KB-5 (K2-K6 cho lần tạo role kế tiếp): giữ nguyên.

**What This Coverage Does NOT Prove** (chặng B-α):

- G1/G21/G18 phần snapshot: chạy trên DB giả qua client giả và server ảnh giả; KHÔNG chứng minh tên cột thật của view, tốc độ/giới hạn của pooler, hay hành vi host ảnh thật (CDN, redirect thật, giới hạn băng thông khi project cũ vượt hạn mức).
- G6: chứng minh reader/discover/role SQL trên PG16 cục bộ; KHÔNG chạy CLI snapshot trên PG thật.
- G7/G7b/G7c/G8: chứng minh phạm vi file, không chứng minh hành vi.
- G22: phán đoán của reviewer, không phải bằng chứng máy.
- Không cổng B-α nào chứng minh import, rollback, redirect, Central, R2 (tất cả thuộc B-β).

Gate: PASS (0 FAIL, 0 CONCERN mở cho chặng B-α; U1-U25 đã xử lý; V-W1 do validator sửa chữ; snapshot thật là residual có tên). Phạm vi PASS = được phép đề nghị ENTER EXECUTE cho chặng B-α; chặng B-β KHÔNG.
Accepted by: không cần chấp nhận concern (Gate PASS). Chủ vẫn phải nói "ENTER EXECUTE MODE" cho chặng B-α. Chu kỳ PVL Amendment 3: pass 1 (U1-U18), supplement `a02ed5d` + trả lời chủ `30a3df8`, pass 2 (U19-U25), supplement `84928ca`, pass 3 (PASS B-α, V-W1).

### Validate Contract (Chặng B-β)

Status: GATED — Amendment 4 written (20-10-26: B-0b measured, B-beta designed in `## Amendment 4`); awaiting inner PVL; KHÔNG EXECUTE
date: 2026-10-19
generated-by: inner-pvl: phase-B (chặng B-β, placeholder)

B-β chỉ được validate sau: (1) chủ chạy OB1-OB4 + OB3b và gửi kết quả measure; (2) plan-supplement ghi Q2 (hình dạng `title`/`excerpt`), Q3 (vị trí ảnh trong `body_sections`), KB-2 (bảng chéo section/subsection); (3) inner PVL riêng từ V1. Gate: chưa có. Known-gap B-β có tên: Q2, Q3, KB-2, KB-3 (G23), KB-4, KB-6.

Mục PHẢI xử lý ở PVL B-β (carry-forward từ PVL-S3, không chặn B-α):
- CF1 (U24 còn hở, ảnh hưởng tính kiểm được của cổng) `--min-coverage` (L702, L736, AC-B13): tử số "số URL có mục map" gồm cả mục archived -> `/<pillar>` và rejected -> 410, nên tỉ lệ có thể vượt 1 và che mất bài published thiếu mục. Sửa: tử số = số bài nguồn status `published` CÓ mục map; mẫu số = số bài nguồn status `published`; báo riêng số mục archived/nháp/410.
- CF2 Rollback chạy dry-run (mặc định) KHÔNG được ghi dòng `resolved`; chỉ `--apply` mới ghi. Nêu rõ trong B-8 và test.
- CF3 Rollback ghi `resolved` vào `--runs-dir`, nên rollback cũng phải qua `assertOutsideRepo`.
- CF4 Chạy song song hai `--apply` không có khoá; cân nhắc lockfile trong `--runs-dir` (preflight intent treo không bảo vệ khi hai run chạy cùng lúc). Ghi chú; chủ chạy tuần tự.
- CF5 Câu Q9 (L674) đọc được thành "107 bài archived nhập thành nháp"; C2 và "Hệ quả số" nói archived GIỮ archived. Viết lại một câu cho rõ (archived giữ archived; cả archived lẫn nháp-thiếu-ảnh-bìa -> `/<pillar>`).

### Autonomous Goal Block (Chặng B-α)

SESSION GOAL: VowAsia legacy migration, Giai đoạn B chặng B-α: CLI snapshot (đọc DB cũ một lần qua role tạm, ghi snapshot + kho ảnh + manifest NGOÀI repo), CLI measure (offline), mapping C8, guard `assertOutsideRepo`, ghim sha256 GTP; không file GTP đổi một byte.
Charter + umbrella plan: N/A — single plan (không có umbrella plan với `## Stable Program Goal`).
Autonomy: theo feedback_autonomous_phase_execution.md; EXECUTE chỉ sau "ENTER EXECUTE MODE" của chủ cho chặng B-α của plan này; EXECUTE = 1 vc-execute-agent (opus) tuần tự; EVL = vc-tester (sonnet) chạy lại độc lập; G22 = vc-code-reviewer (sonnet). Autonomy chỉ bỏ điểm dừng phê duyệt, không bỏ spawn subagent.
Hard stops: chỉ tạo mới, không sửa, không xoá, không bao giờ tạo tác giả; dry-run mặc định; `--apply` cần TTY + `--confirm-host` + banner `/neondb`; mỗi `--apply` một run-id MỚI, không `--resume`; rollback theo từng run; rehearsal chạy MỘT lần, một mình, nền, timeout 7200000, không rehearsal song song, không `npm ci` song song; CHỦ chạy mọi bước production và DB cũ (OB1-OB12); không in/commit bí mật, URL DB, mật khẩu, ref project cũ; HS2: file ngoài 3.8 B-α -> dừng; không EXECUTE B-β (B-2..B-14) trước contract B-β PASS.
Next phase: EXECUTE chặng B-α: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
Validate contract: inline (### Validate Contract (Chặng B-α)), Gate: PASS, generated-by: inner-pvl: phase-B (chặng B-α), 2026-10-19.
Execute start: red-first stubs rồi B-0, B-0b, B-1, fixture | G1 `npm run test:migrate-vowasia` | G2 `npm run lint:migrate` | G3 `npm run typecheck` | G4 `npm run test:migrate-gtp` | G5 `npm run test:single-home` | G6 `npm run probe:migrate-vowasia` (một mình) | G7/G7b/G7c gốc 84928ca | G8 `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | SQL không đổi | G22 review | high-risk pack: yes (trust-boundary/secret).

## Amendment 4 (20-10-26): real snapshot measurement (B-0b) and full B-beta design

**Precedence (PVL B-beta pass 2, CONCERN 1): for B-beta, §4.x governs wherever §3.x differs.** The stale §3 passages are marked `[Superseded ...]` in place; they stay as history.

Status: Amendment 4 written; PVL B-beta pass 1 = BLOCKED (report `vowasia-legacy-migration-pvl-b-beta_REPORT_20-10-26.md`); supplement cycle 1 applied 20-10-26 (F1 owner map rule restored, C1-C13 fixed, owner answer Q12 recorded in 3.3, open items O-B5 and O-B12 in 3.9); awaiting inner PVL re-run from V1. Nothing here is executed. B-beta EXECUTE needs `### Validate Contract (Chặng B-β)` to reach `Gate: PASS` (or an owner-accepted CONDITIONAL) after inner PVL from V1.

Bottom line: the measurement closes Q2, Q3 and KB-2 with no surprises (zero unmapped section pairs, all images on the allow-list, 369 images downloaded with 0 failures). B-beta can now be specified fully. It is HIGH RISK (create-only data mutation on production Central `neondb`, plus R2 uploads) and needs the 5-artifact evidence pack before it is treated as closed.

### 4.1 Measured facts (owner ran on the Mac, 2026-10-20; counts only, no secrets)

Digests (record these; the manifest digest is the importer's `--expect-sha256`):

| Item | Value |
|---|---|
| Snapshot `snapshot.ndjson` sha256 | `95d017cd499d27fe07eaca40dc2a7ccc6b9cb5d11d59332638c34791b104df01` |
| Image manifest sha256 (`--expect-sha256`) | `50c431a1993799c60d6fae6614da3cf5ee82cad9c0bfacd340a75fcafde0c105` |
| Articles in snapshot | 370 (discover in 3.2 saw 368: +1 published, +1 draft; cause not verified, most likely new rows on the old site between the two sittings; the snapshot is the source of truth from now on) |
| Manifest | 369 entries, 0 failures, offAllowlist 0, relative 0, protocol-relative 0; `snapshotSha256` matches the snapshot; 369 files in `images/` |
| Download | ran once; a second run correctly refused with "manifest exists" |

Status: published 230, archived 107, draft 21, rejected 12. No `scheduled` rows.

Q2 (closed): `title` and `excerpt` are always `object{en}` (370/370). Importer reads `.en`.

Q3 (closed): `body_sections` is an array of `{heading, body}` (1,415 elements) or `{heading, body, image}` (8 elements, in 3 articles).
- Body images: `[].image.url` = 8, all on the allow-list.
- URLs inside `[].body.en` text: 4, NOT on the allow-list. These are links, not images, and were not downloaded.
- Relative / protocol-relative refs: 0.

Cover: 361 on the allow-list, 9 missing (missing -> draft, owner decision). 361 cover + 8 body = 369 = manifest entries.

Dates: 0 rows without `created_at`; 140 rows without `published_at` (C7: use `created_at`). The 140 is counted over ALL 370 rows, rejected included; how many of the 140 are among the 358 imported rows is not known until the dry-run.

KB-2 (closed): every (section, subsection) pair maps under C8; ZERO rejects.

| Legacy pair | Count | Central target |
|---|---|---|
| wedding-business / industry-news | 125 | same |
| venues / hotels-resorts | 88 | same |
| destination-weddings / honeymoons | 32 | same |
| style / rings-jewelry | 26 | rings-jewellery |
| wedding-business / people | 19 | people-planners |
| style / flowers-decor | 18 | same |
| destination-weddings / guides | 16 | destination-guides |
| style / trends | 16 | trend-reports |
| style / beauty | 5 | same |
| style / gowns-attire | 5 | same |
| wedding-business / data-insights | 5 | same |
| venues / by-destination | 4 | same |
| planning / budgets-costs | 3 | budgets-real-costs |
| planning / expert-advice | 3 | same |
| destination-weddings / pre-wedding-shoots | 2 | same |
| planning / checklists | 1 | checklists-timelines |
| planning / etiquette-traditions | 1 | same |
| venues / (null) | 1 | pillar only, no sub-section |

`tags` column: array of strings on 362 rows, empty on 8. Ignored (C4: tags come from the sub-section, Q10).

Incident during the snapshot sitting: pooler password auth failed twice (credential cache), the direct host failed with ENOTFOUND (IPv6-only), and it succeeded after reconnecting on the pooler. Lesson for any future sitting: do not rerun `02p` after an auth failure; space out retries; reconnect on the pooler. Role `vowasia_migrator` was dropped; `03e` printed `CLEANUP OK`.

Expected counts derived from the facts (the dry-run MUST print each of these and the owner compares):

- Rows the importer sees: 370. Dropped (rejected, C2): 12. Imported: **358**.
- Before the no-cover rule: published 230, archived 107, draft 21.
- After the no-cover rule: the 9 no-cover rows become draft. How many of the 9 are published, archived, draft or rejected is UNKNOWN until the dry-run. The dry-run must print the 9 split by original status. So: published = 230 - p, archived = 107 - a, draft = 21 + p + a, where p, a are the no-cover counts among published/archived; if some of the 9 are rejected they are dropped, not imported.
- Any further image failure at import (C6) also moves the row to draft; expected 0 because the manifest has 0 failures. The import stops if failures exceed 2% (8 of 369).
- Pillar totals (over all 370 rows, before removing the 12 rejected): wedding-business 149, venues 93, style 70, destination-weddings 50, planning 8. After import each pillar is that total minus its rejected rows; the dry-run prints both.
- Tag totals, UPPER bounds (over 370, before removing rejected): wedding-industry 125, wedding-venues 88, honeymoons 32, bridal-fashion 31 (26 rings-jewellery + 5 gowns-attire), no tag 94.
- Body images to re-create: 8 in 3 articles. Cover images: 361 (minus any on rejected rows). Media rows created: at most 369, fewer if a file is shared (dedupe by stable filename).
- Date fallbacks: printed on two bases: over all 370 rows (must equal 140) and over imported rows (= 140 minus the rejected rows that lack `published_at`).
- Redirect entries (C3, Q1, Q9; owner rules only): **349** = 12 x 410 (rejected) + 337 x 308, where 337 = 230 rows with old status published (to `/<pillar>/<slug>`, or to `/<pillar>` if made draft for no cover, Q9) + 107 archived rows (to `/<pillar>`, Q9). The 21 old draft rows get NO map entry; they are listed in the redirects report only. 349 unless the importer rejects a published/archived row or an O-B12 row exists; the dry-run prints the exact count (old drafts get no entry and rejected rows get a 410 either way, so the no-cover split does not change the size). Published-origin rows made draft by a broken stored image (C6): open owner item O-B12 (3.9), expected 0.

Note on 3.2 numbers: the 368 / 229 / 20 from discover are superseded by the snapshot (370 / 230 / 21). Plan text that says 368 or 8/818 is historical.

### 4.2 Consequences for the design

1. Q2: transform reads `title.en` and `excerpt.en`. Anything else (missing `en`, non-string, other shape) -> reject with a report line. No guessing, no fallback to another key.
2. Body assembly (fixes PVL B-beta C3): elements are processed in array order. Inside ONE element the order is fixed: `heading` (string or `{en}`) -> H2, then the `image` (if any) -> `upload` node, then `body.en` -> paragraphs. `body.en` is TEXT, not HTML, the same semantics as GTP `sectionsToHtml` (`gtp-transform.ts:219-258`): escape with the pinned `escapeHtml`, split on blank lines into paragraphs, never parse it as HTML. `sanitizeLegacyHtml` is used only if a sniff ever finds HTML tags in `body.en` (B-0b found none), and then the row is reported. Body-image Media fields: `alt` = `image.alt` if a non-empty string, else `image.caption` if a non-empty string, else the article title (`title.en`); `credit` = `image.credit` if a non-empty string, else empty. (`featured_image_credit` stays the cover credit, C3 row "Ảnh".) The `upload` node points at the NEW Media id. The Media id is found through the manifest: url -> sha256 -> file in `images/` -> Media created under tenant `vowasia`, R2 prefix `vowasia/`. No `<img>` HTML ever reaches the Lexical converter (U3 stays in force). Post-check: 0 references to the old image hosts remain in the body.
3. The 4 off-allow-list URLs in body text are links (fixes PVL B-beta C2). The dry-run prints each one with article slug, URL and a class: `old-site-article` (host `vowasia.com` or `www.vowasia.com`, path `/article/<slug>`) or `external` (anything else). Rule: `external` links stay verbatim. What happens to an `old-site-article` link is the OWNER's call (open item O-B5, 3.9); no default. OB5 is a STOP point: OB6 (first apply) does not start until the owner has answered for the 4 links. `rewrite-links` (B-9b) acts on `old-site-article` links only as the owner answered; it never touches `external` links.
   Answer form (PVL B-beta pass 2, CONCERN 3): a per-link answer file written by the owner after OB5, passed as `--old-site-links-file <path>` (required, no default). One line per link: `<article slug> <URL> rewrite|keep`. The file lives outside the repo (checked with `assertOutsideRepo`) and holds no secrets (slugs and public URLs only). The tool refuses to run if any `old-site-article` link found in the run's articles is missing from the file, if the file lists a link that is not found (extra/unknown entry), if a line is malformed or has another value, or if the same link appears twice. Rewrite target: the relative path `/<pillar>/<slug>` (owner decision C3), and ONLY when the linked old article (by its legacy slug from the URL path) was imported AND is `published` in Central by the SAME run; the lookup is over that run's created rows (its slug-map/outcome lines), not other runs, so a run never rewrites to a row another run may roll back. If the linked article is not in this run, was rejected, is draft/archived, or was not imported, the link stays unchanged and the report gets one line (slug, URL, reason). `keep` = unchanged. `external` links are never changed in any mode.
4. `venues` with null subsection -> pillar only, no sub-section, no tag (already in the C8 table, now confirmed with real data: 1 row).
5. Status: no `scheduled` rows exist, so the scheduled branch is tested on the fixture only.
6. Dates: 140 rows (over all 370) use `created_at` as the publish date (C7). The dry-run prints the count over all rows and over imported rows (C1).
7. Redirects (owner rules C3, Q1, Q9 only; fixes PVL B-beta F1; the earlier orchestrator default is WITHDRAWN): archived rows stay ARCHIVED in Central (C2, CF5 clarification). Map rules:
   - old status published, imported as published -> 308 `/<pillar>/<slug>` (C3);
   - old status archived -> 308 `/<pillar>` (Q9);
   - old status published or archived, imported as draft because of no cover -> 308 `/<pillar>` (Q9);
   - old status draft or scheduled -> NO map entry, listed in the redirects report only (C3 "Nháp: không vào map", Q1, Q9 "không đổi"); this holds even if the row also has no cover;
   - old status rejected -> `{"status":410}` (Q1);
   - old status published, imported as draft because a stored image is broken/missing (C6) -> NOT covered by the written rules (C3 says drafts get no entry, Q9 names only archived and no-cover rows). Open owner item O-B12; no default: the redirect builder STOPS and lists these rows. Expected 0 (manifest has 0 failures);
   - importer-rejected rows (shape, slug clash, unknown C8 pair) -> no entry + report line.
   Expected map with real data: 349 entries (12 x 410 + 337 x 308). When an editor later publishes a non-public row, the map is regenerated and that URL goes straight to `/<pillar>/<slug>`.

### 4.3 B-beta design (mirrors GTP, copies everything tenant-named, edits no GTP file)

Rules kept from 3.4: create-only, never update or delete outside rollback, never create authors, no `--resume`, a second run uses a NEW run-id, journals live outside the repo, dry-run is the default, `--apply` needs an interactive TTY + `--confirm-host=<host>` + database name `/neondb` (`assertLocalOrConfirmed` then `central-db-name-guard`), banner shows `neondb`. GTP code is imported read-only and ONLY the 11 files already pinned in `lib/gtp-import-pins.ts` (fixes PVL B-beta C12). Everything else B-beta needs from GTP (Central-target helpers, CLI spec/arg parsing such as `cli-common.ts`, `cli-spec.ts`, `args.ts`, run-dir intent/outcome journals, importer/rollback/verify/redirect logic) is COPIED into `scripts/migrate/vowasia/lib/`. `lib/gtp-import-pins.ts` stays frozen in B-beta; editing it, or importing any unpinned GTP file, is HS2 (stop). G20 + the pin test prove it.

Data path for one import run:
1. Load snapshot dir. Verify `sha256(snapshot.ndjson)` equals manifest `snapshotSha256`; verify `sha256(manifest.json)` equals `--expect-sha256`; verify every manifest entry file exists in `images/` named by its sha256 and re-hash it. Any mismatch -> refuse, nothing written.
2. Taxonomy presence check, before any write and in dry-run too (fixes PVL B-beta C13): tenant `vowasia` must hold the 5 pillars (`wedding-business`, `venues`, `style`, `destination-weddings`, `planning`), the 17 target sub-sections of the KB-2 table, each under its own pillar, the 4 tags used (`wedding-industry`, `wedding-venues`, `honeymoons`, `bridal-fashion`) and the 6 authors (by tenant + name AND slug, E5). Anything missing -> STOP with the full missing list, nothing written. The importer NEVER creates tags, pillars, sub-sections or authors (GTP's create-tag-by-slug in `import-gtp-main.ts` is NOT copied). Then plan the whole set deterministically: status (C2 + no-cover), taxonomy (C8), tag (C4/Q10), slug (keep old; `page` reserved -> reject; clash with a non-marker vowasia article -> reject), author (C1 round-robin per pillar by `created_at`, then `id`, over the 6 authors from `scripts/lib/vowasia-taxonomy.ts`), dates (C7), body (4.2).
3. Preflight (apply only): R2 env present for non-local Central (4 names, printed as names only); lockfile (CF4); no dangling intent in any run in `--runs-dir`; no marker `legacy:vowasia` article in tenant vowasia that is absent from every journal.
4. Per article: write intent line (fsync) -> create/reuse Media (cover + body) -> create Article -> write outcome line (fsync) and slug-map line. Two kinds of image failure (fixes PVL B-beta C7, owner answer Q12 in 3.3):
   - Store-level failure (the image is bad or missing in the local snapshot store: manifest failure entry, file missing in `images/`, sha256/size/magic-bytes mismatch): C6 applies. The article becomes draft and the body section with the failed image is dropped (AC-B3). Such failures counted over the run > 2% -> stop.
   - Upload failure (Media create/upload throws: bad R2 credentials, R2 outage, network error): Q12 "Dừng ngay". The run STOPS before creating that article: no draft without images, the intent line gets an outcome `failed` with reason `uploadError`, the lock is released, exit non-zero. The owner fixes the cause and runs again with a NEW run-id (never `--resume`). Media already created in this run for that article stays and is reused by stable filename on the next run, or removed by rollback of this run if no article references it.
5. After the run: write `timestamps-baseline.json`, `timestamps-fix.sql` (owner-run), and the run report.

### 4.4 B-beta Implementation Checklist (each item red-first where it has logic)

All paths under `scripts/migrate/vowasia/` unless noted. Each "test" is a `node:test` file run by `npm run test:migrate-vowasia`. Red-first means: write the named test, see it fail, then implement.

1. B-2 `lib/vowasia-transform.ts` + `lib/vowasia-transform.test.ts`.
   - Red-first tests: `title`/`excerpt` `{en}` -> string; date-fallback count returned on both bases (all rows, imported rows; C1); missing `en` -> reject `titleShape`; status table (published/archived kept, draft/scheduled -> draft, rejected -> skip); no cover -> draft with reason `noCover`; `published_at` null -> `created_at`; tag table (honeymoons->honeymoons, hotels-resorts->wedding-venues, gowns-attire->bridal-fashion, rings-jewellery->bridal-fashion, industry-news->wedding-industry, every other sub-section -> none, null sub-section -> none); old SEO fields ignored (C5).
2. B-3 `lib/vowasia-body.ts` + test.
   - Red-first tests: real shapes `{heading, body}` and `{heading, body, image}`; fixed order inside one section (H2, then upload node, then paragraphs); `body.en` containing `<`, `>` and `&` comes out as escaped text, never as HTML nodes; blank-line split gives one paragraph per block; body-image `alt` fallback chain (`image.alt` -> `image.caption` -> article title) and `credit` (`image.credit` or empty); image -> `upload` node with the given Media id; 0 pending upload nodes; post-check "no old image host left"; store-level failed image -> section dropped + flag `draft`; off-allow-list URL in text -> kept verbatim and returned in `offAllowlistLinks` with its class (`old-site-article` / `external`).
3. B-4 `lib/vowasia-author-distribution.ts` + test: order by (`created_at`, `id`) inside each pillar; spread differs by at most 1; computed on the full set so two runs agree; missing author -> throw.
4. B-5 `lib/vowasia-slug-plan.ts` + test: keep slug; `page` -> reject; clash with non-marker article -> reject; deterministic `--limit` order.
5. B-6 `lib/vowasia-media.ts` + test: manifest lookup by exact URL; sha256 + magic bytes + size (<= 20 MB) re-check; stable filename with `vowasia-` prefix (`lib/vowasia-stable-filename.ts`); reuse existing Media with the same filename in tenant vowasia; no network code path (test asserts no `fetch` import); R2 prefix asserted `vowasia`. Returns two distinct results: `storeFailure` (C6 path) vs a thrown `UploadError` (Q12 path). Red-first tests for BOTH branches: (a) sha mismatch / missing file -> `storeFailure`, article planned as draft, section dropped, run continues; (b) a fake Payload create that throws -> the import stops before `payload.create` for that article is called (assert zero article creates after the throw), outcome `failed`/`uploadError`, lock removed, non-zero exit.
6. B-7 `lib/import-vowasia-main.ts` + `import-vowasia.ts` + test.
   - Gates (red-first): taxonomy presence check (4.3 step 2): one missing pillar, sub-section (or one under the wrong pillar), tag or author -> STOP with the missing list, zero writes, and no create call for any taxonomy collection; dry-run without `--runs-dir` refused; dry-run `--runs-dir` inside the repo (incl. git-ignored) refused by `assertOutsideRepo`; no TTY; missing/wrong `--confirm-host`; DB name not `/neondb` (dry-run included, guard prints the name first); `--run-id` missing on apply; run dir exists; `--resume` given; dry-run with `--run-id`; `--runs-dir` inside the repo incl. git-ignored dirs (`assertOutsideRepo`); missing R2 env on non-local Central; wrong `--expect-sha256`; snapshot sha chain broken; lockfile present (CF4); dangling intent in any run; marker article not in any journal.
   - Behaviour: dry-run REQUIRES `--runs-dir` (through `assertOutsideRepo`) and writes only to `<runs-dir>/dry-<timestamp>`, never a named run dir and never the in-repo `DEFAULT_OUT` of `vowasia-cli.ts` (fixes PVL B-beta C8: the report holds slugs, titles and URLs from a private snapshot; the repo is PUBLIC); dry-run prints the expected-count block of 4.1 (status before/after, the 9 no-cover rows by original status, pillar totals before/after removing rejected, tag totals, date fallbacks over all rows AND over imported rows, image totals, the 4 off-allow-list links each with slug + URL + class, the expected redirect map size and its split, rejects by reason); create-only; never adopts an existing row into the current run.
   - CF4 lock: ONLY `--apply` modes take the lock: import `--apply`, rollback `--apply`, rewrite-links `--apply` (fixes PVL B-beta C4). Dry-runs of all three never create, read-block on, or remove it. `--apply` creates `<runs-dir>/.import.lock` with `O_EXCL` holding pid + run-id + mode + start time; refuses if it exists (prints holder); removes it on normal exit and on handled errors (incl. the Q12 upload stop). There is no override flag.
   - Stale lock after a crash or kill (power loss, `kill -9`, closed terminal): the lock stays, so rollback `--apply` also refuses. Recovery, written in `VOWASIA-LEGACY.md` part B and rehearsed in G19: (1) check that no import/rollback/rewrite-links process is running (`ps aux | grep -E "import-vowasia|rollback-vowasia|rewrite-links-vowasia"`, shows nothing but the grep itself); (2) read the holder printed by the refusal (pid, run-id); (3) delete `<runs-dir>/.import.lock` by hand; (4) run rollback dry-run then `--apply` for the crashed run-id; (5) only then start a new run with a NEW run-id. Red-first test: a lock left by a killed process makes rollback `--apply` refuse; after deleting it rollback proceeds.
7. B-8 `lib/rollback-vowasia-main.ts` + `rollback-vowasia.ts` + test.
   - Deletes only articles with marker `legacy:vowasia` + tenant vowasia + listed in that run's journal; untouched check against the run's `timestamps-baseline.json` (edited rows kept unless `--include-edited`).
   - Media (fixes PVL B-beta C9, restores U7): deletes a Media row created by that run only if NO other article in tenant vowasia references it, either as `heroImage` OR as an `upload` node anywhere in the body. Payload keeps no relation index for Lexical upload nodes, so this is a FULL scan of every tenant-vowasia article body (`draft: true`, paginated until exhausted). Red-first test: Media used only in another article's body (not as hero) is kept.
   - Dry-run report: printed to stdout only; nothing is written into the run dir (GTP's `rollback-report-dry.json` is NOT copied). The `--apply` report is written to the run dir.
   - Delete error on an article: report it (run-id, slug, id, error) and continue; NO archive fallback (GTP `rollback-main.ts:160-166` archives on delete error; that is an update and is NOT copied). Red-first test: a fake delete that throws leaves the article untouched and produces a report line.
   - Dangling intent resolved only when ALL five conditions of 3.4 step 6 hold (copied verbatim into the code comment and tested one condition per case); unchanged by this amendment.
   - CF2: dry-run (default) writes NO `resolved` lines and nothing else; only `--apply` writes `resolved`. Test: dry-run leaves the run dir byte-identical.
   - CF3: `--runs-dir` goes through `assertOutsideRepo` (same guard as import). Test: in-repo and git-ignored dirs refused.
   - Required scenario tests (from 3.5 item 8): crash before create then run B same slug then rollback A -> B's article untouched; failed create then run B then rollback A -> untouched; crash after create before journal -> rollback A deletes it.
   - Uses the CF4 lock too (rollback and import never run at once).
8. B-9a `build-vowasia-redirects.ts` + `lib/vowasia-redirects.ts` + test: reads snapshot + Central state; keys via the read-only `normalise-path` helper (pinned); rules exactly as 4.2.7 (C3, Q1, Q9; same as 3.4 step 8 and 3.5 item 9): old published imported published -> `/<pillar>/<slug>` (308 by `vowasia-web` middleware); archived -> `/<pillar>`; old published/archived made draft for no cover -> `/<pillar>`; old draft/scheduled -> NO entry, listed in the report; rejected -> `{"status":410}`; old published made draft by a stored-image failure -> STOP and list (O-B12, no default); importer-rejected -> no entry + report line. Output is JSON for `vowasia-web` `src/redirects/redirect-map.json`. Red-first tests: one case per rule; an old draft with no cover still gets no entry; the real-data split on the fixture equivalent gives `12 x 410 + 337 x 308 = 349`-shaped counts.
   - CF1: `--min-coverage` numerator = source rows with status `published` that HAVE a map entry; denominator = source rows with status `published`; ratio can never exceed 1. Report separately: archived entries, draft entries, 410 entries. Red-first test: a fixture with one published row missing and many archived rows must fail coverage.
9. B-9b `rewrite-links-vowasia.ts` + `lib/rewrite-links-vowasia-main.ts` + test: dry-run default; `--apply` takes the CF4 lock; touches only rows created by the named run (Q11); `external` links are never touched; `old-site-article` links (host `vowasia.com`/`www.vowasia.com`, path `/article/<slug>`) are handled exactly as the owner answered at OB5 (O-B5): the tool reads that answer from the per-link answer file `--old-site-links-file` (format, refusal rules, rewrite target and lookup exactly as §4.2.3); rollback of the run covers these rows. Red-first tests: (1) missing `--old-site-links-file` refused; (2) file inside the repo refused (`assertOutsideRepo`); (3) a found `old-site-article` link missing from the file refused, zero writes; (4) an extra/unknown entry refused; (5) malformed line / value other than `rewrite|keep` / duplicate link refused; (6) `rewrite` + target imported and `published` in the same run -> becomes `/<pillar>/<slug>`; (7) `rewrite` + target draft, archived, rejected, not imported, or created by a different run -> unchanged + one report line; (8) `keep` -> unchanged; (9) `external` links unchanged in dry-run and apply, whatever the file says; (10) dry-run writes nothing.
10. B-10 `lib/vowasia-timestamps.ts` + test: generates `timestamps-fix.sql` per run (header OWNER-RUN, `psql -v ON_ERROR_STOP=1`, WHERE marker + tenant vowasia + id in this run's journal; Q11). Golden-file test.
11. B-11 fixture extension `fixtures/vowasia-legacy/**`: cases for every real shape in 4.1 (object{en} title, 3-key image section, null subsection, missing cover, missing published_at, off-allow-list links in text of both classes, `<`/`&` in body text, rejected row, an old draft with no cover, no scheduled row in real data but one in the fixture). Entry file (fixes PVL B-beta C6): `fixtures/vowasia-legacy/seed-vowasia-legacy-fixture.ts`. Its job: seed the fake legacy Postgres (port 54346) with the fixture rows so the existing snapshot CLI can produce a fixture snapshot + image store + manifest from it (images served by the fake image server on 3519). Fake hosts only (`*.invalid`, `localhost`), no old project ref (E6). Run by `npm run migrate:vowasia:fixture` and by the rehearsal.
12. B-12 `verify-vowasia.ts` + `lib/verify-vowasia-main.ts` + test: compares Central to the snapshot plan: counts by status/pillar/tag, every article has author, every upload node resolves to a vowasia Media, 0 old image hosts, slug-map complete.
13. B-13 rehearsal, ONE script path (fixes PVL B-beta C5, matches 3.8): `fixtures/rehearse-vowasia.sh` + `fixtures/rehearse-assert.ts` + `fixtures/rehearse-bootstrap.ts`. Native PG16, ports 54346/54347/3518/3519, one run, alone, in the background, timeout 7200000, no parallel `npm ci`.
   - Bootstrap of the local Central (54347/3518), in this order: (1) schema + base data with the existing `scripts/seed.ts` and `PAYLOAD_DB_PUSH=true`, file UNCHANGED; (2) `rehearse-bootstrap.ts` creates tenant `vowasia` through Payload, behind `assertLocalDb` (refuses any non-local `DATABASE_URL`); (3) `npm run audit:add-vowasia-taxonomy -- --apply` against the local DB (also rehearses OB1; expects 49 rows created); (4) `seed-vowasia-legacy-fixture.ts` seeds the fake legacy DB.
   - Then: snapshot -> measure -> dry-run; run A `--apply --limit 50`; run B (new run-id) for the rest; run C -> 0 new; rollback; redirect build; asserts Media `prefix === "vowasia"`; mutants red.
   - Crash case (C4): kill the import between create and journal; assert `.import.lock` is still there and rollback `--apply` refuses; delete the lock as in the runbook; rollback succeeds; continue.
   - Upload-stop case (Q12): a forced upload error stops the run before that article is created; no draft-without-images exists.
14. B-14 `VOWASIA-LEGACY.md` part B (owner steps, Vietnamese, OB steps of 4.6, incl. the stale-lock recovery of item 6 and the Q12 upload-stop recovery) and `package.json` (exactly 7 new lines, all contain `vowasia`: `migrate:vowasia:import`, `:rollback`, `:rewrite-links`, `:redirects`, `:verify`, `:fixture`, `rehearse:vowasia`).
15. B-15 EVL by `vc-tester`; G22 review by `vc-code-reviewer`; high-risk evidence pack (4.7).

Touchpoints (B-beta): only the files listed in items 1-14 (incl. `fixtures/rehearse-vowasia.sh`, `fixtures/rehearse-assert.ts`, `fixtures/rehearse-bootstrap.ts`, `fixtures/vowasia-legacy/seed-vowasia-legacy-fixture.ts`, and copied GTP logic under `lib/`), `package.json` (7 lines; `:fixture` runs `seed-vowasia-legacy-fixture.ts`, `rehearse:vowasia` runs `fixtures/rehearse-vowasia.sh`), and the B-beta report files in the task folder. NOT touched: `scripts/seed.ts`, `lib/gtp-import-pins.ts`, every GTP file. Any other file -> HS2 stop. GTP files are read-only (G20).

Public contracts (new, additive): 7 npm scripts; run journal format (`intent.ndjson`, `outcome.ndjson`, `slug-map.ndjson`, `timestamps-baseline.json`, `.import.lock`), outside the repo; redirect JSON for `vowasia-web`.

Blast radius: Central tenant `vowasia` articles + Media + R2 objects under `vowasia/`, only when the owner runs `--apply`. No other tenant. Tenant stays DARK, so no reader impact. Old DB: not read at all by B-beta.

### 4.5 Gates and acceptance criteria (B-beta)

Keep G1-G8 (re-run; G7/G7b base pinned to the exact commit `9d9e5a4` (Amendment 4; only plan/report files changed after it), exactly 7 new `package.json` lines, each contains `vowasia`, 0 removed lines), G16-G22 as written in 3.7, plus:

**Phase-A gates kept for B-beta (PVL B-beta pass 2, CONCERN 2; this list replaces the one in 3.7).** Run from the repo root, at EVL by `vc-tester`:
- SQL unchanged (covers the old G10/G10a, since the owner-run SQL may not change at all): `git diff --quiet 9d9e5a4 -- scripts/migrate/vowasia/sql` exits 0.
- G10c (no connection-URL scheme in docs or library comments; guards `VOWASIA-LEGACY.md` part B): `! grep -rnEi "postgres(ql)?://" scripts/migrate/vowasia --exclude="*.test.ts" --exclude="keyset-probe.*" --exclude="rehearse-vowasia.sh" --exclude="rehearse-bootstrap.ts" --exclude="seed-vowasia-legacy-fixture.ts"` (empty = pass).
- G10c-local (the 3 excluded rehearsal/fixture files may hold local URLs only): `! grep -nEi "postgres(ql)?://" scripts/migrate/vowasia/fixtures/rehearse-vowasia.sh scripts/migrate/vowasia/fixtures/rehearse-bootstrap.ts scripts/migrate/vowasia/fixtures/vowasia-legacy/seed-vowasia-legacy-fixture.ts | grep -vEi "postgres(ql)?://([^@/[:space:]]*@)?(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$|[[:space:]\"'])"` (empty = pass; every URL in those files must point at 127.0.0.1 or localhost).
- G13 `test -f process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md`.
- G6 (includes G14a-d) `npm run probe:migrate-vowasia` (= `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh`), alone, never in parallel with G19 or G11.
- G9 (review of owner-run SQL) is not re-run: the SQL is unchanged (gate above), and its review role for B-beta is taken by G22.

G11 `rehearse:gtp` (fixes PVL B-beta C11): runs at B-beta EVL only AFTER G19 has finished, never in parallel with G19 or any probe. G19 (`rehearse:vowasia`) runs at EVL only, by the agent on Linux (it needs `/usr/lib/postgresql/16/bin` and `runuser`); it is NOT an owner step (C10).

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| G24 transform/body tests on real shapes (B-2, B-3) incl. 0 pending upload nodes, text-not-HTML escaping, section order, alt/credit fallback, link classification, `rewrite-links` answer-file rules (§4.4 item 9 tests 1-10) | Fully-Automated | AC-B2, AC-B3, AC-B14 |
| G29 image-failure split (B-6, B-7): store-level failure -> draft + section dropped; upload exception -> stop before article create (Q12) | Fully-Automated | AC-B3, AC-B16 |
| G30 taxonomy presence STOP (B-7): any missing pillar/sub-section/tag/author -> STOP, zero writes, no taxonomy create | Fully-Automated | AC-B5, AC-B17 |
| G25 dry-run prints the 4.1 expected-count block; fixture run asserts every number | Fully-Automated | AC-B15 |
| G26 CF4 lock: second concurrent `--apply` refused; rollback while import holds lock refused; rewrite-links `--apply` takes the lock; dry-runs never create it; stale lock blocks rollback until removed | Fully-Automated | AC-B5 |
| G27 CF2/CF3: rollback dry-run leaves run dir byte-identical (report on stdout); rollback `--runs-dir` in repo refused; body-only Media reference kept; delete error -> report only | Fully-Automated | AC-B6 |
| G28 CF1 + map rules: coverage numerator counts only published rows; ratio never above 1; missing published entry fails; old drafts get no entry; O-B12 case stops | Fully-Automated | AC-B11, AC-B13 |
| G19 rehearsal (EVL only, agent, Linux; one run, alone, background; bootstrap per 4.4 item 13) | Hybrid | AC-B6, AC-B7 |
| G11 `rehearse:gtp` (EVL only, after G19 finished, never in parallel) | Hybrid | AC-B8 |
| G22 code review on import/rollback/redirects/timestamps SQL | Agent-Probe | AC-B5, AC-B9 |
| G23 owner dry-run + apply + verify on `neondb` (OB steps 4.6) | Known-Gap (backlog stub; B stays CONDITIONAL until the owner runs it) | AC-B10 |

New ACs:
- AC-B14 The 4 off-allow-list body links are listed in the dry-run report with slug, URL and class; `external` links are unchanged in Central; `old-site-article` links match the owner's per-link answer file (O-B5): `rewrite` -> `/<pillar>/<slug>` only when the target was imported and is `published` in the same run, otherwise unchanged with a report line; `keep` -> unchanged; a missing, extra or malformed entry refuses the run. Code-level proof: G24 on fixtures; real-data proof: G23.
- AC-B15 Dry-run numbers match 4.1: 358 imported, 12 rejected dropped, 0 C8 rejects, date fallbacks over all rows = 140 (the imported-rows number is printed and recorded, not compared), 9 no-cover drafts split by original status, image entries 369 (or fewer, explained), expected redirect map size printed (349 unless the importer rejects a published/archived row or an O-B12 row exists; the dry-run prints the exact count).
- AC-B11 (restated, owner rules C3/Q1/Q9) Map: 308 `/<pillar>/<slug>` for published, 308 `/<pillar>` for archived and no-cover drafts, no entry for old draft/scheduled rows (report only), 410 for rejected, STOP on O-B12 rows; real data: 349 entries.
- AC-B16 (Q12) An upload error stops the run before that article is created; no article is created as draft because of an upload error.
- AC-B17 (C13) The importer never creates taxonomy; any missing required pillar/sub-section/tag/author stops the run before any write.
- AC-B13 (revised by CF1) Every published imported row has exactly one map entry; coverage = published-with-entry / published = 1.0.

Gate verdict rule: B-beta cannot be PASS-closed on G23 alone (Known-Gap is never a proving strategy); code gates G24-G28, G16-G22 must be green, and G23 stays a named residual until the owner reports.

### 4.6 Owner steps for B-beta (in order; all on the Mac; only after B-beta `Gate: PASS` and EVL green)

1. OB1 Taxonomy dry-run on Central first: `npm run audit:add-vowasia-taxonomy -- --confirm-host=<host>`. Banner must show `neondb`. Expect tenant `vowasia` and 49 rows present (incl. 6 authors). Anything missing -> STOP.
2. OB-R Rehearsal result: the owner does NOT run the rehearsal (it is Linux-only: `/usr/lib/postgresql/16/bin`, `runuser`). The agent runs G19 at EVL; the owner reads the G19 result in the EVL report. It must be green.
3. OB5 Import dry-run: `npm run migrate:vowasia:import -- --snapshot <dir> --expect-sha256 50c431a1993799c60d6fae6614da3cf5ee82cad9c0bfacd340a75fcafde0c105 --confirm-host=<host> --runs-dir ~/vowasia-private/runs`. Banner must show `neondb`. Print R2 variable NAMES only. Send the count block; compare with 4.1. STOP POINT: read the 4 links with their class and answer O-B5 by writing the per-link answer file outside the repo (e.g. `~/vowasia-private/old-site-links.txt`; one line per `old-site-article` link: `<slug> <URL> rewrite|keep`; no secrets). OB6 does not start until this file exists and the answer is recorded in 3.3.
4. OB6 Apply part A: add `--apply --limit 50 --run-id <A> --runs-dir ~/vowasia-private/runs`. Back up `~/vowasia-private/`. Check 50 rows in /admin (tenant vowasia: cover, body images, author, pillar).
5. OB7 Apply the rest with a NEW `--run-id <B>` (never `--resume`; A's rows are skipped).
   If any apply stops (Q12 upload error, crash, closed terminal): fix the cause; if a stale `.import.lock` remains, follow the stale-lock steps in `VOWASIA-LEGACY.md` part B (check `ps`, delete the lock, rollback dry-run then `--apply` of that run if it crashed); then run again with a NEW run-id.
6. OB8 `rewrite-links` dry-run, then `--apply`, per run, with `--old-site-links-file ~/vowasia-private/old-site-links.txt` (the O-B5 answer file; the tool refuses if a link is missing or extra). OB9 run `timestamps-fix.sql` per run on Neon with `ON_ERROR_STOP`.
7. OB10 `npm run migrate:vowasia:verify -- ...`; send the result.
8. OB11 `npm run migrate:vowasia:redirects -- ...`; open a PR to `vowasia-web` adding the entries to `src/redirects/redirect-map.json`. Do not merge before a cutover date (C10: none yet; VowAsia stays DARK).
9. OB12 Keep the journals until rollback is surely not needed; then delete or encrypt snapshot + images + journals.

Rollback at any time: `npm run migrate:vowasia:rollback -- --run-id <id> --runs-dir ~/vowasia-private/runs` (dry-run first, then `--apply`).

### 4.7 High-risk classification and evidence pack

Risk classes: schema/data mutation on production (create-only import, rollback deletes), external object storage (R2). Required before B-beta is closed: the 5-artifact evidence pack (`vc-risk-evidence-pack`) in the task folder, including `review-decision.json` and `adversarial-validation.json` for B-beta. The orchestrator must not treat B-beta as finalised until the pack exists and G23 is reported by the owner.

### 4.8 Out of scope (follow-ups, backlog; not done in B-beta)

- `out-dir.ts` `..` handling flaw, present in both the phase-A vowasia copy and GTP `scripts/migrate/lib/out-dir.ts` (B-beta uses `assertOutsideRepo` instead; fixing GTP would break G20).
- Review follow-ups N2, N4, N6, N7 from the B-alpha review report.
- Missing `review-decision.json` / `adversarial-validation.json` for earlier high-risk work (phase A / B-alpha).
- GTP importer has no R2 preflight (same gap as U8; note only, GTP is frozen).
- The old project ref appears in pushed history `f6ad3b9..e29c7da`; owner decides whether it matters (no history rewrite in this plan).
- `CENTRAL_SIGNING_SECRET` / revalidate webhook for vowasia-web (not a migration concern).

### 4.9 Strategy

`vc-agent-strategy-compare` (simple mode): S2, S6, S7 present (3/7, MEDIUM). Inner PVL: 3 parallel sonnet subagents (write safety/rollback/lock; data/mapping/body/media; rehearsal/redirects/gates). EXECUTE: 1 opus agent, sequential (files are tightly coupled). EVL: `vc-tester` sonnet; G19 runs alone.
