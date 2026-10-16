# VowAsia: chuyển bài từ DB cũ, Giai đoạn A (đọc / discover)

TL;DR: Giai đoạn A chỉ ĐỌC DB cũ để lập báo cáo cấu trúc. Chủ dự án chạy mọi lệnh trên DB thật (O1-O6). Không lệnh nào ở đây ghi vào DB cũ hay Central, trừ hai file SQL tạo/xoá role chỉ-đọc mà chủ tự chạy. Giai đoạn B (import) CHƯA có công cụ; chỉ mở sau khi có báo cáo discover và các quyết định C3, C8, C10, host ảnh.

## Ai làm gì

| Bước | Người chạy | Ghi vào đâu |
|---|---|---|
| O1 kiểm tenant/taxonomy vowasia (dry run) | chủ | không ghi gì |
| O2 `sql/01-readonly-inspect.sql` | chủ, role hiện có | không ghi gì (chỉ SELECT) |
| O3 `sql/02-create-readonly-role-views.sql.template` | chủ | DB cũ: tạo role `vowasia_migrator` + schema `vowasia_ro` (hai view). DDL DUY NHẤT trên DB cũ |
| O4 nhập URL kết nối bằng `read -s` | chủ | chỉ biến môi trường của terminal |
| O5 `npm run migrate:vowasia:discover` | chủ | `scripts/migrate/out/vowasia/` (git-ignored, 700/600) |
| O6 chốt C3, C8, C10, host ảnh | chủ | quyết định, gửi lại cho plan Giai đoạn B |
| Dọn: `sql/03-drop-role-and-views.sql` | chủ, khi xong (hoặc khi tự kiểm báo STOP) | DB cũ: xoá schema + role |

Agent không giữ, không xin, không nhìn bí mật. Không dán mật khẩu hay URL kết nối vào chat. Chạy `clear` trước khi chụp màn hình.

## Quy tắc an toàn

- URL kết nối DB cũ CHỈ nằm trong biến môi trường `LEGACY_VOWASIA_DB_URL` (kèm `LEGACY_VOWASIA_DB_SSL`, `LEGACY_VOWASIA_DB_CA` nếu cần). Không bao giờ truyền qua tham số dòng lệnh, không lưu vào file trong repo.
- Công cụ in ra đúng `host:port/database`, không in user, mật khẩu, id site, nội dung bài.
- Hàng rào thật là quyền của role `vowasia_migrator` (chỉ SELECT trên hai view lọc theo id site VowAsia). Kiểm tra trong mã (chỉ SELECT, chỉ bảng đã cấu hình, luôn lọc site, `BEGIN READ ONLY`) là lớp thứ hai.
- KHÔNG dùng lại `gtp_migrator`. KHÔNG đổi role/policy/grant của site khác. KHÔNG chạy `REVOKE ... FROM PUBLIC` trên bảng/schema `public`.
- Nếu có bất cứ gì bất thường (tự kiểm báo STOP, site đọc ra không phải `vowasia`, tên database lạ): DỪNG và báo, không tự xử lý.

## O1: tenant và taxonomy vowasia đã có trên Central chưa (chỉ đọc)

Đây là dry run, không ghi gì. Lệnh in tên database TRƯỚC; phải là `/neondb`.

```bash
node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'   # phải in /neondb
npm run audit:add-vowasia-taxonomy
```

Ghi lại: tenant `vowasia` có hay không ("not found"), và 49 dòng là `exists` hay `create`. Không thêm `--apply` ở bước này.

## O2: đọc cấu trúc DB cũ (chỉ SELECT)

```bash
read -s LEGACY_ADMIN_URL; export LEGACY_ADMIN_URL      # URL kết nối bằng role hiện có của chủ; gõ/dán khi con trỏ đứng yên
psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/01-readonly-inspect.sql
clear
```

Báo lại (không báo tên bảng nhạy cảm nào khác):

1. Tên bảng chứa bài viết và site của VowAsia (nếu khác `articles`, `sites`), và tên các cột (ngày tạo, ngày đăng, trạng thái, chuyên mục, slug, tiêu đề, thân bài, ảnh).
2. Cờ RLS (`rls_enabled`, `rls_forced`) của hai bảng đó, và policy hiện có.
3. Role hiện tại có `rolbypassrls` không; các role đang kết nối (mục 5) có vượt RLS không.
4. Kiểu cột `site_id` (uuid / số nguyên / chữ) để chọn `siteIdKind`.
5. Id site của VowAsia: chỉ chia sẻ nếu thấy an toàn, qua kênh phù hợp. Không cần gửi cho agent: id này chỉ nằm trong overlay ngoài repo.

## O3: tạo role chỉ-đọc (phương án 2, khuyên dùng)

Chủ chốt phương án sau O2. Phương án 2 (schema `vowasia_ro` + view) không đổi bảng gốc nên không ảnh hưởng site cũ. Phương án 1 (`sql/02b-alternative-rls.sql.template`) bật RLS trên bảng DÙNG CHUNG và có thể làm HỎNG site cũ ngay; chỉ cân nhắc khi O2 chứng minh mọi role của site cũ là chủ bảng hoặc có BYPASSRLS.

1. Chép `sql/02-create-readonly-role-views.sql.template` ra NGOÀI repo. Điền:
   - `__VOWASIA_SITE_ID__`: id site VowAsia (xuất hiện ở hai chỗ, thay hết);
   - `__ARTICLE_COLUMNS__`: danh sách cột TƯỜNG MINH của bảng bài viết, có `"site_id"`, KHÔNG có cột cá nhân (email, IP, ghi chú nội bộ...);
   - tên bảng gốc `public.articles` / `public.sites` nếu O2 cho thấy khác.
   File tự chặn nếu còn chỗ giữ chỗ chưa điền (không tạo gì).
2. Chạy: `psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f <bản đã điền>`.
3. Đọc dòng cuối (TỰ KIỂM). Phải là đúng `SELF-CHECK OK`.
   - Nếu là `SELF-CHECK STOP: ...` (ví dụ: role có quyền trên bảng/schema `public`, thường do PUBLIC có quyền, PG 14 trở xuống PUBLIC có CREATE trên schema `public`; hoặc view `sites` không đúng 1 dòng slug `vowasia`): DỪNG (HS5). Không dùng role. Chạy `sql/03-drop-role-and-views.sql` để dọn và báo lại.
4. Đặt mật khẩu (không ghi vào file nào):
   ```bash
   openssl rand -base64 24 | pbcopy
   psql "$LEGACY_ADMIN_URL" -X -c '\password vowasia_migrator'    # dán khi được hỏi (hai lần)
   clear
   ```

Ghi chú: role là cấp cụm (cluster-wide); role kế thừa quyền của PUBLIC; danh sách cột của view bị khoá lúc tạo.

## O4: nhập URL kết nối của role mới

```bash
read -s LEGACY_VOWASIA_DB_URL; export LEGACY_VOWASIA_DB_URL     # URL kết nối của vowasia_migrator
export LEGACY_VOWASIA_DB_SSL=require                             # hoặc verify-full (+ LEGACY_VOWASIA_DB_CA)
unset LEGACY_ADMIN_URL
```

Không `echo` biến này, không lưu vào file `.env` trong repo. Dán bằng `read -s` nên không vào lịch sử shell.

## O5: chạy discover

1. Tạo overlay NGOÀI repo (ví dụ `~/vowasia-private/overlay.json`), theo mẫu `fixtures/overlay.fixture.json`:
   - `source.schema`: `vowasia_ro` (đọc qua view của role);
   - `source.siteIdKind`: `uuid`, `integer` hoặc `text-safe` (theo O2);
   - `source.siteFilter`: id site VowAsia;
   - `source.tables.*`, `source.columnRoles.*`: chỉ phần khác giả thuyết `legacy-source.vowasia.json`.
   Tên bảng/cột phải là chữ thường snake_case. Nếu DB cũ dùng chữ hoa/camelCase, công cụ dừng với `legacy: identifier not supported by closed builder; amendment required.` và cần amendment (không tự nới).
2. Chạy (dry run, chỉ đọc):
   ```bash
   npm run migrate:vowasia:discover -- --mapping-overlay ~/vowasia-private/overlay.json
   ```
   Mã thoát: 0 xong; 2 từ chối có chủ đích (thông báo cố định, ví dụ thiếu site filter, site không phải `vowasia`, giả thuyết lệch); 1 lỗi khác.
3. Kết quả trong `scripts/migrate/out/vowasia/` (git-ignored):
   - `legacy-schema-report.md`: cấu trúc, lệch so với giả thuyết, số dòng, phân bố trạng thái/chuyên mục/năm, slug, hình dạng thân bài, host ảnh, ngày thiếu;
   - `legacy-mapping.template.json`: khung mapping cho Giai đoạn B (cố ý có `TODO`);
   - `query-log.json`: mọi câu SQL đã chạy (không có tham số, nên không có id site).
   Nếu báo cáo ghi `MISMATCH (blocking)`: sửa overlay rồi chạy lại.
4. Tự đọc lại `legacy-schema-report.md` (xoá tên bảng nhạy cảm nếu lỡ có) rồi mới chia sẻ.

## O6: quyết định cần chốt sau discover

- C3: origin và mẫu URL cũ; mục bị bỏ trả 410 hay 301.
- C8: ánh xạ chuyên mục cũ sang 8 pillar / 27 sub-section (bài không khớp bị từ chối có báo cáo, không gán đại).
- C10: mốc cutover, web mới đã sẵn chưa.
- Host ảnh cũ được phép tải và bucket R2 (ghi trong overlay ngoài repo, mục `media`).

## Dọn sau khi xong

```bash
psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/03-drop-role-and-views.sql
```

Xoá schema `vowasia_ro`, mọi quyền của `vowasia_migrator`, rồi role. Chạy lại vẫn an toàn. Nếu role có quyền ở database khác trong cùng cụm, chạy `DROP OWNED BY vowasia_migrator` ở database đó trước. Nếu đã dùng phương án 1, gỡ policy và (nếu trước đó RLS tắt) tắt lại RLS theo hướng dẫn đầu file `02b`.

## Kiểm thử cục bộ (agent, không cần DB thật)

```bash
npm run test:migrate-vowasia     # unit test, không DB, không mạng
npm run probe:migrate-vowasia    # PG16 tạm cục bộ (cổng 54336), tự dọn; chạy một mình
```

Probe dựng Postgres tạm, kiểm keyset (trùng mili-giây khác micro-giây, `created_at` trùng, NULL, 1970), áp `02`/`03` lên dữ liệu giả, kiểm role chỉ đọc đúng site và không ghi được, chạy discover qua role và kiểm đầu ra không lộ id site, mật khẩu, thân bài. Nó không chứng minh hành vi trên DB cũ THẬT (đó là O2-O5).
