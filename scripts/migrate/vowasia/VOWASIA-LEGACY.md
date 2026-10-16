# VowAsia: chuyển bài từ DB cũ, Giai đoạn A (đọc / discover)

TL;DR: Giai đoạn A chỉ ĐỌC DB cũ để lập báo cáo cấu trúc. Chủ dự án chạy mọi lệnh trên DB thật (O1-O6). Không lệnh nào ở đây ghi vào DB cũ hay Central, trừ các file SQL tạo/xoá role chỉ-đọc mà chủ tự chạy (`02` hoặc `02b`, và `03` khi dọn). Giai đoạn B (import) CHƯA có công cụ; chỉ mở sau khi có báo cáo discover và các quyết định C3, C8, C10, host ảnh.

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

- URL kết nối của role `vowasia_migrator` CHỈ nằm trong biến môi trường `LEGACY_VOWASIA_DB_URL`; URL quản trị DB cũ (role hiện có của chủ) CHỈ nằm trong biến `LEGACY_ADMIN_URL` của terminal đang dùng, không `export`. Chế độ SSL đặt bằng `LEGACY_VOWASIA_DB_SSL` (kèm `LEGACY_VOWASIA_DB_CA` nếu cần); URL KHÔNG được chứa `sslmode` hay tham số ssl nào (công cụ từ chối). Không bao giờ truyền URL qua cờ dòng lệnh của công cụ discover, không lưu vào file trong repo.
- Công cụ chỉ nhận đăng nhập bằng `vowasia_migrator`; role khác bị từ chối. Id site chỉ lấy từ overlay ngoài repo (không có cờ dòng lệnh cho id site), và slug site phải là `vowasia`.
- Công cụ in ra đúng `host:port/database` và chế độ SSL thực tế, không in user, mật khẩu, id site, nội dung bài.
- Hàng rào thật là quyền của role `vowasia_migrator`: chỉ SELECT trên hai view lọc theo id site VowAsia. Nói thật về giới hạn: role không đọc/ghi được bảng gốc, nhưng vẫn thừa hưởng quyền của PUBLIC (kết nối, tạo bảng tạm, gọi các hàm mà PUBLIC gọi được). `default_transaction_read_only` chỉ là MẶC ĐỊNH của phiên, role tự tắt được. Kiểm tra trong mã (chỉ SELECT, chỉ bảng đã cấu hình, luôn lọc site, `BEGIN READ ONLY`) là lớp thứ hai.
- KHÔNG dùng lại `gtp_migrator`. KHÔNG đổi role/policy/grant của site khác. KHÔNG chạy `REVOKE ... FROM PUBLIC` trên bảng/schema `public`.
- Nếu có bất cứ gì bất thường (tự kiểm báo STOP, site đọc ra không phải `vowasia`, tên database lạ): DỪNG và báo, không tự xử lý.

## O1: tenant và taxonomy vowasia đã có trên Central chưa (chỉ đọc)

Đây là dry run trên Central, không ghi gì. Cần biến `DATABASE_URL` của Central đã đặt trong terminal (như khi chạy các script audit khác); nếu chưa có, lệnh dưới báo lỗi `Invalid URL`: dừng. Lệnh đầu chỉ in host và tên database; tên phải là `/neondb`.

```bash
node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'
```

Nếu dòng in ra không kết thúc bằng `/neondb`: dừng. Nếu đúng, chạy:

```bash
npm run audit:add-vowasia-taxonomy
```

Ghi lại: tenant `vowasia` có hay không ("not found"), và 49 dòng là `exists` hay `create`. Không thêm `--apply` ở bước này.

## O2: đọc cấu trúc DB cũ (chỉ SELECT)

Bước này dùng URL kết nối DB CŨ bằng role hiện có của chủ (không phải Central). Dùng host kết nối TRỰC TIẾP của nhà cung cấp, KHÔNG dùng transaction pooler (ví dụ cổng `6543` của Supabase): file 02/02b/03 cần một phiên giữ nguyên suốt giao dịch. Nhập nó bằng `read -s` (xem "Cách dán lệnh"):

```bash
read -s LEGACY_ADMIN_URL
```

Không `export` biến này: `psql` nhận nó qua tham số `"$LEGACY_ADMIN_URL"` (giá trị không hiện trên màn hình), nên không tiến trình con nào khác (npm, node) thấy nó.

Kiểm tên database TRƯỚC khi chạy bất kỳ file nào (lệnh chỉ in một dòng: tên database; phải là DB CŨ, không phải `neondb`; ghi lại tên này, các file 02/03 cần nó):

```bash
psql "$LEGACY_ADMIN_URL" -X -At -c 'SELECT current_database()'
```

```bash
psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -f scripts/migrate/vowasia/sql/01-readonly-inspect.sql
```

Dòng đầu kết quả in tên database và role đang dùng: xác nhận đúng là DB CŨ của VowAsia (không phải `neondb` của Central). File đặt phiên ở chế độ chỉ-đọc nên mọi câu ghi (nếu lỡ có) đều bị từ chối. Xong thì `clear`.

Báo lại (không báo tên bảng nhạy cảm nào khác):

1. Tên bảng chứa bài viết và site của VowAsia (nếu khác `articles`, `sites`), và tên các cột (mục 6b: ngày tạo, ngày đăng, trạng thái, chuyên mục, slug, tiêu đề, thân bài, ảnh). Dùng chính danh sách mục 6b để điền `__ARTICLE_COLUMNS__` ở O3 (bỏ cột cá nhân).
2. Cờ RLS (`rls_enabled`, `rls_forced`) của hai bảng đó, policy hiện có, và quyền (acl) của hai bảng (mục 5).
3. Danh sách role đăng nhập được (mục 5), role NOLOGIN dùng được hai bảng (mục 5a, ví dụ `anon`/`authenticated`) và đồ thị thành viên (mục 5e): role nào đọc được hai bảng, có vượt RLS không. Đây là căn cứ chọn phương án ở O3.
4. Quyền PUBLIC (mục 5c) và các hàm SECURITY DEFINER PUBLIC gọi được (mục 5d): chỉ cần báo số lượng và schema.
5. Kiểu cột `site_id` (uuid / số nguyên / chữ) để chọn `siteIdKind`.
6. Id site của VowAsia: chỉ chia sẻ nếu thấy an toàn, qua kênh phù hợp. Không cần gửi cho agent: id này chỉ nằm trong overlay ngoài repo.

## O3: tạo role chỉ-đọc (phương án 2, khuyên dùng)

Chủ chốt phương án sau O2. Phương án 2 (schema `vowasia_ro` + view) không đổi bảng gốc nên không ảnh hưởng site cũ. Phương án 1 (`sql/02b-alternative-rls.sql.template`) bật RLS trên bảng DÙNG CHUNG và có thể làm HỎNG site cũ; file đó tự dừng (không đổi gì) nếu còn role đăng nhập nào khác dùng được hai bảng, nhưng vẫn chỉ cân nhắc khi O2 chứng minh mọi role của site cũ là chủ bảng hoặc có BYPASSRLS.

1. Tạo thư mục riêng ngoài repo:

   ```bash
   mkdir -m 700 -p ~/vowasia-private
   ```

2. Chép mẫu ra đó:

   ```bash
   cp scripts/migrate/vowasia/sql/02-create-readonly-role-views.sql.template ~/vowasia-private/02-filled.sql
   ```

3. Mở file để điền bằng trình soạn thảo trong terminal (KHÔNG dùng TextEdit: nó tự đổi dấu nháy `'` thành dấu nháy cong và làm hỏng SQL):

   ```bash
   nano ~/vowasia-private/02-filled.sql
   ```

   Điền bốn chỗ giữ chỗ (mỗi chỗ có thể xuất hiện nhiều lần; trong `nano` dùng Ctrl+\ để tìm và thay, gõ chuỗi tìm rồi Enter, gõ giá trị rồi Enter, rồi nhấn `A` để thay HẾT; lưu Ctrl+O, Enter, thoát Ctrl+X):
   - `__VOWASIA_SITE_ID__`: id site VowAsia;
   - `__VOWASIA_SITE_SLUG__`: slug của dòng site đó (phải là `vowasia`; nếu slug thật khác thì DỪNG và báo);
   - `__ARTICLE_COLUMNS__`: danh sách cột TƯỜNG MINH của bảng bài viết (lấy từ O2 mục 6b), có `"site_id"`, KHÔNG có cột cá nhân (email, IP, ghi chú nội bộ...);
   - `__LEGACY_DB_NAME__`: tên database CŨ đã in ở O2 (file tự dừng nếu đang nối vào database khác tên này hoặc vào `neondb`);
   - tên bảng gốc `public.articles` / `public.sites` nếu O2 cho thấy khác.

   File tự chặn nếu còn chỗ giữ chỗ chưa điền (không tạo gì). Trong file còn một tham số `allow_definer_outside_public` (mặc định `'no'`): GIỮ NGUYÊN, trừ khi chủ đã xem O2 mục 5d và chủ động chấp nhận các hàm SECURITY DEFINER ở schema khác `public`.

4. Chạy:

   ```bash
   psql "$LEGACY_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f ~/vowasia-private/02-filled.sql
   ```

   Cờ `-t -A` làm psql chỉ in giá trị (không khung bảng, không dòng `(1 row)`), nên dòng cuối in ra chính là dòng trạng thái. Dòng đầu in `tên_database|role`. Tên database được chốt TRONG SQL (so với `__LEGACY_DB_NAME__`, và từ chối `neondb`): nếu sai, file dừng với `DB NAME STOP` và không tạo gì. Phần TỰ KIỂM chạy BÊN TRONG giao dịch, trước khi lưu. Ba kết cục có thể có:
   - Dòng cuối là đúng `SELF-CHECK OK`: role, schema, hai view và quyền SELECT của role trên hai view đều thật sự tồn tại (kiểm lại sau khi lưu). Sang bước 5.
   - Dòng cuối là `SELF-CHECK FAILED: nothing created`: không có lỗi nhưng kết quả không đủ (thường do lệnh bị sửa, ví dụ thiếu `-v ON_ERROR_STOP=1`). KHÔNG đặt mật khẩu; chạy bước Dọn (03) cho chắc, rồi DỪNG và báo.
   - Có dòng `ERROR: SELF-CHECK STOP: ...`, `ERROR: DB NAME STOP: ...` hoặc lỗi khác (psql dừng ngay, không in dòng trạng thái): cả giao dịch đã tự huỷ, KHÔNG có role hay schema nào được tạo, không cần dọn. DỪNG (HS5) và báo lại nguyên văn dòng lỗi. KHÔNG đặt mật khẩu. Nếu lỗi là `canceling statement due to lock timeout`: bảng gốc đang bận (file chờ tối đa 3 giây), chạy lại lúc vắng. Nguyên nhân thường gặp: id site sai, slug không phải `vowasia`, tên database sai, PUBLIC có quyền tạo đối tượng hoặc đọc bảng, hoặc role gọi được hàm SECURITY DEFINER (ở `public`, hoặc ở schema khác khi `allow_definer_outside_public` còn `'no'`).
   - PostgreSQL 14 trở xuống: PUBLIC mặc định có quyền CREATE trên schema `public`, nên tự kiểm LUÔN dừng. Đó là hành vi đúng: dừng và báo, không tự `REVOKE`.

   Dòng `NOTICE` (in trên màn hình cùng lúc) cho biết số hàm SECURITY DEFINER ở schema khác mà role gọi được (lớn hơn 0 chỉ có thể xảy ra khi chủ đã chủ động đổi `allow_definer_outside_public` thành `'yes'`) và quyền CONNECT/TEMP thừa hưởng từ PUBLIC: chép lại khi báo.

5. CHỈ sau `SELF-CHECK OK` mới đặt mật khẩu. Sinh mật khẩu ngẫu nhiên vào clipboard (chỉ chữ số và a-f, không ký tự đặc biệt nên ghép vào URL không vỡ):

   ```bash
   openssl rand -hex 24 | pbcopy
   ```

   Rồi đặt nó cho role (lệnh hỏi hai lần; mỗi lần dán bằng Cmd+V rồi Enter):

   ```bash
   psql "$LEGACY_ADMIN_URL" -X -c '\password vowasia_migrator'
   ```

   Xong thì `clear`. Không lưu mật khẩu vào file trong repo.

Ghi chú:
- Role là cấp cụm (cluster-wide): nếu cụm có nhiều database, chạy O2 mục 5c/5d ở từng database mà role kết nối được (quyền CONNECT của PUBLIC) trước khi đặt mật khẩu.
- Role có hạn dùng 14 ngày (VALID UNTIL). Đổi mật khẩu KHÔNG gia hạn (lệnh `\password` không đổi hạn dùng). Nếu Giai đoạn B bị hoãn lâu hơn, chọn MỘT trong hai:
  - chạy bước Dọn rồi chạy lại O3 bước 4-5 với file đã điền (khi đó mật khẩu là mới, nên phải làm lại O4: soạn URL mới và nhập lại `LEGACY_VOWASIA_DB_URL`);
  - HOẶC gia hạn. Biến `LEGACY_ADMIN_URL` đã bị `unset` ở O4, nên nhập lại nó ngay trước:

    ```bash
    read -s LEGACY_ADMIN_URL
    ```

    Rồi chạy lệnh dưới, sau khi tự thay `YYYY-MM-DD` bằng một ngày cụ thể KHÔNG quá 14 ngày kể từ hôm chạy (không dùng ngày xa hơn: hạn ngắn là một lớp bảo vệ):

    ```bash
    psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -c "ALTER ROLE vowasia_migrator VALID UNTIL 'YYYY-MM-DD'"
    ```

    Xong thì `unset LEGACY_ADMIN_URL`.

- View khoá cột của bảng `articles`/`sites`: KHÔNG chạy migration đổi cột các bảng đó của site cũ trong khoảng giữa O3 (chạy 02) và bước Dọn (chạy 03); migration đó có thể lỗi vì view đang phụ thuộc cột.

## O3b: phương án 1 (02b), KHÔNG khuyên dùng

Chỉ làm bước này THAY cho O3 bước 1-4 khi chủ đã chọn phương án 1 sau O2 (xem cảnh báo ở O3 và đầu file `02b`). Chép mẫu ra thư mục riêng và điền giống O3 bước 1-3 (ba chỗ giữ chỗ `__VOWASIA_SITE_ID__`, `__ARTICLE_COLUMNS__`, `__LEGACY_DB_NAME__`):

```bash
cp scripts/migrate/vowasia/sql/02b-alternative-rls.sql.template ~/vowasia-private/02b-filled.sql
```

```bash
nano ~/vowasia-private/02b-filled.sql
```

Chạy:

```bash
psql "$LEGACY_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f ~/vowasia-private/02b-filled.sql
```

GHI LẠI NGAY hai dòng `NOTICE: vowasia: BEFORE: ... rls_enabled=... rls_forced=...` (chép ra giấy hoặc ghi chú tạm không đồng bộ): bước Dọn cần chúng để biết có tắt RLS hay không. Ba kết cục: dòng cuối đúng `RLS SETUP OK` (sang O3 bước 5, đặt mật khẩu); dòng cuối `RLS SETUP FAILED: nothing changed` (KHÔNG đặt mật khẩu; làm bước Dọn rồi DỪNG và báo); hoặc dòng `ERROR: ... STOP: ...` hay lỗi khác (cả giao dịch huỷ, bảng gốc không đổi; DỪNG và báo nguyên văn). File chờ khoá bảng tối đa 3 giây rồi báo lỗi `lock timeout` thay vì chặn site cũ lâu.

## O4: nhập URL kết nối của role mới

URL của role mới giống hệt URL kết nối DB cũ đã dùng ở O2, nhưng phải là host kết nối TRỰC TIẾP (không qua pooler: nếu tên đăng nhập trong URL có dạng `user.projectref` như pooler của Supabase, hãy dùng chuỗi kết nối trực tiếp của nhà cung cấp, nơi tên đăng nhập chỉ là tên role), và chỉ thay phần tên đăng nhập và mật khẩu (đoạn giữa hai dấu gạch chéo đầu và dấu `@`) bằng `vowasia_migrator`, dấu hai chấm, rồi mật khẩu vừa tạo ở O3 bước 5 (vẫn nằm trong clipboard). Không thêm `?sslmode=...` hay tham số ssl nào vào cuối URL. Soạn URL đó trong một ghi chú tạm KHÔNG đồng bộ (xoá ngay sau bước này), chép nó, rồi nhập bằng `read -s`:

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

Mở terminal mới ở thư mục gốc repo. Nhập lại URL quản trị DB cũ (biến cũ đã bị `unset` ở O4), không `export`; vẫn là host kết nối TRỰC TIẾP, không transaction pooler (cổng `6543`):

```bash
read -s LEGACY_ADMIN_URL
```

Nếu đã dùng phương án 1 (02b): gỡ policy BẰNG TAY TRƯỚC khi chạy 03 (một thứ tự duy nhất, giống đầu file `02b`; lý do: 03 không đổi RLS của bảng gốc, gỡ tay trước để trạng thái RLS về đúng như dòng `BEFORE` đã ghi). Nếu dòng `BEFORE` ghi `rls_enabled=f` cho cả hai bảng, chạy:

```bash
psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s'; DROP POLICY vowasia_migrator_articles ON public.articles; DROP POLICY vowasia_migrator_sites ON public.sites; ALTER TABLE public.articles DISABLE ROW LEVEL SECURITY; ALTER TABLE public.sites DISABLE ROW LEVEL SECURITY"
```

Nếu dòng `BEFORE` ghi `rls_enabled=t` (RLS đã bật từ trước), chỉ xoá policy:

```bash
psql "$LEGACY_ADMIN_URL" -X -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s'; DROP POLICY vowasia_migrator_articles ON public.articles; DROP POLICY vowasia_migrator_sites ON public.sites"
```

Mỗi lệnh `-c` trên chạy cả chuỗi trong MỘT giao dịch: lỗi ở bất kỳ câu nào (kể cả `lock timeout` khi bảng bận quá 3 giây) thì không câu nào có hiệu lực; chạy lại lúc vắng.

Kiểm tên database lần nữa (phải đúng tên DB CŨ đã ghi ở O2):

```bash
psql "$LEGACY_ADMIN_URL" -X -At -c 'SELECT current_database()'
```

Chạy Dọn. Thay `TEN_DB_CU` bằng đúng tên vừa in (file dừng với `DB NAME STOP`, không xoá gì, nếu tên không khớp hoặc là `neondb`):

```bash
psql "$LEGACY_ADMIN_URL" -X -q -t -A -v ON_ERROR_STOP=1 -v legacy_db=TEN_DB_CU -f scripts/migrate/vowasia/sql/03-drop-role-and-views.sql
```

Dòng đầu in `tên_database|role`. Mọi thao tác xoá nằm trong MỘT giao dịch: thiếu `-v legacy_db`, sai tên hay `neondb` thì không xoá gì, kể cả khi lỡ quên `-v ON_ERROR_STOP=1`. File xoá schema `vowasia_ro`, mọi quyền của `vowasia_migrator`, rồi role; dòng cuối phải là đúng `CLEANUP OK`. Chạy lại vẫn an toàn. Nếu role có quyền ở database khác trong cùng cụm, chạy `DROP OWNED BY vowasia_migrator` ở database đó trước. Nếu đã dùng phương án 1: dòng `NOTICE ... AFTER` của 03 phải ghi `vowasia_policies_left=0` và `rls_enabled` giống dòng `BEFORE` đã ghi; khác thì DỪNG và báo.

Xoá các file riêng tư (chứa id site, cấu hình) CHỈ khi KHÔNG định chạy lại O3 (nếu định chạy lại, giữ chúng; sau khi tạo lại role phải làm lại O4 vì mật khẩu và URL là mới):

```bash
rm -f ~/vowasia-private/02-filled.sql ~/vowasia-private/02b-filled.sql ~/vowasia-private/overlay.json
```

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
