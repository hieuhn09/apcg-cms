---
phase: vowasia-legacy-migration-phase-a-execute
date: 2026-10-16
status: COMPLETE_WITH_GAPS
feature: vowasia-launch (general-plans)
plan: process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md
---

# VowAsia legacy migration, Giai đoạn A: báo cáo EXECUTE (16-10-26)

**Kết luận:** Giai đoạn A đã code xong và mọi cổng chạy được trong phiên này đều xanh (G1-G8, G7b, G7c, G10, G13). Không file GTP nào đổi (G7, G8). Còn lại: G9 (review SQL do `vc-code-reviewer`) chưa chạy, EVL độc lập của `vc-tester` chưa chạy, và AC-A9 (DB cũ thật, O1-O6 của chủ) là Known-Gap có tên. Giai đoạn B không được làm (HS7). Chưa push.

TL;DR: 26 file mới dưới `scripts/migrate/vowasia/` + 1 backlog stub + 3 dòng `package.json`; T1 chứng minh đỏ-trước rồi xanh; probe PG16 tạm cục bộ xanh và tự dọn; 2 sai lệch nhỏ trong phạm vi (ghi dưới).

## What Was Done

Thứ tự thực hiện: T1 (bước 6, phần `out-dir`) làm ĐẦU TIÊN theo lệnh của orchestrator, rồi 1 → 2 → 7 (hai file JSON cần cho test bước 2) → 3 → 4 → 5 → 6 (phần còn lại) → 8 → 9 → 10 → 11 → 11b → 12 → 13. Bước 14 chỉ commit cục bộ, không push, không PR (theo lệnh orchestrator).

| Bước | Kết quả | File |
|---|---|---|
| 6 (T1, làm trước) | `out-dir.ts` chép từ GTP, `repoRoot()` sửa thành lùi 4 cấp, comment trung tính; `out-dir.test.ts` (a, b dựng độc lập với `repoRoot()`, c) | `lib/out-dir.ts`, `lib/out-dir.test.ts` |
| 1 | Hằng số tenant/marker/env; `CENTRAL_DB_PATHNAME` re-export từ guard có sẵn | `lib/vowasia-constants.ts` (+test) |
| 2 | Zod strict: khoá lạ, `TODO`, IDENT, tối đa 6 bảng, `siteIdKind`, site filter theo kiểu, `media` tuỳ chọn; parse 2 file JSON (T6c) | `lib/vowasia-config.ts` (+test) |
| 7 | Giả thuyết (`_hypothesis: true`, không id/host/URL) + overlay fixture (schema `vowasia_ro`, đổi tên cột) | `legacy-source.vowasia.json`, `fixtures/overlay.fixture.json` |
| 3 | Registry đóng băng từ config; đủ 8 builder; lexer; `__cursor_ts`; `VowasiaReadOnlyDb` | `lib/vowasia-sql.ts` (+test) |
| 4 | Reader: khử trùng theo khoá, chốt chặn con trỏ, gỡ `__cursor_ts`, `assertVowasiaSite` (đúng 1 dòng, slug `vowasia`) | `lib/vowasia-reader.ts` (+test) |
| 5 | Banner `host:port/db`, `LEGACY_VOWASIA_DB_URL/_SSL/_CA` | `lib/vowasia-db-banner.ts` (+test) |
| 6 (còn lại) | `args.ts` chép riêng (+test); `vowasia-cli.ts`: cờ discover, `runMain` 0/2/1, che URL/mật khẩu trong lỗi lạ (T6a) | `lib/args.ts`, `lib/args.test.ts`, `lib/vowasia-cli.ts`, `lib/vowasia-cli.test.ts` |
| 8 | Discover: kiểm giả thuyết với catalog thật, đếm, phân bố, năm, slug, ngày thiếu, hình dạng body, host ảnh; 3 file đầu ra 700/600; stdout chỉ đường dẫn + số đếm (E9) | `discover-vowasia.ts` |
| 9 | 01 (chỉ SELECT), 02 (phương án 2, chặn khi chưa điền chỗ giữ chỗ, tự kiểm cuối file theo T5a), 02b (phương án 1, cảnh báo), 03 (dọn, chạy lại được) | `sql/*` (4 file) |
| 10 | Probe PG16 native cổng 54336, `mktemp -d` + `trap`; phần A/B keyset (uuid, bigint), C role, D discover qua role + grep đầu ra, D2 từ chối site khác, E 03 + 02b | `fixtures/keyset-probe.sh`, `fixtures/keyset-probe.ts` |
| 11 | Hướng dẫn chủ tiếng Việt (O1-O6, `read -s`, `clear`, in tên database) | `VOWASIA-LEGACY.md` |
| 11b | Stub Known-Gap AC-A9 | `process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` |
| 12 | +3 dòng script, chèn GIỮA khối (sau `test:migrate-gtp`) | `package.json` |

Đếm lại: `git ls-files --others --exclude-standard` = 26 file dưới `scripts/migrate/vowasia/` + 1 file backlog = 27; `package.json` +3 dòng, 0 dòng đổi khác. Cộng báo cáo này trong thư mục task.

## Bằng chứng đỏ-trước của T1 (E1)

Chạy `npx tsx --test scripts/migrate/vowasia/lib/out-dir.test.ts` với `out-dir.ts` chép NGUYÊN từ GTP (`repoRoot()` lùi 3 cấp):

```
not ok 1 - T1(a): repoRoot() is the directory holding both package.json and .git   (expected: true, actual: false)
not ok 2 - T1(b): an in-repo, non-ignored dir OUTSIDE scripts/ is refused before it is created   (error: 'Missing expected exception.')
not ok 3 - T1(c): a dir under scripts/migrate/out/ is accepted ...   (expected: '/home/user/apcg-cms/scripts/migrate/out', actual: '/home/user/apcg-cms/scripts/scripts/migrate/out')
ok 4 - an outside-repo dir is accepted, mode 700
# pass 1  # fail 3
```

(b) đỏ đúng kiểu nguy hiểm: guard bị bỏ qua và thư mục `<repo>/process/vowasia-guard-probe` bị TẠO (khối `finally` của test xoá lại; kiểm sau: `ls process | grep vowasia` = 0).

Ghi chú trung thực về (c): ở lần chạy đầu, (c) chỉ gồm "thư mục `scripts/migrate/out/...` dựng từ vị trí file được chấp nhận", và ca đó XANH trên bản lỗi (vì `git -C <repo>/scripts check-ignore` vẫn khớp luật `/scripts/migrate/out/` neo ở gốc repo). Mô phỏng của validate pass 3 nói (c) đỏ; trên repo thật thì không. Tôi thêm vào (c) ca thư mục mặc định dựng từ `repoRoot()` (đúng đường CLI dùng: `DEFAULT_OUT`), ca này đỏ trên bản lỗi như trên. Sau khi sửa `repoRoot()` lùi 4 cấp: 4/4 xanh.

## Test Gate Outcomes

Chạy tuần tự trong phiên này (16-10-26, nhánh `claude/vowasia-launch`, trước commit). Đây là kết quả của EXECUTE, CHƯA phải EVL độc lập.

| Cổng | Lệnh | Kết quả |
|---|---|---|
| G1 | `npm run test:migrate-vowasia` | 47/47 pass, 0 fail (7 file test) |
| G2 | `npm run lint:migrate` | 0 lỗi, 1 cảnh báo có sẵn (`seed-gtp-legacy-fixture.ts:179 't50sec'`); cảnh báo mới `Row` trong discover đã xoá |
| G3 | `npm run typecheck` | exit 0 |
| G4 | `npm run test:migrate-gtp` | 69/69 pass |
| G5 | `npm run test:single-home` | 267/267 pass |
| G6 | `bash scripts/migrate/vowasia/fixtures/keyset-probe.sh` | exit 0, "ALL PROBE CHECKS PASSED" (chạy lần cuối sau mọi sửa) |
| G7 | `git diff --name-only fe88bc4 -- . ':(exclude)scripts/migrate/vowasia' ':(exclude)process/general-plans'` | chỉ `package.json` |
| G7b | `git diff -U0 fe88bc4 -- package.json \| grep -E '^\+[^+]'` | đúng 3 dòng, cả 3 chứa `vowasia` |
| G7c | `! git ls-files --others --exclude-standard \| grep -vE "^(scripts/migrate/vowasia/\|process/general-plans/)"` | exit 0 (rỗng) |
| G8 | `git diff --quiet fe88bc4 -- scripts/migrate ':(exclude)scripts/migrate/vowasia'` | exit 0 |
| G10 | 3 lệnh `! grep` (01 không có từ ghi/DDL ngoài comment; không `password '...'` trong `sql/*`; không `postgres://`/`postgresql://` ngoài test/probe) | cả 3 exit 0 |
| G13 | `test -f process/general-plans/backlog/vowasia-real-db-validation_NOTE_16-10-26.md` | exit 0 |
| G9 | review an toàn `sql/*` + `vowasia-sql.ts` bởi `vc-code-reviewer` | CHƯA CHẠY (việc của orchestrator; agent này không spawn) |
| G11 | `rehearse:gtp` | KHÔNG chạy (O-Q5, mặc định) |
| G12 | discover trên DB cũ thật | Known-Gap AC-A9 (backlog stub, G13) |

Probe G6 đã chứng minh gì (dữ liệu giả, PG16 cục bộ):
- A/B: 14 dòng vowasia (xen 14 dòng site khác cùng thời điểm) đọc đúng một lần, đúng thứ tự `ORDER BY` của DB, với pageSize 1/2/3, cả site id `uuid` lẫn `bigint` (id bigint giảm dần theo thời gian để thứ tự id không che lỗi). Ca: cùng mili-giây khác micro-giây ở ranh giới trang, 3 dòng `created_at` y hệt khác id, 2 NULL, 1970, offset `+07`.
- C: `02` chưa điền bị chặn (không tạo role); `02` đã điền chạy xong, tự kiểm `SELF-CHECK OK`; role đọc view chỉ ra site vowasia, cột cá nhân không có trong view (42703); đọc `public.articles`, `public.sites`, decoy `secret_table_a` bị từ chối (42501); `default_transaction_read_only = on`; UPDATE/DELETE/INSERT qua view, UPDATE/TRUNCATE bảng gốc, CREATE TABLE ở `vowasia_ro` và `public`, DROP VIEW, `SET ROLE postgres` đều 42501 kể cả trong `BEGIN READ WRITE`; `relrowsecurity`/`relforcerowsecurity`/`relacl` bảng gốc + `pg_policies` không đổi trước/sau.
- D: discover qua role (overlay fixture, schema `vowasia_ro`) exit 0; 10 câu trong `query-log.json` đều `SELECT` có vị từ site hoặc catalog giới hạn; báo cáo có lệch giả thuyết (`role section -> articles.section not found`); stdout, stderr, 3 file đầu ra KHÔNG chứa id site (có/không gạch), mật khẩu, mẫu body, mẫu title, email, `secret_table`; thư mục 700, file 600.
- D2: discover với site khác bị từ chối exit 2 (qua view: không thấy dòng site; trên bảng gốc: slug không phải vowasia); thiếu site filter exit 2.
- E: `03` xoá schema + role, chạy lại vẫn sạch, bảng gốc không đổi; `02b` chưa điền bị chặn, đã điền áp được trên database tạm (`probe_rls`, chỉ kiểm cú pháp) rồi xoá.

Dọn probe (HS6): sau mỗi lần chạy `ls -d /tmp/vowasia-probe-*` rỗng, cổng 54336 đóng, không tiến trình postgres còn lại. Một PG gỡ lỗi riêng (cổng 54337, `/tmp/vowasia-dbg-*`) đã dừng và xoá; `scripts/migrate/out/` rỗng; không thư mục rác trong `process/`.

## Plan Deviations

Cả hai trong phạm vi Touchpoints, không đổi file/cổng/phạm vi:

1. **Chốt chặn con trỏ (E4 (ii)):** trang chỉ chứa khoá đã thấy ném lỗi khi trang ĐẦY; trang NGẮN (ít hơn `pageSize`) toàn khoá đã thấy được coi là hết dữ liệu và dừng. Lý do: trang ngắn tự kết thúc nên không thể lặp vô hạn; ném lỗi ở đó làm hỏng ca nguồn trả trang chồng lấn (test `overlap` đỏ). Ca (i) con trỏ bằng nhau vẫn ném lỗi ở mọi trang; không so "nhỏ hơn" trên chuỗi timestamptz.
2. **Test T1 (c):** thêm ca thư mục mặc định dựng từ `repoRoot()` (xem mục đỏ-trước). Ngoài ra thứ tự: T1 làm trước bước 1 (theo lệnh orchestrator), bước 7 làm trước bước 3 (test bước 2 cần hai file JSON).

Chi tiết thiết kế đã chọn trong khung plan (không phải sai lệch): `siteRow` đọc cột slug/name từ `tables.sites.slugColumn/nameColumn`; `slugPlanRows` nhận danh sách cột từ vai cột (không literal); cờ `--site-id` giữ theo Public Contracts nhưng hướng dẫn chủ khuyên đặt id trong overlay (E10); kiểm `--schema` theo IDENT và cho phép đè schema của config.

## Defaults used (E7)

- O-Q1: chép riêng `args.ts` và `out-dir.ts` (không import file GTP).
- O-Q2: phương án role 2 (schema `vowasia_ro` + view) làm mặc định trong hướng dẫn; chủ chốt sau khi chạy `01`.
- O-Q3: allow-list nguồn mặc định chỉ `articles` + `sites`.
- O-Q5: không chạy `rehearse:gtp`.
- Quy tắc chủ ghi nhận, không áp dụng ở A (không có importer): importer chỉ tạo mới, không sửa, không xoá, không tạo tác giả; mỗi `--apply` một run-id mới, không `--resume`.

## What Was Skipped or Deferred

- Giai đoạn B (mapping, transform, importer, rollback, verify, redirect, rehearsal): không làm (HS7).
- Push, PR nháp: không làm (orchestrator push sau EVL).
- G9, EVL `vc-tester`: chưa chạy.
- `docs/12-migration.md`, `process/context/*`: không sửa (để UPDATE PROCESS).
- Ước lượng dung lượng ảnh: không làm ở A (không có cột dung lượng trong cấu hình); báo cáo ghi rõ.

## Test Infra Gaps Found

- G6 cần PG16 native + `runuser` + `psql` + user `postgres` (có trong máy này). Thiếu thì probe thoát 3 với dòng `UNPROVEN`.
- G6 không phủ: múi giờ/DateStyle/kiểu `created_at` của DB thật (ví dụ `timestamp` không múi giờ), PG ≤ 14 (PUBLIC có CREATE trên `public`), phương án 1 ngoài cú pháp.
- Gap GTP giữ nguyên (chỉ ghi): keyset cắt micro-giây + `pages()` không khử trùng ở bản GTP.
- `CONTEXT_PARTIAL`: không có.

## Closeout Packet

- Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md`.
- Phân loại: **Keep in active/testing** (chờ EVL `vc-tester`, G9, và Known-Gap AC-A9 do chủ chạy O1-O6).
- Đã xác minh: G1-G8, G7b, G7c, G10, G13 trong phiên EXECUTE. Chưa xác minh: EVL độc lập, G9, G12.
- Còn lại: EVL, G9, push + PR nháp, UPDATE PROCESS (docs/context), chủ chạy O1-O6.
- Trạng thái kế tiếp: EVL (`vc-tester` chạy lại G1-G8, G7b, G7c, G10, G13; G6 một mình).

## Forward Preview

### Test Infra Found
`npm run test:migrate-vowasia` (tsx `node:test`, glob `scripts/migrate/vowasia/lib/*.test.ts`, không DB); `npm run probe:migrate-vowasia` (PG16 tạm, cổng 54336, ~3 giây).

### Blast Radius Changes
Chỉ thêm file dưới `scripts/migrate/vowasia/`, 1 backlog, 3 dòng `package.json`. Glob GTP `scripts/migrate/lib/*.test.ts` không nhặt test vowasia; `lint:migrate` và `tsc` phủ file mới.

### Commands to Stay Green
G1-G5 như bảng trên; G6 chạy một mình (không song song `npm ci` hay rehearsal).

### Dependency Changes
Không thêm dependency (dùng `zod`, `pg`, `pg-connection-string` có sẵn).

## Vòng sửa EVL 1 (16-10-26, sửa phát hiện review G9)

TL;DR: sửa đủ 7 MAJOR, 9 MINOR, 3 NIT (n3 chỉ ghi chú). Tự kiểm của `02` nay chạy TRONG giao dịch và tự huỷ khi sai; `02b` có hàng rào trong SQL; doc viết lại cho zsh. Probe thêm biến thể chủ bảng KHÔNG-superuser và tìm ra một lỗi thật ở `03` (đã sửa). Mọi cổng xanh. Số file vẫn 27, `package.json` vẫn +3 dòng.

| Mục | Kết quả | Bằng chứng |
|---|---|---|
| M1 `#` trong khối lệnh | Đã sửa: không còn `#` trong khối lệnh nào; giải thích ra văn xuôi | awk quét mọi khung `bash`: 0 dòng có `#`, `<`, `>` |
| M2 `<...>` trong lệnh | Đã sửa: dùng `~/vowasia-private/02-filled.sql`, `~/vowasia-private/overlay.json` | như trên |
| M3 nhiều lệnh một khối | Đã sửa: mỗi khung đúng 1 lệnh; `read -s` khung riêng; mục "Cách dán lệnh" có câu dặn chờ con trỏ / dấu nhắc `%`, `clear` trước khi chụp | awk: mọi khung 1 dòng |
| M4 mật khẩu base64 | Đã sửa: `openssl rand -hex 24 \| pbcopy`; O4 nói cách ghép vào URL; không bảo chủ dán/chụp bí mật | doc O3.5, O4 |
| M5(a) tự kiểm sau COMMIT | Đã sửa: khối `DO` + `RAISE EXCEPTION 'SELF-CHECK STOP: ...'` trước COMMIT; header: tự kiểm trước, mật khẩu sau | probe C: id sai / slug sai -> psql lỗi, 0 role, 0 schema, bảng gốc không đổi |
| M5(b) dọn dùng biến đã unset | Đã sửa: bước Dọn nhập lại URL bằng `read -s` trong terminal mới; đồng bộ `03` (CLEANUP OK) | doc "Dọn" |
| M6 `02b`/`03` không có hàng rào | Đã sửa: `02b` NOTICE trạng thái RLS TRƯỚC khi bật, chặn FORCE RLS, chặn khi có role đăng nhập khác (không chủ, không BYPASSRLS) dùng được bảng; `03` NOTICE trạng thái RLS/policy còn lại + SELECT `CLEANUP OK`; cả hai nói rõ tắt RLS là bước tay | probe G: có `probe_inspector` -> `RLS GUARD STOP`, RLS không đổi, không role; bỏ nó -> áp được |
| M7 quyền PUBLIC | Đã sửa: `01` liệt kê relacl 2 bảng, ACL schema `public`, CONNECT/TEMP của PUBLIC, hàm SECURITY DEFINER PUBLIC gọi được; `02` chặn hàm SECURITY DEFINER trong `public`, NOTICE số ở schema khác + CONNECT/TEMP; doc nói thật giới hạn | G10a xanh (01 vẫn chỉ đọc) |
| m1 slug placeholder + CREATE | Đã sửa: `__VOWASIA_SITE_SLUG__`; chặn CREATE trên database và mọi schema; thêm chặn membership | probe C |
| m2 `01` theo relacl + toàn bộ role | Đã sửa: mục 5 (mọi role `rolcanlogin`), 5b giữ phiên đang mở để đối chiếu | probe C0 |
| m3 `01` chỉ-đọc + probe | Đã sửa: `SET default_transaction_read_only = on;` đầu file; probe chạy `01` bằng role chỉ có `pg_read_all_data` | probe C0 |
| m4 VALID UNTIL | Đã sửa: 14 ngày (EXECUTE format trong `DO`); doc: xoá role / đổi mật khẩu nếu B bị hoãn | probe C kiểm `rolvaliduntil` |
| m5 in DB/user + xác nhận cuối | Đã sửa: `SELECT current_database(), current_user` đầu `02`/`03`; `03` kết bằng `CLEANUP OK`; doc dặn xác nhận đúng DB CŨ | probe C/E/F |
| m6 khoá slug + credential | Đã sửa: `expectedSiteSlug` chỉ nhận `vowasia` (`config: ... must be vowasia`); banner chỉ nhận user `vowasia_migrator` (`LEGACY_ROLE`) | đỏ trước (test m6 fail) -> xanh; probe D2 (đăng nhập `postgres` bị từ chối, exit 2) |
| m7 SSL hiệu lực | Đã sửa: từ chối tham số `ssl*` trong URL (kiểm trước khi parse); banner in chế độ SSL thực tế (`sslLabel`) | đỏ trước -> xanh; probe D2 (`?sslmode=disable` exit 2) |
| m8 `fileURLToPath` | Đã sửa: `moduleDir()` trong `out-dir.ts` (repoRoot dùng nó; `vowasia-cli.ts` đi qua repoRoot) | test đường dẫn có dấu cách + ký tự có dấu: đỏ trước -> xanh |
| m9 `--site-id` | Đã sửa: bỏ khỏi `DISCOVER_FLAGS` và header; id site chỉ từ overlay | test cli; probe D2 (`--site-id` exit 2; site khác thử qua overlay riêng) |
| n1 chmod | Đã sửa: chỉ chmod thư mục do công cụ tạo; thư mục có sẵn giữ mode | test n1: đỏ trước -> xanh |
| n2 "3 chỗ" | Đã sửa (header 02 viết lại, "thay HẾT mọi lần xuất hiện") | — |
| n3 PG tạm trust | Không sửa (theo chỉ dẫn): probe dùng `--auth=trust` chỉ trên 127.0.0.1, thư mục tạm, cổng 54336; ghi chú trong doc | — |
| n4 dọn biến | Đã sửa: O5 bước 5 `unset LEGACY_VOWASIA_DB_URL` + đóng terminal; cuối "Dọn" `unset LEGACY_ADMIN_URL` | doc |

Phát hiện mới khi probe (đã sửa): chủ bảng KHÔNG-superuser có CREATEROLE (kiểu Supabase/Neon) chạy `03` bị lỗi `permission denied to drop objects` ở `DROP OWNED BY` (PG 16 đòi quyền của role). `03` nay bắt `insufficient_privilege`, tự `GRANT vowasia_migrator TO current_user` (người tạo có ADMIN OPTION) rồi chạy lại; quyền này mất theo `DROP ROLE`. Probe F xanh (02 SELF-CHECK OK, role chỉ đọc view, 03 CLEANUP OK) bằng `site_owner`.

Số liệu cổng (sau sửa, tuần tự, G6 một mình):
- G1 `test:migrate-vowasia` 53/53 pass (trước 47).
- G2 `lint:migrate` 0 lỗi, 1 cảnh báo có sẵn (`seed-gtp-legacy-fixture.ts`).
- G3 `tsc --noEmit` exit 0.
- G4 `test:migrate-gtp` 69/69. G5 `test:single-home` 267/267.
- G6 probe PG16 (cổng 54336): ALL PROBE CHECKS PASSED, gồm A/B, C0, C, D, D2, E, F, G; dọn sạch.
- G7 chỉ `package.json`; G7b 3 dòng đều có `vowasia`; G7c rỗng; G8 exit 0.
- G10 (a, b, c) rỗng. G13 file backlog có.
- Số file: 26 dưới `scripts/migrate/vowasia/` + 1 backlog = 27; `package.json` +3 dòng (không đổi). Không file mới.

Known-Gap còn lại (ghi, không chặn): probe không có zsh nên quy tắc dán lệnh chỉ kiểm bằng quét tĩnh; PG ≤ 14 (PUBLIC có CREATE trên `public`) chỉ được phủ bằng logic tự kiểm, không chạy thật; hàm SECURITY DEFINER ở schema ngoài `public` chỉ được báo (NOTICE), không chặn.

## Vòng sửa EVL 2 (16-10-26, sửa phát hiện review G9 lần 2)

TL;DR: sửa đủ m-A..m-H và các NIT rẻ; m-I chấp nhận. Mọi cổng xanh, probe thêm 7 ca (DB NAME STOP, STOP vì hàm SECURITY DEFINER PUBLIC gọi được, role NOLOGIN chặn 02b, hai thứ tự gỡ 02b). Số file vẫn 27 (26 dưới `scripts/migrate/vowasia/` + 1 backlog), `package.json` vẫn +3 dòng. Không file mới.

| Mục | Kết quả | Bằng chứng |
|---|---|---|
| m-A dòng OK vô điều kiện | Đã sửa: 02 in `SELF-CHECK OK` chỉ khi role VÀ schema tồn tại, còn lại `SELF-CHECK FAILED: nothing created`; 02b in `RLS SETUP OK` chỉ khi role + 2 policy + RLS bật | probe C (`lastLine = SELF-CHECK OK`), G (`RLS SETUP OK`) |
| m-B gia hạn role | Đã sửa doc + header 02: đổi mật khẩu KHÔNG gia hạn; chọn Dọn rồi chạy lại 02, HOẶC một lệnh `ALTER ROLE vowasia_migrator VALID UNTIL '...'` (một khối, không `#`, không `<...>`) | quét khối lệnh: 0 dòng `#`/`<`/`>`, mỗi khối 1 dòng |
| m-C 02b | Đã sửa: (a) hàng rào bắt MỌI role không phải chủ/superuser/BYPASSRLS (kể cả NOLOGIN), và PUBLIC; bỏ qua role hệ thống `pg_*` (thành viên đăng nhập vẫn bị bắt qua kế thừa); (b) `SET LOCAL lock_timeout = '3s'`; (c) role NOINHERIT + VALID UNTIL 14 ngày; (d) tự kiểm PUBLIC như 02 (CREATE database/schema, hàm SECURITY DEFINER, bảng ngoài articles/sites, quyền ghi) + kiểm trạng thái cuối trong giao dịch. 01 thêm mục 5a (role NOLOGIN đọc được hai bảng) và 5e (đồ thị thành viên) | probe G: `probe_anon NOLOGIN` có SELECT -> `RLS GUARD STOP ... probe_anon`, không đổi gì; role sau 02b `NOT rolinherit` + `rolvaliduntil` ~14 ngày |
| m-D view khoá cột | Đã sửa: câu rõ trong doc (ghi chú O3) và header 02: không chạy migration đổi cột articles/sites giữa 02 và 03 | doc |
| m-E chốt tên DB | Đã sửa: 02/02b có chỗ giữ chỗ `__LEGACY_DB_NAME__` (chặn nếu chưa điền), `RAISE` khi `current_database() = 'neondb'` hoặc khác tên đã điền; 03 bắt buộc `-v legacy_db=...` (thiếu -> lỗi cú pháp psql, dừng trước mọi DROP; sai/`neondb` -> `DB NAME STOP`). Bỏ câu "Ctrl+C ngay"; doc thêm bước một lệnh `psql ... -At -c 'SELECT current_database()'` chạy TRƯỚC | probe C: tên sai, `neondb` (02 và 03) -> STOP, 0 role/schema; E: 03 thiếu/sai biến -> không xoá gì (role + schema còn 2) |
| m-F SECURITY DEFINER ngoài public | Đã sửa: nâng thành STOP mặc định (02 và 02b). Tham số rõ `allow_definer_outside_public constant text := 'no'` trong khối tự kiểm; chủ chỉ đổi `'yes'` sau khi xem 01 mục 5d. Lý do: hàm đó chạy bằng quyền chủ hàm, có thể đọc/ghi bảng gốc vượt view; im lặng là rủi ro; dừng-và-báo rẻ hơn | probe C: hàm `probe_ext.leak()` SECURITY DEFINER, PUBLIC có USAGE -> `SELF-CHECK STOP ... 1 SECURITY DEFINER function(s) outside public`, không tạo gì |
| m-G cột articles/sites | Đã sửa: 01 mục 6b SELECT `information_schema.columns` (table_name, column_name, data_type, ordinal_position); doc O2/O3 dặn dùng nó điền `__ARTICLE_COLUMNS__` | G10a xanh (01 vẫn chỉ đọc); probe C0 chạy 01 tới cuối |
| m-H thứ tự gỡ 02b | Đã sửa: một thứ tự duy nhất ở header 02b và doc: gỡ policy (+ DISABLE RLS chỉ khi BEFORE ghi `f`) BẰNG TAY TRƯỚC, rồi 03. Lý do: 03 không đổi RLS bảng gốc; nếu chạy 03 trước, policy mất nhưng RLS vẫn bật. Probe đo thật cả hai đường | probe G: gỡ tay rồi 03 -> `CLEANUP OK`, `AFTER rls_enabled=f vowasia_policies_left=0`; 03 thẳng sau 02b -> `CLEANUP OK`, `AFTER rls_enabled=t vowasia_policies_left=0` (DROP OWNED xoá policy, RLS VẪN BẬT: xác nhận thứ tự đúng) |
| NIT `nano` thay TextEdit | Đã sửa (cảnh báo dấu nháy cong; phím tắt nano) | doc O3.3 |
| NIT `mkdir -m 700` | Đã sửa | doc O3.1 |
| NIT bỏ `export LEGACY_ADMIN_URL` | Đã sửa ở O2 và Dọn; câu quy tắc an toàn sửa đúng: URL role mới chỉ ở `LEGACY_VOWASIA_DB_URL`, URL quản trị chỉ ở `LEGACY_ADMIN_URL` (không export); "không truyền URL qua cờ dòng lệnh của công cụ discover" | doc |
| NIT O4 host trực tiếp | Đã sửa: không dùng pooler (`user.projectref`) | doc O4 |
| NIT xoá file riêng tư | Đã sửa: `rm -f ~/vowasia-private/02-filled.sql ~/vowasia-private/overlay.json` sau Dọn | doc |
| NIT PG ≤ 14 | Đã sửa: ghi chú tự kiểm luôn STOP, dừng-và-báo là đúng, không tự REVOKE (doc + header 02) | logic; KHÔNG chạy trên PG 14 thật (Known-Gap giữ) |
| NIT O1 DATABASE_URL | Đã sửa: cần `DATABASE_URL` của Central đã đặt; thiếu thì `Invalid URL`, dừng | doc O1 |
| m-I role cấp cụm | Chấp nhận (không sửa code): doc thêm câu chạy 01 mục 5c/5d ở từng database role kết nối được | doc O3 ghi chú |
| Plan còn liệt kê `--site-id` | Không sửa ở đây (plan ngoài phạm vi vòng này): để UPDATE PROCESS sửa Public Contracts/CLI của plan | — |

Số liệu cổng (tuần tự, G6 một mình):
- G1 `test:migrate-vowasia` 53/53. G2 `lint:migrate` 0 lỗi, 1 cảnh báo có sẵn (`seed-gtp-legacy-fixture.ts`). G3 `typecheck` exit 0. G4 `test:migrate-gtp` 69/69. G5 `test:single-home` 267/267.
- G6 probe PG16 (cổng 54336): ALL PROBE CHECKS PASSED (A/B, C0, C gồm DB NAME STOP + definer STOP, D, D2, E gồm 03 thiếu/sai `legacy_db`, F, G gồm NOLOGIN + hai thứ tự gỡ); dọn sạch.
- G7 chỉ `package.json`; G7b 3 dòng đều có `vowasia`; G7c rỗng; G8 exit 0.
- G10 (a, b, c) rỗng (lần đầu G10a bắt chuỗi `INSERT, UPDATE` trong truy vấn mới 5a của 01; đã thu về `'SELECT'`, 02b vẫn kiểm quyền ghi). G13 file backlog có.
- Số file: 26 + 1 backlog = 27; `package.json` +3 dòng.

Known-Gap còn lại: không có zsh (quy tắc dán lệnh chỉ kiểm tĩnh); PG ≤ 14 chỉ phủ bằng logic; probe dùng database tên `neondb` cục bộ giả để chứng minh chốt tên, không phải Central thật.

## Vòng sửa EVL 3 (16-10-26, sửa phát hiện iteration-005)

| Mục | Đã sửa | Bằng chứng |
|---|---|---|
| MINOR-1 dòng cuối `(1 row)` | Chọn `-X -q -t -A` cho MỌI lệnh chạy 02/02b/03 trong doc và header SQL; khi đó dòng cuối in ra đúng là dòng trạng thái. Probe chạy đúng cờ đó (hàm `psql` ghi chú khớp doc). | probe C/E/F/G: `lastLine` = `SELF-CHECK OK` / `RLS SETUP OK` / `CLEANUP OK` |
| MINOR-2 03 một giao dịch | 03 bọc `BEGIN ... COMMIT`; `set_config(..., true)` + khối DO cùng giao dịch; guard đọc `current_setting(..., true)`. Doc O2/Dọn: host trực tiếp, không transaction pooler (6543). | probe E mới: 03 KHÔNG ON_ERROR_STOP, sai tên DB -> `CLEANUP STOP: role ... still exists`; thiếu `-v legacy_db` -> `CLEANUP STOP` |
| MINOR-3 dòng trạng thái | 02: OK chỉ khi role + schema + 2 view + SELECT của role trên 2 view (CASE lồng, không lỗi khi role thiếu). 02b: thêm quyền SELECT cột của role. Doc + header nêu 3 kết cục. | probe C mới: 02 sai DB không ON_ERROR_STOP -> `SELF-CHECK FAILED: nothing created`, không tạo gì |
| MINOR-5 gia hạn / dọn | `read -s` ngay trước khi gia hạn; `VALID UNTIL 'YYYY-MM-DD'` chủ tự điền, ≤14 ngày; Dọn: chỉ xoá file riêng khi không chạy lại, chạy lại thì làm lại O4. | doc |
| MINOR-6 + tester MINOR-1 | Mục O3b mới cho 02b (lệnh một khối, dặn ghi dòng BEFORE ngay); gỡ tay bằng một `psql -c` có `SET lock_timeout = '3s'` đầu chuỗi; header 02b "chờ tối đa 3 giây"; 02 thêm `SET LOCAL lock_timeout = '3s'` sau BEGIN. | probe G chạy đúng lệnh `-c` của doc, exit 0, sau đó 03 -> `rls_enabled=f` |
| NIT chữ | TL;DR nêu đúng file 02/02b/03; nano Ctrl+\ rồi `A`. | doc |

Không sửa (ghi nhận, chuyển UPDATE PROCESS/backlog): MINOR-4 (hàm trigger SECURITY DEFINER trong `public` và DB tên `neondb` đều -> STOP; cần amendment nếu gặp thật); soạn URL trong ghi chú tạm không đồng bộ (chấp nhận); NIT còn lại (vài ca probe chỉ khẳng định status != 0, comment 03, URL admin trên argv của psql, sslmode có sẵn trong URL nhà cung cấp, 5c/5d chỉ ACL schema, nhãn mục 01).

Cổng chạy lại (16-10-26): G1 `test:migrate-vowasia` fail 0; G2 lint:migrate 0; G3 typecheck 0; G4 test:migrate-gtp 0; G5 test:single-home 0; G6 probe một mình cổng 54336 "ALL PROBE CHECKS PASSED", đã dọn; G7 chỉ `package.json`; G8 0; G7b đúng 3 dòng `vowasia`; G7c rỗng; G10 rỗng; G13 có. Số file: 26 dưới `scripts/migrate/vowasia/` + báo cáo này = 27; `package.json` +3. Không file mới.

## Amendment 1: chạy phần SQL bằng SQL Editor của Supabase (16-10-26)

**Kết luận:** Đã thêm cách B (SQL Editor, không cần mật khẩu `postgres`) theo phạm vi chủ đồng ý. Mọi cổng chạy được đều xanh, trừ G10b dạng nguyên văn: nó bắt chỗ giữ chỗ `'__PASSWORD__'` của file 02p mà amendment bắt buộc phải có. Cần sửa lệnh G10b trong plan (xem dưới). Chỉ đụng file dưới `scripts/migrate/vowasia/` + báo cáo này; `package.json` vẫn đúng +3 dòng cũ.

TL;DR: 3 file SQL mới (01e, 02p, 03e), banner nhận `vowasia_migrator.<20 ký tự a-z0-9>` (không in ra), doc có "Cách B" B1-B6, probe thêm phần H. Chưa thử trong Editor thật.

| Mục | Đã làm | Bằng chứng |
|---|---|---|
| 1 | `sql/01e-inspect-single-result.sql`: MỘT câu `WITH ... SELECT` (12 nhánh UNION ALL: 1, 2, 3, 4, 5, 5a, 5e, 5b, 5c, 5d, 6b, 6), cột `section, item, detail`, xếp theo mục; dòng đầu `database \| role`; mục trống in `(none)`; bảng thiếu in `missing` (dùng `to_regclass` + `query_to_xml` cho mục 6) thay vì lỗi; không `SET`, không lệnh psql, không `SELECT *` | probe H: một result set duy nhất, chạy trong `BEGIN READ ONLY` bằng role không-superuser (`probe_inspector`), đủ mục, thấy dòng site `vowasia`, không chứa mẫu body/title/email; trên database trống không lỗi. G10a mở rộng cho 01e xanh |
| 2 | `sql/02p-set-password.sql.template`: đúng một `ALTER ROLE vowasia_migrator PASSWORD '__PASSWORD__';` + comment (chỉ sau SELF-CHECK OK, `openssl rand -hex 24`, xoá snippet) | probe H: chỉ dòng đó khớp `password '`; sau 02 `rolpassword` NULL, sau 02p là `SCRAM-SHA-256$...`, đầu ra psql không lặp mật khẩu, role đăng nhập và đọc view |
| 3 | `sql/03e-drop-in-editor.sql.template`: logic 03 nguyên vẹn, `:'legacy_db'` thay bằng `'__LEGACY_DB_NAME__'`; thêm STOP khi chỗ giữ chỗ chưa điền | probe H: chưa điền / sai tên / `neondb` -> `DB NAME STOP`, không xoá gì (có và không có ON_ERROR_STOP: dòng cuối `CLEANUP STOP: role vowasia_migrator still exists`; dán kiểu Editor: lỗi P0001, không xoá gì); đã điền -> `CLEANUP OK` (kiểu Editor và `psql -f`), chạy lại vẫn OK; bảng gốc không đổi |
| 4 | `lib/vowasia-db-banner.ts`: `isAcceptedLegacyUser` nhận `vowasia_migrator` hoặc `^vowasia_migrator\.[a-z0-9]{20}$`; banner vẫn chỉ `host:port/db` | đỏ-trước: test mới `not ok 7` trên mã cũ, rồi 7/7 xanh. Chấp nhận `vowasia_migrator.abcdefghijklmnopqrst`; từ chối `.short`, `postgres.<ref>`, chữ hoa, `.x` thừa, 21 ký tự, `vowasia_migrator.`, tiền tố lạ, rỗng (thông báo cố định); kết quả không chứa mã project |
| 5 | `VOWASIA-LEGACY.md`: TL;DR + bảng "Ai làm gì" + quy tắc an toàn cập nhật; mục mới "Cách B" (hạn chế trung thực, B1-B6); mỗi khối lệnh đúng một lệnh (`cat ... \| pbcopy`, `openssl rand -hex 24 \| pbcopy`, `read -s`, `export`), không `#`, không `<`/`>`, không scheme URL | quét tay: 8 khối, mỗi khối 1 dòng; G10c xanh |
| 6 | probe: phần H mới trong `fixtures/keyset-probe.ts` (không file test mới); không có test tĩnh cho doc nên không mở rộng | G6 xanh |

Cổng (chạy tuần tự, 16-10-26, trước commit; G6 chạy cuối, một mình):

| Cổng | Kết quả |
|---|---|
| G1 `test:migrate-vowasia` | 54/54 |
| G2 `lint:migrate` | 0 lỗi, 1 cảnh báo có sẵn |
| G3 `typecheck` | exit 0 |
| G4 `test:migrate-gtp` | 69/69 |
| G5 `test:single-home` | 267/267 |
| G6 probe | exit 0, ALL PROBE CHECKS PASSED, tự dọn (không còn thư mục `/tmp/vowasia-probe-*`) |
| G7 / G7b / G7c / G8 | chỉ `package.json` / 3 dòng đều chứa `vowasia` / rỗng / exit 0 |
| G10a (01 và 01e) | exit 0 (01e kiểm thêm từ `set`) |
| G10b nguyên văn `! grep -nEi "password[[:space:]]+'" sql/*` | **ĐỎ có chủ đích**: khớp đúng `02p...:15 ALTER ROLE vowasia_migrator PASSWORD '__PASSWORD__';` |
| G10b đề xuất `! grep -nEi "password[[:space:]]+'" sql/* \| grep -v "'__PASSWORD__'"` | exit 0 |
| G10c | exit 0 |
| G13 | exit 0 |

Số file: 29 dưới `scripts/migrate/vowasia/` + 1 backlog = 30.

Sai lệch: G10b phải đổi như trên (plan đang được ghi Amendment 1 bởi agent khác; tôi không sửa plan). Bổ sung ngoài chữ của lệnh, trong phạm vi: 03e thêm STOP riêng cho chỗ giữ chỗ chưa điền; 01e in `(none)`/`missing` để không lỗi khi bảng khác tên.

Known-Gap (trung thực):
- Chưa thử trong SQL Editor thật của Supabase; "kiểu Editor" chỉ là gửi cả file như một chuỗi qua node-pg tới PG16 cục bộ.
- Xác thực cục bộ là `trust`: probe chứng minh 02p lưu verifier SCRAM, KHÔNG chứng minh đăng nhập bằng mật khẩu qua pooler Supabase.
- Supabase session pooler với role tự tạo dạng `vowasia_migrator.<ref>` chưa thử thật.
- PostgreSQL 14 trở xuống: 02 luôn STOP.
- Hàm SECURITY DEFINER ngoài `public` trên Supabase: 02 có thể STOP; chỉ nới `allow_definer_outside_public` sau khi xem mục 5d của 01e.
- Editor có thể lưu truy vấn chứa mật khẩu (02p) hoặc id site (02): doc yêu cầu xoá ngay.

## Vòng sửa Amendment 1 (16-10-26, sửa phát hiện review G9, iteration-009)

TL;DR: 11 phát hiện cần sửa đã sửa (02p tự sinh mật khẩu trong SQL, phím tắt Mac đúng, bảng "02 dừng ở đâu", hàm trả trigger không còn làm 02 dừng, che mã project, giới hạn ghi thật). Mọi cổng xanh; probe G6 xanh một mình. Không thêm file (29 dưới `scripts/migrate/vowasia/` + 1 backlog = 30); `package.json` không đổi.

| # | Trạng thái | Sửa ở đâu | Bằng chứng |
|---|---|---|---|
| 1 | đã sửa | `sql/02p` viết lại: không chữ giữ chỗ; khối `DO` dừng (`02P STOP`) khi thiếu role, schema `vowasia_ro`, hai view/quyền SELECT, hoặc role superuser/BYPASSRLS/là thành viên; sinh 64 hex từ hai `gen_random_uuid()`, `EXECUTE format('ALTER ROLE vowasia_migrator PASSWORD %L', pw)`, `set_config(..., true)`; câu SELECT cuối trả `new_secret` + `warning`. Doc B4/B5 viết lại | probe H: 3 ca STOP không đặt mật khẩu; `psql -f` (từng câu) hiện `NOT SHOWN`, không in 64 hex; Editor-style hiện 64 hex; verifier SCRAM; bật SCRAM tạm trong `pg_hba` cho `vowasia_migrator`: mật khẩu sai -> 28P01, mật khẩu sinh ra đăng nhập và đọc view, chạy lại sinh giá trị mới, giá trị cũ -> 28P01; giá trị không có trong `pg.log`; lỗi probe che mọi giá trị đã sinh |
| 2 | đã sửa | doc B3/B6, header `03e`: Mac Cmd+Option+F, Windows/Linux Ctrl+H, Replace All, tìm `__` sau khi thay | `grep -n "Cmd+H"` chỉ còn câu cảnh báo "KHÔNG phải Cmd+H" |
| 3 | đã sửa | doc B2 (đọc trước chỗ dừng) + B3 bảng 11 dòng lỗi -> nghĩa -> làm gì, mọi dòng: báo lại, không tự sửa, cấm `REVOKE ... FROM PUBLIC`; `01e` thêm `5f` (relation PUBLIC có quyền, đánh dấu trong/ngoài articles/sites), `5g` (schema PUBLIC tạo được đối tượng), quyền tạo schema của database ở `5c`; `5d` đếm như 02 (USAGE của PUBLIC trên schema, không tính hàm trả trigger) + `in_public=yes/no`; `02` và `02b`: loại `trigger`/`event_trigger` khỏi hai guard DEFINER, phần khác giữ nguyên | probe C: hàm DEFINER thường trong `public` -> STOP; `public.handle_new_user()` (trigger) + `probe_trg.on_ddl()` (event_trigger) có mặt khi 02 đầy đủ chạy -> `SELF-CHECK OK`; m-F vẫn đếm đúng 1. Probe H: 01e liệt kê `5f`, `5g`, `in_public=yes`, không liệt kê hàm trả trigger |
| 4 | đã sửa | `redact()` che `vowasia_migrator.<20>` và `db.<20>.supabase.co`; banner in host trực tiếp thành `db.<ref>.supabase.co`; câu doc sửa cho đúng | test mới `vowasia-cli.test.ts` (lỗi giả `password authentication failed for user "vowasia_migrator.abcdefghijklmnopqrst"` không còn mã) và `vowasia-db-banner.test.ts` |
| 5 | không sửa (không cần, như yêu cầu) | | |
| 6 | đã sửa | doc B1: đối chiếu tên project `globaltravelpost` ở góc trên trái trước mọi SQL; nói rõ chốt tên database vô nghĩa trên Supabase; nhắc lại ở B4/B6 | đọc doc |
| 7 | đã sửa | doc B3/B6 + Hạn chế: cấm `02b` ở cách B; `03e` trả trạng thái AFTER (RLS hai bảng, số policy còn lại) trong ô kết quả cuối, bỏ khối NOTICE | probe H: Editor-style hàng cuối `{CLEANUP OK, false, false, 0}`; `psql -f` dòng cuối `CLEANUP OK\|false\|false\|0` |
| 8 | đã sửa | `01e`: mục 6 lên đầu; hàng cuối `9 total rows`; `6b` sắp theo (bảng, vị trí cột); mục 6 không lỗi khi `public.sites` thiếu cột (`pg_attribute` kiểm trước, in `columns missing`); doc B2 có lệnh dự phòng một dòng; header viết lại | probe H: hàng đầu là mục 6, hàng cuối khớp số hàng, 6b không xen kẽ, DB có `sites(id,title)` vẫn ra bảng |
| 9 | đã sửa | qua #1; `01e` thêm `password_encryption` | probe H |
| 10 | đã sửa | `01e` `5c` thêm `databases PUBLIC can CONNECT to`; doc Hạn chế + B6 nói Editor chỉ thấy `postgres`, rủi ro cấp cụm đã chấp nhận | probe H (thấy `probe_uuid`) |
| 11, 13 | đã sửa (doc) | Hạn chế cách B: probe dùng trust + superuser; 03e/02p chưa thử bằng chủ không-superuser; PG15 chưa thử; đăng nhập pooler chưa xác nhận; SSL `require` không kiểm chứng chứng chỉ; Editor có thể giới hạn số hàng; Editor không hiện NOTICE | đọc doc |
| 12 | đề xuất cổng mới (plan-agent viết vào plan) | xem dưới | đột biến 6/6 đỏ |

Lưu ý cách viết `01e`: cổng G10a (từ khoá ghi, ranh giới từ) bắt cả chữ trong chuỗi, nên `5f`/`5g`/`5c` đọc quyền của PUBLIC bằng `aclexplode` (grantee 0 = PUBLIC; quyền schema chỉ có USAGE và quyền tạo, nên "khác USAGE" = quyền tạo) thay vì truyền tên quyền dạng chữ. Probe xác nhận kết quả khớp điều kiện dừng của 02 trên các ca thử.

### Cổng mật khẩu đề xuất (danh sách trắng, thay G10b; chạy trong `scripts/migrate/vowasia`)

```
! grep -HnEiw "password" sql/* | grep -vE "^sql/[^:]+:[0-9]+:[[:space:]]*--" | grep -vE "^sql/02p-set-password\.sql\.template:[0-9]+:[[:space:]]*EXECUTE format\('ALTER ROLE vowasia_migrator PASSWORD %L', pw\);$"
```

Mọi dòng không phải comment có từ `password` (ranh giới từ, nên `new_secret`, `password_encryption` không khớp) đều vi phạm, trừ đúng một dòng `EXECUTE format(...)` của 02p. Bằng chứng (bản sao `sql/` ngoài repo trong scratchpad, xoá sau): nguyên trạng exit 0 (xanh); đột biến exit 1 (đỏ) cả 6: `PASSWORD 'hunter2hunter2'`, `PASSWORD E'...'`, `PASSWORD $$...$$`, `PASSWORD` rồi xuống dòng, đổi `pw` trong dòng EXECUTE thành chữ cố định, nối thêm `ALTER ROLE ... PASSWORD 'x'` sau dòng EXECUTE. Known-Gap của cổng: một bí mật viết sẵn KHÔNG đi kèm từ `password` (ví dụ trong `set_config`) không bị bắt; G9 là lớp bổ sung. G10b cũ vẫn xanh nhưng đã mù với dạng 02p mới.

### Số cổng thật (sau vòng sửa)

- G1 `test:migrate-vowasia` 56/56 pass (có 2 test mới: redact, banner).
- G2 `lint:migrate` 0 lỗi, 1 cảnh báo có sẵn (`t50sec`). G3 `typecheck` exit 0. G4 `test:migrate-gtp` 69/69. G5 `test:single-home` 267/267.
- G6 probe (một mình, cổng 54336, tự dọn): ALL PROBE CHECKS PASSED.
- G7 chỉ `package.json`; G7b đúng 3 dòng `vowasia`; G7c rỗng; G8 exit 0; G13 exit 0.
- G10: từ khoá ghi trong `01` rỗng; G10b cũ rỗng; `postgres://` ngoài test/probe rỗng; G10a (`01e`): từ khoá ghi rỗng, một `;`, không `\`. Cổng danh sách trắng mới: xanh (đột biến 6/6 đỏ).
- Số file dưới `scripts/migrate/vowasia/`: 29 (+ 1 backlog = 30).
- Quét tĩnh doc: mọi khung lệnh một dòng, không `#`, `<`, `>`, `postgres://`; `read -s` khối riêng; không câu nào bảo dán/chụp/gửi bí mật.

### Known-Gap còn lại (nói thật)

- Chưa chạy trong SQL Editor thật: việc `set_config(..., true)` sống tới câu SELECT cuối dựa trên giả định Editor gửi cả file như một truy vấn (một giao dịch ngầm), chỉ thử bằng node-pg nhiều câu một chuỗi. Nếu Editor tách câu: ô hiện `NOT SHOWN` (an toàn: mật khẩu đổi nhưng không lộ, role không đăng nhập được tới khi chạy lại đúng cách).
- Mật khẩu hiện trong ô kết quả: Supabase có thể lưu kết quả truy vấn hoặc log phía máy chủ (ví dụ pgaudit) mà ta không kiểm được; doc yêu cầu đóng tab sau khi chép.
- SCRAM chỉ thử trên PG16 cục bộ với `127.0.0.1`; đăng nhập qua session pooler Supabase chưa xác nhận.
- 02p và 03e chỉ thử bằng superuser cục bộ (02/03 đã thử bằng chủ không-superuser).
- Điều kiện `5f`/`5g` của 01e dùng ACL (grantee 0) còn 02 dùng `has_*_privilege` của role: tương đương khi role chỉ có quyền của PUBLIC, chỉ thử trên ca probe.

## Vòng sửa tài liệu cuối (Amendment 1, sau review G9 delta, 16-10-26)

Chỉ đổi chữ trong `VOWASIA-LEGACY.md` và dòng chú thích `--` của `sql/02*`, `sql/02b*`, `sql/03e*`. Logic SQL và mã TypeScript không đổi. Vẫn 30 file mới, `package.json` không đổi.

| Mục | Đã sửa | Bằng chứng |
|---|---|---|
| MIN-1 `__` trong chú thích 03e | có | chú thích nay nói "tìm chữ LEGACY_DB_NAME"; thay thử 4 chỗ giữ chỗ trên bản sao tạm ngoài repo: `grep -c __` = 0 ở 02, 02p, 03e |
| MIN-2 bảng chỗ dừng thiếu "already exists" | có | thêm hàng `role "vowasia_migrator" already exists` (đã OK thì sang B4, không thì B6 rồi B3); hàng "bypasses RLS" sửa: role cùng tên có sẵn bị chặn sớm hơn bởi `CREATE ROLE` (02 dòng 84) |
| MIN-3 dự báo dừng ở B2 | có | nêu cả `in_public=yes` (dừng cứng) và `in_public=no` (dừng khi `allow_definer_outside_public` = `'no'`) |
| MIN-4 clipboard | có, phương án đơn giản | B4 không chép mật khẩu; B5: chép chuỗi Session pooler vào ghi chú, đổi user, RỒI quay lại B4 chép `new_secret` và thay `[YOUR-PASSWORD]`; tab lỡ đóng thì Run lại 02p. Không dùng phép thay chuỗi của zsh vì chưa thử được trong zsh thật và cú pháp ngoặc vuông mong manh; cách ghi chú ít bước hơn, sai thì chỉ lỗi kết nối |
| MIN-5 hàm trigger SECURITY DEFINER | có | một câu trung thực ở "Quy tắc an toàn" và chú thích đầu 02, 02b |
| MIN-6 hạn 14 ngày + view khoá cột ở cách B | có | thêm vào Hạn chế của cách B: quá hạn thì B6, B3, B4, B5 lại (không gia hạn bằng psql); không migration đổi cột articles/sites giữa B3 và B6 |
| NIT md5 | có | B2 và B4: `password_encryption` = `md5` thì DỪNG, báo orchestrator |
| NIT nút copy / xoá clipboard | có | dự phòng bấm ô rồi Cmd+C; sau B5 chép một chữ vô hại |
| NIT Cmd+H | có | `grep -n "Cmd+H"` doc: 0 kết quả |
| NIT id site | có | O2 mục 6 và B2: không cần gửi cho ai |
| NIT `\` trong 01e | có | ghi chú ở B2: thoát của LIKE, không phải meta-lệnh |

Cổng chạy lại (16-10-26): G1 56/56; G2 0 lỗi, 1 cảnh báo có sẵn; G3 exit 0; G4 69/69; G5 267/267; G7 chỉ `package.json`; G7b 3 dòng; G7c rỗng; G8 exit 0; G10 (3 lệnh, gồm cổng mật khẩu danh sách trắng) rỗng; G10a rỗng; G13 exit 0. G6 (probe) không chạy: không đổi gì probe dùng. Quét tĩnh doc: mỗi khối bash một dòng, không `#`/`<`/`>`, không `postgres://`/`postgresql://`, không "Cmd+H".

## Amendment 2 (19-10-26): EXECUTE

TL;DR: `02` nay cho qua ĐÚNG hai bảng pg_net của Supabase (`net._http_response`, `net.http_request_queue`, khớp schema+tên+relkind `r`) và tự kiểm `default_transaction_read_only=on` qua `pg_db_role_setting`; `01e` 5f gắn nhãn hai bảng đó; probe G14a-d xanh, mọi đột biến đỏ; mọi cổng xanh. Không đụng GTP, không DB thật, không file mới. G9 review chưa chạy (orchestrator gọi).

**Đã làm (đúng phạm vi Amendment 2):**

| File | Thay đổi |
|---|---|
| `sql/02-create-readonly-role-views.sql.template` | `allow_public_relations constant text[]` = đúng 2 tên; phép kiểm bảng thêm `AND NOT (c.relkind = 'r' AND n.nspname \|\| '.' \|\| c.relname = ANY (allow_public_relations))`; `RAISE NOTICE` liệt kê quan hệ được phép mà role với tới; tự kiểm `pg_db_role_setting` (setdatabase 0) đầu khối TỰ KIỂM, STOP `default_transaction_read_only is not set to on`. Dòng `ALTER ROLE ... default_transaction_read_only = on` giữ nguyên, không lặp. Header ghi lý do + giới hạn. |
| `sql/01e-inspect-single-result.sql` | Tiêu đề 5f: `(02 stops on any not allowed by its allow-list)`; `detail` thêm `(allowed by 02 allow-list)` cho đúng 2 bảng (relkind r) và `PUBLIC privileges=...`; vẫn một câu, thứ tự hàng không đổi. `01` không có mục 5f: không sửa. |
| `sql/03e-drop-in-editor.sql.template` | Header: tìm `__` (phải ra 0) thay cho "tìm chữ LEGACY_DB_NAME" (khớp doc B6). |
| `lib/vowasia-sql.test.ts` | +3 test (allow-list đúng 2 tên + khớp chính xác; một dòng ALTER ROLE + tự kiểm setting; nhãn 01e + một câu). |
| `fixtures/keyset-probe.ts` | Ca G14 b, c, c' (tên trong danh sách nhưng là view), d (bỏ dòng ALTER ROLE) STOP không tạo gì; G14a: `02` áp với 2 bảng `net` cấp ALL cho PUBLIC, NOTICE liệt kê cả hai, `SHOW default_transaction_read_only` = on, `DELETE FROM net._http_response` bị từ chối (25006) trong phiên mặc định; 01e 5f gắn nhãn đúng bảng, không gắn `net2._http_response`. `.sh` không đổi. |
| `VOWASIA-LEGACY.md` | O1: lệnh có `--confirm-host=TÊN_HOST`; O3 ghi chú + B2 đoạn "Về `5f` và hai bảng `net`" (lý do, không REVOKE/GRANT trong `net`, giới hạn K2, chỉ thử PG16 cục bộ K1); bảng "02 dừng ở đâu" thêm dòng setting; B5: xoá hẳn ghi chú ở "Recently Deleted" của Notes. |
| Plan | Checklist Amendment 2 bước 1-7 đánh dấu; một dòng bằng chứng. HS5 đã ghi ngoại lệ từ trước, không đổi. |

**Đỏ trước (red-first):**
- Unit: 3 test mới ĐỎ 3/3 trên template/01e cũ, rồi xanh.
- Probe với `02` của HEAD: `FAILED: G14d setting missing` (02 cũ không tự kiểm).
- Đột biến trên `02` mới (mỗi lần một probe, chạy một mình): M1 thêm `net.other` -> `FAILED: G14b net.other: 02 must stop` (unit đỏ 1); M2 bỏ `relkind = 'r'` -> `FAILED: G14c' allow-listed name as a view: 02 must stop` (unit đỏ 1); M3 chỉ khớp tên (`'net.' || relname`) -> `FAILED: G14c net2._http_response: 02 must stop` (unit đỏ 1); M4 tắt tự kiểm setting -> `FAILED: G14d setting missing: 02 must stop` (unit KHÔNG đỏ: test chỉ kiểm chữ, probe mới bắt hành vi); M5 danh sách rỗng -> `02 apply failed: ... has a privilege on a table outside vowasia_ro` (unit đỏ 1).
- Lỗi tự bắt: lần đầu M2 lọt probe vì ca c' để bảng gốc đổi tên vẫn có quyền PUBLIC (02 dừng sai lý do). Đã sửa ca (REVOKE trên bảng đổi tên trong DB tạm), M2 nay đỏ.

**Cổng (19-10-26, kết quả thật):** G1 59/59; G2 0 lỗi, 1 cảnh báo có sẵn (`seed-gtp-legacy-fixture.ts:179 't50sec'`); G3 exit 0; G4 69/69; G5 267/267; G6 exit 0 `ALL PROBE CHECKS PASSED`, cleanup xong, không listener 5433x trước khi chạy, không thư mục tạm còn lại; G7 chỉ `package.json`; G7b đúng 3 dòng vowasia; G7c rỗng; G8 exit 0; G10 (01 không từ khoá ghi) rỗng; cổng mật khẩu danh sách trắng: nguyên trạng XANH, 6 đột biến (`PASSWORD '...'`, `E'...'`, `$$...$$`, xuống dòng, giá trị viết sẵn thay `pw`, thêm ALTER sau EXECUTE) đều ĐỎ (bản sao tạm ngoài repo, đã xoá); G10a: 0 từ khoá ghi, 1 dấu `;`, 0 dòng bắt đầu bằng `\`; G10c rỗng; G13 exit 0; G14a-d xanh (trong G6); `validate-plan-artifact.mjs` 0 failure.

**Known-Gap (giữ nguyên tên):** K1 chưa thử trong SQL Editor thật của Supabase; K2 `default_transaction_read_only` tắt được bằng `SET` (role đọc/ghi được 2 bảng `net` nếu tự tắt); K3 bảng tiện ích khác ở project khác vẫn DỪNG, cần amendment mới. Thêm: unit test không bắt đột biến M4 (chỉ probe bắt).

**Còn lại:** G9 review độc lập (`vc-code-reviewer`) trên SQL `02` + EVL độc lập (`vc-tester`); chủ chạy lại `01e` trong Editor để thấy nhãn mới trước khi chạy B3.

## Amendment 2: vòng sửa sau G9 + EVL 013 (19-10-26)

**Kết quả:** sửa chữ G9 MAJOR-1 + MINOR-2, thêm K4-K6 vào plan, thêm 3 ca probe (G15a-c). Mọi cổng xanh. KHÔNG đổi dòng SQL thực thi nào (02 chỉ đổi comment; 01e, 01, 02p, 03, 03e không đổi).

**Đã làm:**
- 02 (chỉ comment, header Amendment 2): đọc 2 bảng `net` là VÔ ĐIỀU KIỆN; ghi `net.http_request_queue` (khi tắt chỉ-đọc) theo thiết kế pg_net có thể gửi HTTP ra ngoài từ máy chủ DB (chưa kiểm trên pg_net thật); sửa giả/xoá `net._http_response`; lộ mật khẩu = lộ hơn dữ liệu VowAsia; giảm thiểu B3-B6 một lần ngồi, khuyến nghị rút `VALID UNTIL` (không đổi giá trị SQL), mật khẩu chỉ clipboard/Notes rồi dọn Recently Deleted. Bằng chứng: `git diff -U0 ... 02-*.template | grep -E '^[+-][^+-]' | grep -vE '^[+-]--'` rỗng.
- `VOWASIA-LEGACY.md` B2 (đoạn `5f`/`net`): cùng nội dung. B3: sau BẤT KỲ lỗi nào chạy `ROLLBACK;` trong cùng tab rồi đóng tab.
- Plan: K2 viết lại; chủ xác nhận lại "A" theo chữ mới = **PENDING**; thêm K4 (PG16 vs PG17/MAINTAIN), K5 (allow-list chỉ tên + relkind: không kiểm thành viên `pg_net`, bảng con, trigger/rule), K6 (SELECT trạng thái cuối không kiểm lại setting/`VALID UNTIL`, chỉ liên quan psql không ON_ERROR_STOP). K1-K3 giữ.
- Probe: G15a `public.other` PUBLIC-đọc -> STOP; G15b `GRANT SELECT (a) ON public.probe_colonly TO PUBLIC` -> STOP; G15c sau khi 02 áp xong, `ALTER ROLE vowasia_migrator SET default_transaction_read_only = off`, chạy lại khối DO tự kiểm trích nguyên văn từ template đã điền -> `SELF-CHECK STOP ... not set to on` (kiểm sanity: khối qua khi setting = on), rồi đặt lại on.

**Đỏ trước (đột biến tạm trong repo, khôi phục bằng bản sao, `cmp` xác nhận):**

| Đột biến 02 | Probe |
|---|---|
| thêm `'public.other'` vào allow-list | ĐỎ `FAILED: G15a public.other: 02 must stop` |
| bỏ nhánh `has_any_column_privilege` | ĐỎ `FAILED: G15b column-only grant: 02 must stop` |
| tự kiểm chấp nhận mọi giá trị (`LIKE '%default_transaction_read_only=%'`) | ĐỎ `FAILED: G15c self-check with setting = off: expected SQLSTATE P0001, got success` |

**Cổng (đầu ra thật):** G1 59/59; G2 0 lỗi, 1 cảnh báo có sẵn; G3 exit 0; G4 69/69; G5 267/267; G6 (chạy MỘT MÌNH, kiểm `/proc/net/tcp` không LISTEN 54336 trước/sau) exit 0, `ALL PROBE CHECKS PASSED`, `cleanup done`, có dòng G14a-d và G15a-c, không còn `/tmp/vowasia-probe-*`; G7 chỉ `package.json`; G7b 0 dòng thêm không chứa `vowasia`; G7c rỗng; G8 exit 0; G10 (01) rỗng; G10a rỗng, 1 `;` (ngoài comment), 0 dòng `\`; cổng mật khẩu: nguyên trạng XANH, 6 đột biến (bản sao ngoài repo) đều ĐỎ; G10c rỗng; G13 exit 0.

**Còn lại:** chủ xác nhận lại "A" theo K2 mới (PENDING); K1, K4-K6 mở.
