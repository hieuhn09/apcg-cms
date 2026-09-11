---
name: cms-cost-remediation-evl-fix2b
description: EVL confirmation for Fix 2b (LIST_SELECT drops tenant/translationStatus/lastEngine/lastEditedBy/assignedTo) — all gates green; Part 2 by orchestrator (deviation, same cause as gzip EVL)
date: 2026-09-11
metadata:
  node_type: report
  type: evl-note
  iteration: 7
  domain: tests
  plan: process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md
---

# EVL — Fix 2b — 11-09-26

**Kết quả: tất cả gate xanh.** Merge `fix/list-select-drop-internal-fields` (`45a02b8`) → `main` được phép về kỹ thuật; chờ user duyệt.

## Part 1 — vc-tester độc lập — 10/10 PASS
typecheck, lint (0 warning trong file sửa), diff chỉ `articles/route.ts` +21, LIST_SELECT toàn `false` (10 key), A3 refsView không `title`, A4 pin keys không trong tập bỏ + clause expiry còn, `[slug]` `depth: 2` untouched, `public.ts` untouched. **Kiểm tên field:** 4 field native trong `Articles.ts` (dòng 214/220/427/443), `tenant` do `multiTenantPlugin` inject (`payload.config.ts:153`) — không phải no-op câm.

## Part 2 — live preview — PASS, **deviation**
Chạy bởi orchestrator (subagent không đọc được secret — cùng nguyên nhân đã ghi ở EVL gzip). Build `apcg-5zu9z7i9t` (= `45a02b8`), so với mốc production `ef6b5e5` lấy trước khi sửa.

| # | Đo | Trước | Sau |
|---|---|---|---|
| 1 | key/doc | 58 | **53** (đúng −5) |
| 1 | 5 field bỏ còn mặt | có | **[]** |
| 1 | `pinnedToLatest`/`pinnedUntil` | có | **còn cả hai** |
| 1 | key mất ngoài dự kiến / key mới | — | **[] / []** |
| 1 | bytes identity limit=20 | 107.403 | **78.663 (−26,8%)** |
| 2 | gzip trên bản này | — | `content-encoding: gzip`, wire **10.986 B** (trước 2b: 12.643) |
| 3 | `view=refs` có `title`? | — | **False** (A3) |
| 4 | `[slug]` detail | — | `body` còn; `lastEngine` chỉ `[engineType,id,name,status]` — `defaultPopulate` còn tác dụng |

Đúng dự báo từ phép đo hôm qua: −26,8% thô, gzip wire chỉ giảm thêm ~13% (12.643 → 10.986) vì các field này vốn nén tốt. Giá trị chính là hygiene.

## Còn mở
- Smoke 5 reader sau merge (health probe + homepage) — làm ngay sau deploy.
- E13 (gzip) vẫn chưa được user đọc trên Observability.
