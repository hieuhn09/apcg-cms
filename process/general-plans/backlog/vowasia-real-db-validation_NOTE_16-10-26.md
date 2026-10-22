---
name: note:vowasia-real-db-validation
description: "Known-Gap AC-A9: VowAsia phase A discover tooling not yet proven on the REAL legacy DB; owner runs O2-O5, result gates the A -> B transition"
date: 16-10-26
feature: vowasia-launch
---

Status 22-10-26: addressed in practice. The owner ran phase A for real on 19-10-26 (plan Amendment 3 §3.1) and stage B on production on 20-10-26 (see `vowasia-b-beta-owner-import_NOTE_20-10-26.md`).

# Known-Gap AC-A9: discover trên DB cũ THẬT (VowAsia, Giai đoạn A)

Plan: `process/general-plans/active/vowasia-legacy-migration_16-10-26/vowasia-legacy-migration_PLAN_16-10-26.md` (AC-A9, G12).

TL;DR: công cụ Giai đoạn A chỉ được chứng minh trên dữ liệu giả (unit test + PG16 tạm cục bộ). Hành vi trên DB cũ thật (schema thật, RLS thật, role thật) chưa được chứng minh. Đây KHÔNG phải bằng chứng PASS; cổng A -> B giữ CONDITIONAL tới khi mục dưới đạt.

## Ai chạy, khi nào

- Người chạy: chủ dự án (agent không có và không xin quyền vào DB cũ).
- Hạn: trước khi mở amendment / plan bổ sung cho Giai đoạn B (HS7).
- Hướng dẫn: `scripts/migrate/vowasia/VOWASIA-LEGACY.md` (O1-O6).

## Kết quả cần thu về

1. O1: tenant `vowasia` có trên Central chưa; taxonomy 49 dòng `exists` hay `create` (dry run, database `/neondb`).
2. O2: tên bảng bài viết/site của VowAsia và tên cột; cờ RLS/policy của hai bảng; role hiện tại và các role đang kết nối có vượt RLS không; kiểu `site_id`. Không kèm tên bảng nhạy cảm khác.
3. O3: phương án role đã chọn (khuyên 2); dòng tự kiểm của `02` là `SELF-CHECK OK`.
4. O5: `legacy-schema-report.md` đã tự rà (không bí mật, không tên bảng nhạy cảm).

## Tiêu chí nhận (đóng gap)

- Discover thật thoát 0; báo cáo không còn `MISMATCH (blocking)`; mọi `MISMATCH (role skipped)` đã được xử lý trong overlay hoặc được chủ chấp nhận rõ.
- `query-log.json` chỉ gồm câu `SELECT` có vị từ site (`= $1) AS t`) hoặc truy vấn catalog giới hạn theo danh sách bảng.
- Báo cáo, stdout, stderr không chứa id site, mật khẩu, URL kết nối hay nội dung bài.
- Site đọc ra đúng một dòng slug `vowasia`.

## Không thuộc gap này

Quyết định C3, C8, C10, host ảnh / R2 (O6) là điều kiện riêng của cổng A -> B.
