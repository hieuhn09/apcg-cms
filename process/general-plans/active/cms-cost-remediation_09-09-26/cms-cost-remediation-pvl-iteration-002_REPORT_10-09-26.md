---
name: cms-cost-remediation-pvl-iteration-002
description: PVL cycle 3 — gzip pass-through proven VIABLE and added as Phase 2 #1; Fix 2b re-ranked; edge-cache ban confirmed empirically; scope expanded, re-validate required
date: 2026-09-10
metadata:
  node_type: report
  type: pvl-iteration
  iteration: 4
  pvl_cycle: 2
  domain: plan
  plan: process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md
---

# PVL Iteration 002 — 10-09-26

**Gate trước:** CONDITIONAL (cycle 2, 0 FAIL, 4 CONCERN).
**Hành động:** SUPPLEMENT_APPLIED, 4 gap addressed — nhưng bản chất là **mở rộng scope**: thêm một touchpoint mới, không phải đóng gap cũ.
**Gate sau:** chờ re-validate từ V1 cho touchpoint gzip.

## Gì đã đổi

| Mục | Trước | Sau |
|---|---|---|
| Phase 2 #1 | Fix #1 thu gọn fan-out | **gzip trong `jsonPublic()`** (`src/lib/public.ts`, nhánh `probe/gzip-public-api`) |
| Fix 2b giá trị | ~$24/tháng | **~$1.34/tháng** sau gzip; giữ vì hygiene, vẫn chặn GCV |
| P3 | chưa chạy | **RUN** — 107.463 B identity / 12.578 B gzip; FOT tính trên byte thô |
| P4 | chưa biết | **RUN** — `translationStatus` populate, 307 B/doc |
| What-NOT-To-Do #1 | "s-maxage bị strip" | vế Authorization **xác nhận thực nghiệm** (BYPASS×3); vế s-maxage sửa lại cho đúng |

## Bằng chứng gzip (từ FEASIBILITY artifact)

Preview wire = Node `gzipSync(L6)` local, **sha256 giống hệt** `2361d14c…`, 12.627 B. Không nén kép. JSON identical. Brotli discriminator: edge nhường Function.

## Gap còn lại (4 — không đổi số, đổi nội dung)

1. **GCV** — chặn Fix 2b; giá trị cost của 2b giờ nhỏ, chỉ còn hygiene.
2. **Không test runner** ở cả 4 reader — thường trực.
3. **Rủi ro nền tăng** (không fallback) — thường trực, gate Hybrid bắt buộc.
4. **A3 wording trong thân plan vẫn ngược** (E10 từ cycle 2) — supplement này **chưa** sửa. Cần sửa ở lần PLAN-mode tới.

## Sự kiện ngoài vòng lặp cần ghi

- `origin/main` đã nhận **PR #11** (article video support, cloud agent) — đụng cả hai route public, thêm 4 key `video*` vào `LIST_SELECT` (cùng cơ chế Fix 2b, không xung đột), **2 migration đã chạy trên production**. E1/A3/A4 kiểm lại trên `origin/main`: **còn nguyên**.
- Local `main` fast-forward → `d12befd`. Nhánh probe merge `main` vào để VALIDATE đọc đúng code đích.

## Ghi chú vòng lặp

Không plateau (gap count không tăng, scope mở rộng có chủ đích). Chưa chạm trần. Bước tiếp: re-spawn `vc-validate-agent` từ V1, scope = touchpoint gzip + xác nhận E1/A3/A4 trên code đã merge PR #11.
