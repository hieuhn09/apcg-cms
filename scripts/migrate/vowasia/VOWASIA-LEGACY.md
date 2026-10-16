# VowAsia: chuyển bài từ DB cũ, Giai đoạn A (đọc / discover)

TL;DR: Giai đoạn A chỉ ĐỌC DB cũ để lập báo cáo cấu trúc. Chủ dự án chạy mọi lệnh trên DB thật (O1-O6). Không lệnh nào ở đây ghi vào DB cũ hay Central, trừ hai file SQL tạo/xoá role chỉ-đọc mà chủ tự chạy. Giai đoạn B (import) CHƯA có công cụ; chỉ mở sau khi có báo cáo discover và các quyết định C3, C8, C10, host ảnh.

## Cách dán lệnh (đọc trước, áp cho MỌI bước)

- Mỗi khung xám dưới đây là ĐÚNG MỘT lệnh. Dán một khung, nhấn Enter, chờ dấu nhắc `%` hiện lại rồi mới dán khung kế.
- Các khung không có chú thích bên trong; mọi giải thích nằm ở chữ thường bên ngoài khung. Đừng thêm gì vào cuối lệnh.
- Lệnh `read -s TÊN_BIẾN` dùng để nhập bí mật: dán lệnh này, nhấn Enter, đợi con trỏ đứng yên (không hiện gì), rồi dán giá trị bí mật và nhấn Enter; chờ dấu nhắc `%` hiện lại rồi mới dán lệnh kế. Giá trị không hiện trên màn hình và không vào lịch sử shell.
- Không bao giờ dán mật khẩu hay URL kết nối vào chat, không chụp màn hình có chúng. Trước khi chụp màn hình bất kỳ bước nào: gõ `clear` rồi Enter.
- Các lệnh chạy từ thư mục gốc của repo `apcg-cms`.

## Ai làm gì

| Bước | Người chạy | Ghi vào đâu |
|---|---|---|
| O1 kiểm tenant/taxonomy vowasia (dry run) | chủ | không ghi gì |
| O2 `sql/01-readonly-inspect.sql` | chủ, role hiện có | không ghi gì (chỉ SELECT, phiên chỉ-đọc) |
| O3 `sql/02-create-readonly-role-views.sql.template` | chủ | DB cũ: tạo role `vowasia_migrator` + schema `vowasia_ro` (hai view). DDL DUY NHẤT trên DB cũ |
| O4 nhập URL kết nối bằng `read -s` | chủ | chỉ biến môi trường của terminal |
| O5 `npm run migrate:vowasia:discover` | chủ | `scripts/migrate/out/vowasia/` (git-ignored, 700/600) |
| O6 chốt C3, C8, C10, host ảnh | chủ | quyết định, gửi lại cho plan Giai đoạn B |
| Dọn: `sql/03-drop-role-and-views.sql` | chủ, khi xong | DB cũ: xoá schema + role |

Agent không giữ, không xin, không nhìn bí mật.

## Quy tắc an toàn

- URL kết nối DB cũ CHỈ nằm trong biến môi trường `LEGACY_VOWASIA_DB_URL`. Chế độ SSL đặt bằng `LEGACY_VOWASIA_DB_SSL` (kèm `LEGACY_VOWASIA_DB_CA` nếu cần); URL KHÔNG được chứa `sslmode` hay tham số ssl nào (công cụ từ chối). Không bao giờ truyền URL qua tham số dòng lệnh, không lưu vào file trong repo.
- Công cụ chỉ nhận đăng nhập bằng `vowasia_migrator`; role khác bị từ chối. Id site chỉ lấy từ overlay ngoài repo (không có cờ dòng lệnh cho id site), và slug site phải là `vowasia`.
- Công cụ in ra đúng `host:port/database` và chế độ SSL thực tế, không in user, mật khẩu, id site, nội dung bài.
- Hàng rào thật là quyền của role `vowasia_migrator`: chỉ SELECT trên hai view lọc theo id site VowAsia. Nói thật về giới hạn: role không đọc/ghi được bảng gốc, nhưng vẫn thừa hưởng quyền của PUBLIC (kết nối, tạo bảng tạm, gọi các hàm mà PUBLIC gọi được). `default_transaction_read_only` chỉ là MẶC ĐỊNH của phiên, role tự tắt được. Kiểm tra trong mã (chỉ SELECT, chỉ bảng đã cấu hình, luôn lọc site, `BEGIN READ ONLY`) là lớp thứ hai.
- KHÔNG dùng lại `gtp_migrator`. KHÔNG đổi role/policy/grant của site khác. KHÔNG chạy `REVOKE ... FROM PUBLIC` trên bảng/schema `public`.
- Nếu có bất cứ gì bất thường (tự kiểm báo STOP, site đọc ra không phải `vowasia`, tên database lạ): DỪNG và báo, không tự xử lý.

## O1: tenant và taxonomy vowasia đã có trên Central chưa (chỉ đọc)

Đây là dry run trên Central, không ghi gì. Lệnh đầu chỉ in host và tên database; tên phải là `/neondb`.

```bash
node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'
```

Nếu dòng in ra không kết thúc bằng `/neondb`: dừng. Nếu đúng, chạy:

```bash
npm run audit:add-vowasia-taxonomy
```

Ghi lại: tenant `vowasia` có hay không ("not found"), và 49 dòng là `exists` hay `create`. Không thêm `--apply` ở bước này.

## O2: đọc cấu trúc DB cũ (chỉ SELECT)

Bước này dùng URL kết nối DB CŨ bằng role hiện có của chủ (không phải Central). Nhập nó bằng `read -s` (xem "Cách dán lệnh"):

```bash
read -s LEGACY_ADMIN_URL
```

```bash
export LEGACY_ADMIN_URL
```

```bash
psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/01-readonly-inspect.sql
```

Dòng đầu kết quả in tên database và role đang dùng: xác nhận đúng là DB CŨ của VowAsia (không phải `neondb` của Central). File đặt phiên ở chế độ chỉ-đọc nên mọi câu ghi (nếu lỡ có) đều bị từ chối. Xong thì `clear`.

Báo lại (không báo tên bảng nhạy cảm nào khác):

1. Tên bảng chứa bài viết và site của VowAsia (nếu khác `articles`, `sites`), và tên các cột (ngày tạo, ngày đăng, trạng thái, chuyên mục, slug, tiêu đề, thân bài, ảnh).
2. Cờ RLS (`rls_enabled`, `rls_forced`) của hai bảng đó, policy hiện có, và quyền (acl) của hai bảng (mục 5).
3. Danh sách role đăng nhập được (mục 5): role nào đọc được hai bảng, có vượt RLS không. Đây là căn cứ chọn phương án ở O3.
4. Quyền PUBLIC (mục 5c) và các hàm SECURITY DEFINER PUBLIC gọi được (mục 5d): chỉ cần báo số lượng và schema.
5. Kiểu cột `site_id` (uuid / số nguyên / chữ) để chọn `siteIdKind`.
6. Id site của VowAsia: chỉ chia sẻ nếu thấy an toàn, qua kênh phù hợp. Không cần gửi cho agent: id này chỉ nằm trong overlay ngoài repo.

## O3: tạo role chỉ-đọc (phương án 2, khuyên dùng)

Chủ chốt phương án sau O2. Phương án 2 (schema `vowasia_ro` + view) không đổi bảng gốc nên không ảnh hưởng site cũ. Phương án 1 (`sql/02b-alternative-rls.sql.template`) bật RLS trên bảng DÙNG CHUNG và có thể làm HỎNG site cũ; file đó tự dừng (không đổi gì) nếu còn role đăng nhập nào khác dùng được hai bảng, nhưng vẫn chỉ cân nhắc khi O2 chứng minh mọi role của site cũ là chủ bảng hoặc có BYPASSRLS.

1. Tạo thư mục riêng ngoài repo:

   ```bash
   mkdir -p ~/vowasia-private
   ```

2. Chép mẫu ra đó:

   ```bash
   cp scripts/migrate/vowasia/sql/02-create-readonly-role-views.sql.template ~/vowasia-private/02-filled.sql
   ```

3. Mở file để điền:

   ```bash
   open -e ~/vowasia-private/02-filled.sql
   ```

   Điền ba chỗ giữ chỗ (mỗi chỗ có thể xuất hiện nhiều lần; dùng Tìm và Thay để thay HẾT):
   - `__VOWASIA_SITE_ID__`: id site VowAsia;
   - `__VOWASIA_SITE_SLUG__`: slug của dòng site đó (phải là `vowasia`; nếu slug thật khác thì DỪNG và báo);
   - `__ARTICLE_COLUMNS__`: danh sách cột TƯỜNG MINH của bảng bài viết, có `"site_id"`, KHÔNG có cột cá nhân (email, IP, ghi chú nội bộ...);
   - tên bảng gốc `public.articles` / `public.sites` nếu O2 cho thấy khác.

   Lưu file. File tự chặn nếu còn chỗ giữ chỗ chưa điền (không tạo gì).

4. Chạy:

   ```bash
   psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f ~/vowasia-private/02-filled.sql
   ```

   Dòng đầu in tên database và role: phải là DB CŨ. Phần TỰ KIỂM chạy BÊN TRONG giao dịch, trước khi lưu. Hai kết quả có thể có:
   - Dòng cuối là đúng `SELF-CHECK OK`: role và view đã tạo. Sang bước 5.
   - Có dòng `ERROR: SELF-CHECK STOP: ...`: cả giao dịch đã tự huỷ, KHÔNG có role hay schema nào được tạo, không cần dọn. DỪNG (HS5) và báo lại nguyên văn dòng STOP. Nguyên nhân thường gặp: id site sai, slug không phải `vowasia`, PUBLIC có quyền tạo đối tượng hoặc đọc bảng, hoặc có hàm SECURITY DEFINER trong schema `public` mà PUBLIC gọi được.

   Dòng `NOTICE` cho biết số hàm SECURITY DEFINER ở schema khác mà role gọi được và quyền CONNECT/TEMP thừa hưởng từ PUBLIC: chép lại khi báo.

5. CHỈ sau `SELF-CHECK OK` mới đặt mật khẩu. Sinh mật khẩu ngẫu nhiên vào clipboard (chỉ chữ số và a-f, không ký tự đặc biệt nên ghép vào URL không vỡ):

   ```bash
   openssl rand -hex 24 | pbcopy
   ```

   Rồi đặt nó cho role (lệnh hỏi hai lần; mỗi lần dán bằng Cmd+V rồi Enter):

   ```bash
   psql "$LEGACY_ADMIN_URL" -X -c '\password vowasia_migrator'
   ```

   Xong thì `clear`. Không lưu mật khẩu vào file trong repo.

Ghi chú: role là cấp cụm (cluster-wide); role có hạn dùng 14 ngày (VALID UNTIL). Nếu Giai đoạn B bị hoãn lâu hơn: chạy bước Dọn để xoá role (tạo lại khi cần), hoặc đổi mật khẩu bằng lệnh ở bước 5 trước khi dùng lại. Danh sách cột của view bị khoá lúc tạo.

## O4: nhập URL kết nối của role mới

URL của role mới giống hệt URL kết nối DB cũ đã dùng ở O2, chỉ thay phần tên đăng nhập và mật khẩu (đoạn giữa hai dấu gạch chéo đầu và dấu `@`) bằng `vowasia_migrator`, dấu hai chấm, rồi mật khẩu vừa tạo ở O3 bước 5 (vẫn nằm trong clipboard). Không thêm `?sslmode=...` hay tham số ssl nào vào cuối URL. Soạn URL đó trong một ghi chú tạm KHÔNG đồng bộ (xoá ngay sau bước này), chép nó, rồi nhập bằng `read -s`:

```bash
read -s LEGACY_VOWASIA_DB_URL
```

```bash
export LEGACY_VOWASIA_DB_URL
```

Chế độ SSL (dùng `verify-full` nếu nhà cung cấp cho file CA, khi đó đặt thêm `LEGACY_VOWASIA_DB_CA`; nếu không thì `require`):

```bash
export LEGACY_VOWASIA_DB_SSL=require
```

Bỏ URL quản trị khỏi terminal này (nó chỉ cần lại ở bước Dọn, khi đó nhập lại):

```bash
unset LEGACY_ADMIN_URL
```

Không `echo` các biến này, không lưu vào file `.env` trong repo.

## O5: chạy discover

1. Tạo overlay `~/vowasia-private/overlay.json` (NGOÀI repo), theo mẫu `fixtures/overlay.fixture.json`:
   - `source.schema`: `vowasia_ro` (đọc qua view của role);
   - `source.siteIdKind`: `uuid`, `integer` hoặc `text-safe` (theo O2);
   - `source.siteFilter`: id site VowAsia (chỉ ở đây; không có cờ dòng lệnh cho nó);
   - `source.tables.*`, `source.columnRoles.*`: chỉ phần khác giả thuyết `legacy-source.vowasia.json`.
   Không đặt `expectedSiteSlug` khác `vowasia` (công cụ từ chối). Tên bảng/cột phải là chữ thường snake_case. Nếu DB cũ dùng chữ hoa/camelCase, công cụ dừng với `legacy: identifier not supported by closed builder; amendment required.` và cần amendment (không tự nới).
2. Chạy (dry run, chỉ đọc):

   ```bash
   npm run migrate:vowasia:discover -- --mapping-overlay ~/vowasia-private/overlay.json
   ```

   Dòng đầu in `host:port/database` và chế độ SSL thực tế: xác nhận đúng DB cũ. Mã thoát: 0 xong; 2 từ chối có chủ đích (thông báo cố định, ví dụ thiếu site filter, site không phải `vowasia`, đăng nhập không phải `vowasia_migrator`, URL có tham số ssl, giả thuyết lệch); 1 lỗi khác.
3. Kết quả trong `scripts/migrate/out/vowasia/` (git-ignored):
   - `legacy-schema-report.md`: cấu trúc, lệch so với giả thuyết, số dòng, phân bố trạng thái/chuyên mục/năm, slug, hình dạng thân bài, host ảnh, ngày thiếu;
   - `legacy-mapping.template.json`: khung mapping cho Giai đoạn B (cố ý có `TODO`);
   - `query-log.json`: mọi câu SQL đã chạy (không có tham số, nên không có id site).
   Nếu báo cáo ghi `MISMATCH (blocking)`: sửa overlay rồi chạy lại.
4. Tự đọc lại `legacy-schema-report.md` (xoá tên bảng nhạy cảm nếu lỡ có) rồi mới chia sẻ.
5. Khi không cần chạy discover nữa, bỏ URL khỏi terminal:

   ```bash
   unset LEGACY_VOWASIA_DB_URL
   ```

   rồi đóng cửa sổ terminal đó.

## O6: quyết định cần chốt sau discover

- C3: origin và mẫu URL cũ; mục bị bỏ trả 410 hay 301.
- C8: ánh xạ chuyên mục cũ sang 8 pillar / 27 sub-section (bài không khớp bị từ chối có báo cáo, không gán đại).
- C10: mốc cutover, web mới đã sẵn chưa.
- Host ảnh cũ được phép tải và bucket R2 (ghi trong overlay ngoài repo, mục `media`).

## Dọn sau khi xong

Mở terminal mới ở thư mục gốc repo. Nhập lại URL quản trị DB cũ (biến cũ đã bị `unset` ở O4):

```bash
read -s LEGACY_ADMIN_URL
```

```bash
export LEGACY_ADMIN_URL
```

```bash
psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/03-drop-role-and-views.sql
```

Dòng đầu in tên database và role (phải là DB CŨ). File xoá schema `vowasia_ro`, mọi quyền của `vowasia_migrator`, rồi role; dòng cuối phải là đúng `CLEANUP OK`. Chạy lại vẫn an toàn. Nếu role có quyền ở database khác trong cùng cụm, chạy `DROP OWNED BY vowasia_migrator` ở database đó trước. Nếu đã dùng phương án 1: file 03 KHÔNG tắt RLS; gỡ policy và (chỉ khi trước đó RLS tắt, theo dòng `BEFORE` đã ghi lại) tắt RLS BẰNG TAY theo hướng dẫn đầu file `02b`; dòng `NOTICE ... AFTER` của 03 cho biết trạng thái để đối chiếu.

Cuối cùng bỏ URL khỏi terminal và đóng cửa sổ:

```bash
unset LEGACY_ADMIN_URL
```

## Kiểm thử cục bộ (agent, không cần DB thật)

```bash
npm run test:migrate-vowasia
```

```bash
npm run probe:migrate-vowasia
```

Lệnh đầu là unit test (không DB, không mạng). Lệnh thứ hai dựng PG16 tạm cục bộ (cổng 54336, xác thực trust chỉ trên 127.0.0.1), tự dọn; chạy một mình. Probe kiểm keyset (trùng mili-giây khác micro-giây, `created_at` trùng, NULL, 1970), chạy `01` bằng role không có quyền ghi, áp `02` (kể cả trường hợp tự kiểm STOP thì không tạo gì) và `03`, cả bằng chủ bảng KHÔNG phải superuser có CREATEROLE, kiểm hàng rào của `02b`, kiểm role chỉ đọc đúng site và không ghi được, chạy discover qua role và kiểm đầu ra không lộ id site, mật khẩu, thân bài. Nó không chứng minh hành vi trên DB cũ THẬT (đó là O2-O5).
