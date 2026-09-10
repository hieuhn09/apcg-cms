---
name: cms-cost-remediation-pvl-iteration-001
description: PVL cycle 1 — P10/P8d closed for 4 of 5 readers; Fix 2b block narrowed to GCV only; risk baseline raised
date: 2026-09-10
metadata:
  node_type: report
  type: pvl-iteration
  iteration: 1
  domain: plan
  plan: process/general-plans/active/cms-cost-remediation_09-09-26/cms-cost-remediation_PLAN_09-09-26.md
---

# PVL Iteration 001 — 10-09-26

**Gate trước:** CONDITIONAL (outer-pvl, 09-09-26) — 0 FAIL, 5 CONCERN.
**Hành động:** SUPPLEMENT_APPLIED, 10 edits.
**Gate sau:** chờ re-validate từ V1.

## Gap được đóng

| Gap (từ pass 1) | Trạng thái | Bằng chứng |
|---|---|---|
| P10 "không chạy được trong môi trường này" | **ĐÓNG cho 4/5 reader** | Tiền đề sai: 3 trong 4 repo nằm sẵn ở `/home/hieunc/Code/`. Audit 13 agent trên `origin/main`, 0/8 lượt bác bỏ thành công |
| P8d (next/image config 4 reader kia) | **ĐÓNG cho 4/5** | Không repo nào dùng `next/image` thật, không repo nào có `remotePatterns` |
| Fix 2b bị chặn bởi "4 repo chưa biết" | **Thu hẹp** | Chặn giờ chỉ còn GCV. KHÔNG mở |

## Gap còn lại (4)

1. **GCV chưa audit** — chặn Change A. Repo không có trên máy.
2. **P1 / P2b / P3 chưa chạy** — cổng Phase 0 vẫn PARTIALLY MET.
3. **P8a-c chưa chạy** — Cloudflare R2 domain chưa gắn.
4. **Không có test runner ở cả 4 reader** — known-gap thường trực, không đóng được bằng planning.

## Phát hiện mới (không phải gap của pass 1)

- **Rủi ro TĂNG, không giảm.** Cả 4 reader đã xoá Payload nội bộ (`97d970e` / `413cada` / `61bc3e0` / `8f8de17`). Không còn fallback; mọi thay đổi hợp đồng đập thẳng vào 4 site production. Cộng với việc không repo nào có test hay runtime validation, mọi hỏng hóc đều im lặng ở HTTP 200.
- **wtb-web CÓ đọc Central** — niềm tin trước đó rút từ working tree lạc hậu 27 commit, sai.
- **A3 / A4** — hai điều khoản phải khoá: `view=refs` giữ `title`; `pinnedToLatest` + `pinnedUntil` giữ làm key.
- **Defect production đang chạy** — `wad-web:src/lib/article-view.ts:344` đọc `.body` từ list doc; Central đã ship `body:false` từ 04/09 nên read-time thẻ bài WAD rơi về "5 MIN READ" từ đó. Không do Change A.
- **Fix #6 đã xong upstream** — 3 reader tự làm derivative selection rồi.

## Ghi chú vòng lặp

Không phát hiện plateau (đây mới là cycle 1). Chưa chạm trần 10 cycle.
Việc còn lại của cycle này: re-spawn `vc-validate-agent` từ V1 với plan đã cập nhật.
