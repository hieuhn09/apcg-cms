---
name: cms-cost-remediation-evl-gzip
description: EVL confirmation for the gzip touchpoint (cycle 3) — all gates green; Part 2 executed by orchestrator due to subagent permission constraint (deviation recorded)
date: 2026-09-10
metadata:
  node_type: report
  type: evl-note
  iteration: 6
  domain: tests
  plan: process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md
---

# EVL — gzip touchpoint — 10-09-26

**Kết quả: tất cả gate xanh.** Merge `probe/gzip-public-api` → `main` được phép về mặt kỹ thuật; chờ user duyệt.

## Part 1 — gate local (vc-tester, độc lập) — PASS

typecheck, lint (20 warning có sẵn, toàn `src/migrations/*`), diff scope chỉ `public.ts`, `X-Origin-Encoded` grep rỗng, `GZIP_MIN_BYTES=1024` / `GZIP_LEVEL=6`, E1 / A3 / A4 / `depth:0` guard, provenance migration PR #11 (commit `a165ce6` trên cả hai nhánh).

## Part 2 — gate live preview — PASS, **có deviation**

**Deviation:** hai vc-tester liên tiếp bị **Auto Mode Bash classifier** chặn khi đọc `.env.local` và `bypass.secret`, kể cả với marker `# APPROVED:.env.local` — subagent trong phiên này về cấu trúc không chạm được secret. Cả hai dừng đúng, không lách. Part 2 do **orchestrator** chạy trực tiếp (quyền đọc `.env.local` đã được user duyệt trong phiên). Đây là gate cơ học (so byte), không có phán đoán, nhưng **không phải gate độc lập** theo nghĩa của protocol. Ghi lại để không ai đọc nhầm.

Build đo: `https://apcg-5em85nxar-apcg.vercel.app` (= `babbbde`, sau E12), created 16:37:32 GMT+7.

| # | Đo | Kết quả |
|---|---|---|
| 1 | `Accept-Encoding: gzip` | 200, `content-encoding: gzip` đơn, `vary: Origin, Accept-Encoding`, **không** `x-origin-encoded` |
| 2 | `identity` | 200, không content-encoding, 20 docs |
| 3 | `br, gzip` | preview → **gzip** (edge nhường Function); production đối chứng → **br** |
| 4 | Node | decoded==identity **true**; byte-identical vs `gzipSync(L6)` **true**; double-encoded **false**; 12.643 / 107.463 B = **8,50×** |
| 5 | 401 với token giả | 401, body `{"ok":false,"status":"unauthorized"}`, **không** content-encoding (< 1024 B) |
| 6 | `fetch()` undici mặc định | 200, `r.json()` 20 docs — đường reader thật giải nén trong suốt |

## E13 — chưa chạy được (known-gap, có lưới)

Per-route bytes trên Observability cho `/api/public/articles` phải rơi từ ~100 KB → ~13 KB/request trong vài giờ sau khi lên production. Không thể đo trước merge. Nếu không rơi: revert một commit, không ảnh hưởng dữ liệu.

## Bối cảnh ngoài vòng lặp

`origin/main` nhận PR #11 và #12 (cloud agent `tender-ptolemy`) trong lúc EVL chạy — hai migration đã apply trên production qua deploy của chính chúng. Probe đã merge cả hai; diff vs main vẫn chỉ `public.ts`. Probe pushed tại `1ad5dbb`.
