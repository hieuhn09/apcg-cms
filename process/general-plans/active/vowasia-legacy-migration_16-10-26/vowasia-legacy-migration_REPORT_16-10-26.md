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
