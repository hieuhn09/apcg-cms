---
name: plan:vowasia-legacy-migration
description: "Chuyển bài viết VowAsia từ DB Postgres cũ (dùng chung với GTP) sang Central tenant vowasia: tooling bản riêng, chia Giai đoạn A (đọc/discover, làm ngay) và B (import, sau discover)"
date: 16-10-26
feature: vowasia-launch (lưu ở general-plans; repo này không có process/features)
---

# VowAsia legacy migration — PLAN (COMPLEX, 2 giai đoạn)

Date: 16-10-26
Status: PLANNED (chưa VALIDATE; chưa EXECUTE)

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

### Cần chủ xác nhận (quyết định kỹ thuật/quy trình do plan đề xuất; xem mục cuối câu trả lời)

1. Dùng lại (import, không sửa) hai helper trung tính của GTP `lib/args.ts`, `lib/out-dir.ts` (không có tên tenant), hay chép bản riêng. Đề xuất: import chỉ hai file này, còn lại chép riêng; nếu chủ muốn tách tuyệt đối thì chép cả hai (thêm 2 file ~150 dòng).
2. Phương án role: 2 (schema+view) hay 1 (RLS). Đề xuất 2.
3. Allow-list nguồn mặc định chỉ `articles` + `sites` (tối thiểu cần thiết, theo C9). Có cần đọc thêm bảng tác giả/ảnh cũ không? Chỉ thêm khi chủ yêu cầu (qua overlay).
4. Làm rõ ràng buộc 4: lần chạy thứ hai dùng run-id mới. Plan hiểu: sau rollback hoặc sau lỗi fatal thì run-id mới; riêng "ghi thử 50 bài rồi ghi phần còn lại" dùng CÙNG run-id với `--resume` (theo mẫu GTP) vì kế hoạch slug và kế hoạch tác giả được tính một lần cho toàn bộ tập. Nếu chủ muốn hai run-id riêng, B phải tính lại kế hoạch tác giả theo tập đã import (đổi thiết kế).
5. `npm run rehearse:gtp` (~60 phút) vẫn chạy MỘT lần ở EVL (ràng buộc 9) dù bằng chứng diff-byte đã đủ; hay chấp nhận chỉ diff-byte?

## 3. Hard Constraints và Hard Stops

Hard Constraints (không thương lượng):

1. Chủ chạy mọi lệnh GHI lên production và mọi lệnh ĐỌC DB cũ. Plan/agent không giữ, không xin bí mật. Không bảo chủ dán/chụp bí mật: dùng `read -s`; mật khẩu mới dùng `openssl rand -base64 24 | pbcopy`; nhắc `clear` trước khi chụp màn hình. `LEGACY_VOWASIA_DB_URL` chỉ đọc từ biến môi trường, không bao giờ qua argv.
2. Role chỉ-đọc RIÊNG `vowasia_migrator`; SELECT giới hạn theo site id vowasia trên từng bảng trong allow-list, kể cả dòng của bảng `sites`. KHÔNG dùng lại `gtp_migrator`, không đụng role/policy của gtp. Chủ xoá role/policy/view sau khi xong. Repo KHÔNG có SQL role thật của GTP, chỉ có fixture `scripts/migrate/fixtures/gtp-legacy/schema.sql` (~dòng 165-177); SQL mới viết từ đầu, không "bản sao của GTP".
3. Dry-run là mặc định. `--apply` cần terminal tương tác + `--confirm-host`. Banner phải in database `neondb` (dùng `scripts/lib/central-db-name-guard.ts` đã có, gọi SAU `assertLocalOrConfirmed`). Trước MỌI lệnh owner-run có `--apply`: in tên database (`new URL(DATABASE_URL).pathname` phải là `/neondb`).
4. Importer chỉ TẠO MỚI, không sửa/xoá, không tạo tác giả. Rollback theo từng run-id. Run-id mới sau rollback/lỗi fatal (xem câu hỏi 4).
5. Marker bài import của vowasia KHÁC marker GTP: `engineSourceName = "legacy:vowasia"`, không bao giờ chứa `globaltravelpost`.
6. Rehearsal trên dữ liệu tổng hợp: chạy MỘT lần, một mình, nền, timeout 7200000 (~60 phút); không chạy 2 rehearsal song song, không chạy `npm ci` song song. Native PG16 (docker daemon có thể không chạy; dùng cùng cách `rehearse-gtp.sh`: `REHEARSE_MODE=native`).
7. RIPER-5: EXECUTE = opus (1 agent tuần tự vì file gắn chặt), pha khác = sonnet; EVL do `vc-tester` chạy lại độc lập. Thay đổi ngoài phạm vi cần amendment + chữ "đồng ý" của chủ. Commit vào `claude/vowasia-launch`, `push -u`, PR NHÁP. Không in/commit token/secret; không đụng `~/gtp-private`.
8. Không tự đặt mặc định thuộc về chủ (bài học "GTP Newsroom"): không tên tác giả chung, không gán pillar đại, không tự chọn 301/410.
9. KHÔNG đổi hành vi GTP: mọi file GTP giữ nguyên byte; `npm run test:migrate-gtp`, `lint:migrate`, `rehearse:gtp` vẫn xanh; có cổng chứng minh bằng diff.

Hard Stops (dừng, báo chủ, không tự xử lý):

- HS1: bất kỳ lệnh/mã nào sắp GHI vào DB cũ, hoặc chạy bất kỳ DDL nào ngoài file SQL mẫu do chủ chạy.
- HS2: cần sửa một file GTP hoặc file ngoài danh sách Touchpoints (ngoài 3 dòng `package.json`) => dừng, xin amendment.
- HS3: DB banner không phải `/neondb` ở lệnh Central có `--apply`; hoặc site row đọc ra có slug khác `vowasia`.
- HS4: phát hiện bí mật trong repo/log/báo cáo (kể cả tên bảng nhạy cảm của DB dùng chung) => dừng và xoá khỏi artefact trước khi tiếp.
- HS5: kết quả SQL đọc cho thấy phương án role đã chọn có thể ảnh hưởng site cũ (ví dụ cần bật RLS mà role của site cũ không bypass) => không chạy, chủ quyết lại.
- HS6: rehearsal/probe không dọn sạch tiến trình hoặc DB tạm của chính nó.
- HS7: Giai đoạn B bị yêu cầu thực thi khi chưa có discover report + các quyết định ở mục 2 cột CHƯA CHỐT.

## 4. Xác minh lại tooling hiện tại (đọc lại ở `fe88bc4`, KHÔNG dựa báo cáo cũ)

| Điểm | Còn ở main hiện tại? | Bằng chứng | Xử lý trong plan này |
|---|---|---|---|
| `IMPORT_TENANT = "gtp"` + `assertImportTenant` | Có | `scripts/migrate/lib/cli-common.ts:61-65` | Bản vowasia: hằng `vowasia`, không đọc `IMPORT_TENANT_SLUG` khác. |
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
- Overlay (do chủ giữ NGOÀI repo, sinh từ báo cáo discover): `source.siteFilter` (giá trị), `source.siteIdKind`, `source.schema`, `source.tables.*` (đổi tên bảng/cột/khoá), `media.hostAllowlist`, `media.hostRewrite` (chỉ A có siteFilter/siteIdKind/schema/tables; media dành B).
- Zod strict: khoá lạ bị từ chối; chuỗi "TODO" bị từ chối; tên bảng/cột phải khớp `^[a-z_][a-z0-9_]*$`; khoá `tables` tối đa 6 bảng; `sites.slug` kỳ vọng mặc định `vowasia`.

### 5.3 SQL: đóng theo cấu trúc (bản riêng của `legacy-sql.ts`)

Giữ nguyên triết lý: builder đóng + vị từ site cố định trong template + lexer lớp hai + `BEGIN READ ONLY` ngắn. Khác biệt có chủ đích:

1. Spec bảng nạp từ cấu hình (một lần, đóng băng) thay vì hằng 9 bảng; mặc định `articles`, `sites`.
2. Site id theo `siteIdKind`: `uuid` (regex như GTP), `integer` (`^[0-9]{1,18}$`), `text-safe` (`^[A-Za-z0-9_-]{1,64}$`, không dấu nháy). `assertSafeQuery` kiểm param[0] đúng kiểu; không dùng chuỗi nối.
3. Keyset (sửa lỗi B4): mỗi trang SELECT thêm cột `coalesce("created_at", $2::timestamptz)::text AS "__cursor_ts"` (cùng biểu thức với `ORDER BY`), con trỏ dùng chuỗi này (độ chính xác micro-giây, kèm offset múi giờ), so sánh bằng `$n::timestamptz`. `cursorOf` KHÔNG qua `Date`.
4. Reader (`pages()`): khử trùng theo khoá (Set các khoá đã thấy; trùng thì bỏ qua và đếm); nếu con trỏ mới bằng con trỏ cũ hoặc nhỏ hơn thì ném `legacy: keyset cursor did not advance; refusing.`; cột `__cursor_ts` bị gỡ khỏi dòng trả ra.
5. Chỉ SELECT; không dùng `JOIN`, `;`, chuỗi literal, comment (lexer lớp hai giữ nguyên các quy tắc).

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

### 5.5 Marker, tenant, DB name (khoá cho B, hằng số có test từ A)

`vowasia-constants.ts`: `TENANT_SLUG="vowasia"`, `MARKER_SOURCE_NAME="legacy:vowasia"`, `MARKER_ORIGIN="import"`, `CENTRAL_DB_PATHNAME` (lấy lại từ guard có sẵn). Test: khác marker GTP, không chứa `globaltravelpost`.

## 6. Các giai đoạn

### Implementation Checklist: Giai đoạn A — Đọc/discover (EXECUTE ngay sau VALIDATE; không cần biết schema)

Checklist (thứ tự thực hiện; mỗi bước nguyên tử, kèm kiểm tra):

1. Tạo `scripts/migrate/vowasia/lib/vowasia-constants.ts` + `vowasia-constants.test.ts` (marker khác GTP, không chứa `globaltravelpost`, tenant `vowasia`).
2. Tạo `lib/vowasia-config.ts` (zod strict, kiểu site id, bảng/cột, overlay) + `vowasia-config.test.ts` (khoá lạ, "TODO", tên bảng sai, quá 6 bảng, siteIdKind sai, overlay thiếu siteFilter, mặc định đúng 2 bảng).
3. Tạo `lib/vowasia-sql.ts` (bản riêng của builder + lexer + `LegacyReadOnlyDb`) + `vowasia-sql.test.ts`: corpus tấn công (comment, `;`, literal, dollar quote, `JOIN`, comma join, hàm lạ, bảng ngoài allow-list, decoy `secret_table_a..d`), site id `uuid`/`integer`/`text-safe` hợp lệ + không hợp lệ, template khớp tuyệt đối, thứ tự sự kiện `BEGIN`/`QUERY`/`COMMIT`, keyset text có `__cursor_ts`, từ chối `ORDER BY created_at` trên bảng không có `created_at`.
4. Tạo `lib/vowasia-reader.ts` (`LiveVowasiaReader`, `assertVowasiaSite`) + `vowasia-reader.test.ts` với client giả: khử trùng khoá, con trỏ không tiến => lỗi, hai dòng cùng mili-giây khác micro-giây qua ranh giới trang không mất không trùng (mô phỏng bằng client giả tuân theo ngữ nghĩa so sánh text), site slug khác `vowasia` => từ chối.
5. Tạo `lib/vowasia-db-banner.ts` + `vowasia-db-banner.test.ts` (chỉ `host:port/db`, không bao giờ credential; thông báo cố định; `LEGACY_VOWASIA_DB_URL`/`_SSL`/`_CA`).
6. Tạo `lib/vowasia-cli.ts` (parse cờ, `runMain` lỗi cố định, exit 2 cho từ chối) dùng `args.ts`/`out-dir.ts` của GTP chỉ ở mức import (nếu chủ đồng ý câu hỏi 1; ngược lại chép riêng).
7. Tạo `legacy-source.vowasia.json` (giả thuyết) + `fixtures/overlay.fixture.json` (site id giả `...f002`, tên bảng giả).
8. Tạo `discover-vowasia.ts`: đọc catalog, xác minh giả thuyết (báo lệch cột/bảng), đếm theo site, phân bố (status, category/section theo cột cấu hình, năm), phân tích slug (trùng, hoa/thường, ký tự lạ), hình dạng body (HTML/Markdown/JSON, tín hiệu `script`/`iframe`/`on*=`/`javascript:`), thống kê host ảnh + số bài không ảnh, ngày thiếu, ước lượng dung lượng ảnh nếu có cột; ghi `legacy-schema-report.md`, `legacy-mapping.template.json` (cố ý có `TODO`), `query-log.json` vào `scripts/migrate/out/vowasia/` (git-ignored, 700/600). Không in body, không in site id, không in tên bảng ngoài cấu hình.
9. Tạo `sql/01-readonly-inspect.sql`, `sql/02-create-readonly-role-views.sql.template` (phương án 2), `sql/02b-alternative-rls.sql.template` (phương án 1, ghi rõ cảnh báo), `sql/03-drop-role-and-views.sql`. Mọi file có đầu trang: "OWNER-RUN. KHÔNG tự chạy. Đọc `VOWASIA-LEGACY.md` trước." File 01 chỉ SELECT; file 02/03 là DDL do chủ chạy (đây là DDL DUY NHẤT trong cả plan, chỉ trên DB cũ, chủ chạy).
10. Tạo `fixtures/keyset-probe.ts` + `fixtures/keyset-probe.sh` (Hybrid): bật PG16 native cục bộ (cổng riêng 54336, `mktemp -d`, `trap` dọn), tạo bảng giả `articles`/`sites` (site id kiểu `uuid` rồi `integer`), seed các ca: 2 dòng cùng mili-giây khác micro-giây ở ranh giới trang, nhiều dòng `created_at` y hệt khác `id`, `created_at` NULL; đọc bằng reader với `pageSize` 1/2/3; khẳng định đọc đủ, đúng một lần, đúng thứ tự; chạy `discover-vowasia.ts` với `LEGACY_VOWASIA_DB_URL` cục bộ + overlay fixture, khẳng định report sinh ra, `query-log.json` toàn `SELECT` có vị từ site, không `BEGIN` không READ ONLY.
11. Tạo `VOWASIA-LEGACY.md` (tiếng Việt, hướng dẫn chủ từng bước, nêu rõ ai chạy gì, in tên database, `read -s`, `clear`).
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
| Phân tác giả | bản chép của `gtp-author-distribution.ts`: pool 6, nhóm theo quốc gia + quý, độ lệch tối đa 1, tính MỘT lần cho toàn tập, lưu `author-plan.json`; importer chỉ tra tác giả đã tồn tại (không tạo) |
| Slug plan | cùng quy tắc xác định (created_at, id); reserved slugs lấy từ route web VowAsia (chưa biết) |
| Ảnh | tải về R2, tối đa 20 MB/ảnh, dừng nếu ảnh hỏng > 2%, host chỉ trong `hostAllowlist` (overlay), chống SSRF (đã có mẫu `media-fetch.ts`) |
| Importer | chỉ tạo mới, marker `legacy:vowasia`, `origin=import`, dry-run mặc định, `--apply` cần TTY + `--confirm-host` + `assertCentralDbName`, `--limit`, `--resume`, run-id, journal fsync, báo cáo reject |
| Rollback | theo run-id, chỉ xoá bài mang marker vowasia + tenant vowasia, `--include-edited`/`--list-orphans` như GTP |
| Link nội bộ (second pass) | `rewrite-links` theo `slug-map`, dry-run mặc định |
| Ngày đăng/tạo (C7) | `timestamps-fix.sql` sinh sẵn, **chủ chạy**, đầu file nêu `psql -v ON_ERROR_STOP=1`, điều kiện marker vowasia + tenant vowasia |
| Redirect/410 | `urls.gonePaths` -> `{status:410}`, bài có chỗ mới -> 301; chỉ có hiệu lực nếu web mới ship redirect map; bao phủ tối thiểu `--min-coverage` |
| Verify | so khớp số lượng/ngày/tác giả, kiểm công khai bằng read token của tenant (biến `VOWASIA_READ_TOKEN`), kiểm link trong body |
| Fixture + rehearsal | fixture DB cũ tổng hợp (hai site, một là vowasia, id kiểu thật sau discover) + `rehearse-vowasia.sh` (native PG16, một lần, một mình) + `rehearse-assert.ts` |
| npm scripts (dự kiến) | `migrate:vowasia:import`, `:rewrite-links`, `:rollback`, `:redirects`, `:verify`, `:fixture`, `rehearse:vowasia`, `test:migrate-vowasia` (mở rộng) |
| Runbook thật (chủ chạy) | dry-run import -> ghi thử 50 bài (`--apply --limit 50`), chủ xem bằng mắt -> ghi phần còn lại (`--apply --resume`, cùng run-id) -> `rewrite-links` -> SQL khôi phục ngày (chủ chạy) -> verify -> redirect -> gỡ role/view |

## Acceptance Criteria (mục 7, Giai đoạn A)

Không có file SPEC riêng; tiêu chí suy ra từ các quyết định đã chốt (mục 2) và ràng buộc (mục 3). Mỗi tiêu chí nêu gate chứng minh và chiến lược.

| ID | Tiêu chí | proven by | strategy |
|---|---|---|---|
| AC-A1 | Không file GTP nào đổi (kể cả `package.json` ngoài 3 dòng vowasia) | G7, G8 (diff theo pathspec) | Fully-Automated |
| AC-A2 | Mọi SQL phát ra là SELECT một bảng trong allow-list, có vị từ site cố định; corpus tấn công đều bị từ chối | G1: `vowasia-sql.test.ts` | Fully-Automated |
| AC-A3 | Site id kiểu `uuid`/`integer`/`text-safe` được kiểm đúng kiểu; kiểu sai bị từ chối | G1: `vowasia-sql.test.ts`, `vowasia-config.test.ts` | Fully-Automated |
| AC-A4 | Keyset không mất/trùng dòng khi trùng mili-giây khác micro-giây, `created_at` y hệt, `created_at` NULL, trên PG16 thật | G6: keyset-probe.sh | Hybrid (PG16 native cục bộ) |
| AC-A5 | Khử trùng theo khoá và chốt chặn con trỏ không tiến hoạt động | G1: `vowasia-reader.test.ts` | Fully-Automated |
| AC-A6 | Discover chỉ phát SELECT có vị từ site, ghi báo cáo vào thư mục git-ignored, không in id/body/credential | G6 (query-log + grep đầu ra) và G1 (`vowasia-db-banner.test.ts`) | Hybrid |
| AC-A7 | Marker vowasia khác marker GTP và không chứa `globaltravelpost` | G1: `vowasia-constants.test.ts` | Fully-Automated |
| AC-A8 | SQL mẫu chủ chạy: file 01 chỉ đọc; file 02/03 chỉ tạo/xoá đúng schema `vowasia_ro` + role `vowasia_migrator`; không đụng bảng gốc/policy hiện có; không chứa mật khẩu | G9 (review an toàn SQL bởi `vc-code-reviewer`) + G10 (grep máy) | Agent-Probe + Fully-Automated |
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

- Chạm: 20 file mới dưới `scripts/migrate/vowasia/`, 1 file backlog, thư mục plan, và 3 dòng `package.json`.
- Không chạm: bất kỳ file nào khác trong `scripts/migrate/` (GTP), `scripts/lib/`, `scripts/audit/`, `src/`, `docs/`, `process/context/`.
- Runtime: không có (script chạy tay). Không DB Central bị ghi trong A. DB cũ chỉ bị ĐỌC (và DDL role/view do chủ chạy).
- Bằng chứng GTP không đổi: G7 (`git diff --stat` ngoài danh sách phải rỗng), G8 (`git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` thoát 0), kèm G4/G11 xanh.

## Phase Completion Rules

- Giai đoạn A chỉ là `CODE DONE` khi G1-G11 xanh tại EVL; chỉ là `VERIFIED` khi thêm G12 (discover thật do chủ chạy) xanh. Known-Gap AC-A9 giữ cổng A -> B ở CONDITIONAL.
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
| Coupling với helper GTP khi import | Thấp | Chỉ import 2 file trung tính; test chống drift (symbol tồn tại); chủ có thể chọn chép |
| Bài archived mất URL (C2/C3 chưa chốt) | TB | B nhận quyết định qua `urls.*`; discover liệt kê số bài archived/section |

Dự báo rủi ro (tóm tắt thảo luận 5 góc nhìn): (a) an ninh: đây là điểm mạnh/ yếu nhất ở hàng rào quyền, không phải ở mã; (b) vận hành: rủi ro lớn nhất là thao tác tay của chủ trên DB dùng chung, cần SQL ngắn, có dòng "đọc trước", có HS5; (c) bảo trì: bản riêng làm lặp mã nhưng đúng lựa chọn B3; (d) dữ liệu: ngày/URL/tác giả là nơi hỏng tin cậy, đều để B nhận quyết định; (e) kiểm thử: DB thật là Known-Gap duy nhất, có backlog stub.

Ca biên đã đưa vào test (từ ba hạng mục nguy hiểm nhất: SQL guard, keyset, role SQL): chuỗi `site_id` có dấu nháy/`;`; `created_at` ở 1970; hai dòng cùng micro-giây khác id; trang đúng bằng `pageSize` rồi hết; client trả lặp cùng một trang; bảng `sites` có hai dòng cùng slug; cột `site_id` kiểu `bigint`; tên schema có chữ hoa; mật khẩu/URL không bao giờ lọt vào thông báo lỗi.

## Verification Evidence (mục 12)

| Gate / Scenario | Strategy | Proves SPEC criterion |
|---|---|---|
| G1 `npm run test:migrate-vowasia` | Fully-Automated | AC-A2, AC-A3, AC-A5, AC-A6 (banner), AC-A7 |
| G2 `npm run lint:migrate` | Fully-Automated | chất lượng file mới + GTP không vỡ lint (AC-A10) |
| G3 `npm run typecheck` | Fully-Automated | kiểu đúng toàn repo |
| G4 `npm run test:migrate-gtp` | Fully-Automated | AC-A10 |
| G5 `npm run test:single-home` | Fully-Automated | AC-A10 (guard DB/taxonomy vowasia không vỡ) |
| G6 `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` (`probe:migrate-vowasia`) | Hybrid (PG16 native cục bộ; điều kiện: `/usr/lib/postgresql/16/bin`, `runuser`) | AC-A4, AC-A6 |
| G7 `git diff --name-only fe88bc4 -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` chỉ in `package.json` | Fully-Automated | AC-A1 |
| G8 `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` thoát 0 | Fully-Automated | AC-A1, AC-A10 (không file GTP đổi) |
| G7b `git diff -U0 fe88bc4 -- package.json` chỉ có dòng `+` chứa `vowasia` | Fully-Automated | AC-A1 |
| G9 Review an toàn các file `sql/*` + `vowasia-sql.ts` bởi `vc-code-reviewer` (sonnet) | Agent-Probe | AC-A8 |
| G10 `grep -nEi "(insert|update|delete|truncate|drop|alter|grant|create)" sql/01-*.sql` rỗng; `grep -nEi "password\s+'" sql/*` rỗng; `grep -rnEi "postgres(ql)?://" scripts/migrate/vowasia` rỗng | Fully-Automated | AC-A8, HS4 |
| G11 `npm run rehearse:gtp` (MỘT lần, một mình, nền, timeout 7200000; `REHEARSE_MODE=native`; điều kiện: đã chốt câu hỏi 5) | Hybrid | AC-A10 (ràng buộc 9) |
| G12 Discover trên DB cũ THẬT (chủ chạy O5) | **Known-Gap** (backlog stub; cổng A -> B CONDITIONAL) | AC-A9 |

Ghi chú vận hành EVL: `vc-tester` chạy lại độc lập đúng các lệnh trên, tuần tự (G11 và G6 không chạy song song nhau hay song song `npm ci`). Mọi lệnh G1-G10 là đọc/ghi cục bộ trong cây làm việc.

## 13. Owner-Run Steps (danh sách; lời hướng dẫn đầy đủ nằm trong `VOWASIA-LEGACY.md` do EXECUTE A viết)

Giai đoạn A:

- O1: Kiểm A1 bằng lệnh ĐỌC: `npm run audit:add-vowasia-taxonomy` (dry run; in tên database trước; tenant có → xem 49 dòng `exists`/`create`; tenant thiếu → báo "not found"). Ghi kết quả (tenant có/không, taxonomy đã `--apply` chưa).
- O2: Chạy `sql/01-readonly-inspect.sql` trên DB cũ bằng role hiện có của chủ (không dán bí mật). Báo lại: tên bảng liên quan VowAsia, cờ RLS/policy, role hiện tại có `BYPASSRLS` không, kiểu `site_id`, giá trị site id của VowAsia (chỉ nếu chủ thấy an toàn khi chia sẻ qua kênh phù hợp).
- O3: Chọn phương án role (khuyên 2). Chạy `sql/02-create-readonly-role-views.sql.template` (sau khi tự điền placeholder), đặt mật khẩu bằng `openssl rand -base64 24 | pbcopy` + `\password vowasia_migrator`; chạy `clear`.
- O4: `read -s LEGACY_VOWASIA_DB_URL; export LEGACY_VOWASIA_DB_URL` (và `_SSL` nếu cần); không echo, không lưu vào lịch sử.
- O5: Chạy `npm run migrate:vowasia:discover -- --mapping-overlay <overlay ngoài repo>`; tự rà `scripts/migrate/out/vowasia/legacy-schema-report.md` (xoá tên bảng nhạy cảm nếu có) rồi chia sẻ.
- O6: Chốt C3, C8, C10, host ảnh/R2 dựa trên báo cáo.

Giai đoạn B (sau amendment): O7 dry-run import; O8 `--apply --limit 50` + xem bằng mắt; O9 `--apply --resume` phần còn lại (cùng run-id); O10 `rewrite-links`; O11 chạy `timestamps-fix.sql` (C7); O12 verify; O13 redirect/410; O14 chạy `sql/03-drop-role-and-views.sql`. Trước MỌI `--apply`: `node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'` phải in `/neondb`.

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

1. Plan này; trạng thái: vừa viết, CHƯA VALIDATE. Không có Validate Contract (VALIDATE làm sau).
2. Pha kế: VALIDATE (xem khuyến nghị bên dưới), sau đó chủ nói "ENTER EXECUTE MODE" cho **Giai đoạn A** (khuyến nghị duy nhất).
3. EXECUTE phải nhận đúng một đường dẫn plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`.
4. Ngữ cảnh cần đọc: `process/context/all-context.md`, `tests/all-tests.md`, `scripts/migrate/GTP-LEGACY.md`, `scripts/lib/vowasia-taxonomy.ts`, `scripts/lib/central-db-name-guard.ts`, và các file GTP được dùng làm mô hình (đọc, không sửa).
5. Thứ tự checklist A: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14. Sau khi A xong dừng, chờ O1-O6.
6. Quyết định mở phải được trả lời TRƯỚC EXECUTE: câu hỏi 1 (import vs chép helper), 2 (phương án role, có thể hoãn tới O3), 4, 5 (xem mục 2). Nếu chưa trả lời: dùng đề xuất mặc định đã nêu (import `args.ts`+`out-dir.ts`; phương án 2; cùng run-id cho 50+phần còn lại; chạy `rehearse:gtp` một lần) và ghi vào report.
7. Validator khi bàn giao: `node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs <đường dẫn plan>`.
8. Nếu mất ngữ cảnh: đọc mục 2-4, 6A và 12.

## 18. Khuyến nghị `vc-agent-strategy-compare` cho pha VALIDATE

Điểm 7 tín hiệu: S2 (bề mặt quyền/DB, DDL role) có, S6 (lớp rủi ro cao: trust-boundary/permission/secret) có, S7 (5+ file) có; S1, S3, S4, S5 không. **Điểm 3/7 = MEDIUM** => khuyến nghị **parallel subagents** (3 agent, độc lập, đọc-chỉ, không cần giao tiếp giữa chừng; model **sonnet**), mỗi agent một chiều:

1. An toàn SQL/quyền: builder đóng, lexer, file `sql/*`, phương án role, bí mật.
2. GTP-không-đổi + blast radius: pathspec diff, `package.json`, glob test, ràng buộc 9.
3. Khả thi kiểm thử: probe PG16 native, keyset, G11, xung đột tài nguyên giữa các gate.

Phương án khác đã so: tuần tự (rẻ nhất, chậm hơn), workflow (thừa cho 3 chiều đọc-chỉ), agent team (không cần: ba chiều không phải phối hợp blast radius). Chi phí ước tính: 3 agent ≈ 3 lượt đọc plan + file mô hình (dưới ngưỡng 30). EXECUTE A: tuần tự một agent opus.
