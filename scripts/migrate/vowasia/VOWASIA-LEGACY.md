# VowAsia: chuyển bài từ DB cũ, Giai đoạn A (đọc / discover)

TL;DR: Giai đoạn A chỉ ĐỌC DB cũ để lập báo cáo cấu trúc. Chủ dự án chạy mọi lệnh trên DB thật (O1-O6). Không lệnh nào ở đây ghi vào DB cũ hay Central, trừ các file SQL tạo/xoá role chỉ-đọc mà chủ tự chạy (`02` hoặc `02b`, và `03` khi dọn). Giai đoạn B (import) CHƯA có công cụ; chỉ mở sau khi có báo cáo discover và các quyết định C3, C8, C10, host ảnh. Có HAI cách chạy phần SQL trên DB cũ: cách A (psql, cần URL/mật khẩu quản trị DB cũ, bước O2-O3 và Dọn) và cách B (SQL Editor của Supabase, KHÔNG cần mật khẩu `postgres`, bước B1-B6). Không có mật khẩu `postgres` thì dùng cách B; discover (O5) giống nhau ở cả hai cách.

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
| B2 (cách B) `sql/01e-inspect-single-result.sql` trong SQL Editor | chủ | không ghi gì (một câu SELECT) |
| B3 (cách B) `sql/02-create-readonly-role-views.sql.template` trong SQL Editor | chủ | DB cũ: như O3 |
| B4 (cách B) `sql/02p-set-password.sql.template` trong SQL Editor | chủ | DB cũ: mật khẩu của `vowasia_migrator` |
| B5 (cách B) nhập URL session pooler bằng `read -s`, rồi O5 | chủ | biến môi trường; `scripts/migrate/out/vowasia/` |
| B6 (cách B) `sql/03e-drop-in-editor.sql.template` trong SQL Editor | chủ, khi xong | DB cũ: xoá schema + role |

Agent không giữ, không xin, không nhìn bí mật.

## Quy tắc an toàn

- URL kết nối của role `vowasia_migrator` CHỈ nằm trong biến môi trường `LEGACY_VOWASIA_DB_URL`; URL quản trị DB cũ (role hiện có của chủ) CHỈ nằm trong biến `LEGACY_ADMIN_URL` của terminal đang dùng, không `export`. Chế độ SSL đặt bằng `LEGACY_VOWASIA_DB_SSL` (kèm `LEGACY_VOWASIA_DB_CA` nếu cần); URL KHÔNG được chứa `sslmode` hay tham số ssl nào (công cụ từ chối). Không bao giờ truyền URL qua cờ dòng lệnh của công cụ discover, không lưu vào file trong repo.
- Công cụ chỉ nhận đăng nhập bằng `vowasia_migrator` (hoặc dạng session pooler của Supabase `vowasia_migrator.MÃ_PROJECT`, mã project đúng 20 ký tự chữ thường và số, xem cách B); role khác bị từ chối. Mã project không được in ra: dòng đầu chỉ in host (host pooler không chứa mã; host trực tiếp `db.MÃ_PROJECT.supabase.co` được in thành `db.<ref>.supabase.co`), và mọi thông báo lỗi đều che tên đăng nhập `vowasia_migrator.MÃ_PROJECT` thành `vowasia_migrator.<ref>`. Id site chỉ lấy từ overlay ngoài repo (không có cờ dòng lệnh cho id site), và slug site phải là `vowasia`.
- Công cụ in ra đúng `host:port/database` và chế độ SSL thực tế, không in user, mật khẩu, id site, nội dung bài.
- Hàng rào thật là quyền của role `vowasia_migrator`: chỉ SELECT trên hai view lọc theo id site VowAsia. Nói thật về giới hạn: role không đọc/ghi được bảng gốc, nhưng vẫn thừa hưởng quyền của PUBLIC (kết nối, tạo bảng tạm, gọi các hàm mà PUBLIC gọi được). `default_transaction_read_only` chỉ là MẶC ĐỊNH của phiên, role tự tắt được. Kiểm tra trong mã (chỉ SELECT, chỉ bảng đã cấu hình, luôn lọc site, `BEGIN READ ONLY`) là lớp thứ hai. Hàm SECURITY DEFINER trả trigger/event_trigger KHÔNG bị chặn: về lý thuyết role (có quyền TEMP thừa hưởng từ PUBLIC) có thể kích hoạt chúng qua bảng tạm nếu tự tắt `default_transaction_read_only`; công cụ discover không làm được việc đó (`BEGIN READ ONLY`, chỉ SELECT), và các file ở đây không gây hại gì từ đó.
- KHÔNG dùng lại `gtp_migrator`. KHÔNG đổi role/policy/grant của site khác. KHÔNG chạy `REVOKE ... FROM PUBLIC` trên bảng/schema `public`.
- Nếu có bất cứ gì bất thường (tự kiểm báo STOP, site đọc ra không phải `vowasia`, tên database lạ): DỪNG và báo, không tự xử lý.

## O1: tenant và taxonomy vowasia đã có trên Central chưa (chỉ đọc)

Đây là dry run trên Central, không ghi gì. Cần biến `DATABASE_URL` của Central đã đặt trong terminal (như khi chạy các script audit khác); nếu chưa có, lệnh dưới báo lỗi `Invalid URL`: dừng. Lệnh đầu chỉ in host và tên database; tên phải là `/neondb`.

```bash
node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'
```

Nếu dòng in ra không kết thúc bằng `/neondb`: dừng. Nếu đúng, chạy lệnh dưới, thay `TÊN_HOST` bằng ĐÚNG chữ đầu tiên của dòng vừa in (tên host, không có cổng). Central không phải DB cục bộ nên script từ chối nếu thiếu `--confirm-host` (kể cả dry run):

```bash
npm run audit:add-vowasia-taxonomy -- --confirm-host=TÊN_HOST
```

Ghi lại: tenant `vowasia` có hay không ("not found"), và 49 dòng là `exists` hay `create`. Không thêm `--apply` ở bước này (không có `--apply` thì `--confirm-host` chỉ cho phép đọc, không ghi gì).

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
6. Id site của VowAsia: không cần gửi cho ai; chỉ dùng khi điền file 02 và trong overlay ngoài repo.

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

- 02 cho qua ĐÚNG hai bảng `pg_net` của Supabase (`net._http_response`, `net.http_request_queue`) mà PUBLIC có quyền mặc định; mọi bảng khác PUBLIC với tới vẫn làm 02 dừng. Lý do và giới hạn: xem Cách B, B2 (đoạn "Về `5f` và hai bảng `net`"). Không REVOKE/GRANT gì trong `net`.
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

## Cách B: SQL Editor của Supabase (không cần mật khẩu postgres)

Dùng cách này KHI KHÔNG có mật khẩu của role `postgres` (và không được đặt lại nó). Cách B thay O2, O3, O4 và bước Dọn của cách A; O1, O5, O6 giữ nguyên. Cách A vẫn đúng nếu có mật khẩu quản trị. Các khung lệnh dưới đây theo đúng "Cách dán lệnh" ở đầu file: dán một lệnh rồi đợi dấu nhắc `%` hiện lại. Trước khi chụp màn hình terminal: gõ `clear` rồi Enter.

Hạn chế (nói thật):
- Cách B mới chỉ được thử trên PostgreSQL 16 cục bộ (dán cả file như một chuỗi, giống Editor), CHƯA thử trong SQL Editor thật của Supabase. Editor có thể hiển thị kết quả khác dự kiến (ví dụ chỉ hiện ô cuối, hoặc hiện lỗi thay cho bảng). Thấy gì lạ: DỪNG và báo.
- Editor có thể tự lưu truy vấn (Saved queries, lịch sử). Không truy vấn nào ở cách B chứa mật khẩu (B4 sinh nó trong DB); truy vấn B3 chứa id site nên xoá sau khi chạy, và ô kết quả của B4 phải được đóng sau B5.
- Project Supabase thường có nhiều hàm SECURITY DEFINER ở schema khác `public` (ví dụ của các extension). Khi đó 02 có thể dừng với `SELF-CHECK STOP: ... SECURITY DEFINER function(s) outside public` (không tạo gì). Chỉ nới `allow_definer_outside_public` thành `'yes'` có chủ đích, SAU khi đã xem mục 5d trong kết quả của 01e; nếu không chắc: DỪNG và báo số lượng theo schema (dòng `count by schema`).
- PostgreSQL 14 trở xuống: 02 luôn dừng (như cách A).
- Editor chạy bằng role `postgres` của Supabase (không phải superuser thật, có CREATEROLE). Probe cục bộ đã thử 02/03 bằng chủ bảng không phải superuser có CREATEROLE, nhưng `03e` và `02p` CHỈ được thử bằng superuser, CHƯA thử bằng chủ không-superuser.
- Probe cục bộ dùng xác thực `trust` (riêng bước kiểm mật khẩu của `02p` bật SCRAM tạm cho role `vowasia_migrator`) và chạy phần lớn bằng superuser. Chỉ thử trên PostgreSQL 16, CHƯA thử PostgreSQL 15.
- Đăng nhập session pooler dạng `vowasia_migrator.MÃ_PROJECT` CHƯA được xác nhận trên Supabase thật (role tự tạo có thể không đăng nhập qua pooler được). Không được thì DỪNG và báo.
- `LEGACY_VOWASIA_DB_SSL=require` mã hoá đường truyền nhưng KHÔNG kiểm chứng chứng chỉ máy chủ.
- Editor có thể giới hạn số hàng hiển thị: hàng cuối của `01e` (`9 total rows`) cho tổng số hàng; thấy ít hơn thì cuộn/xem trang sau, hoặc báo lại.
- Editor KHÔNG hiện dòng `NOTICE`: mọi kết quả cần đọc ở cách B nằm trong ô kết quả cuối. Vì thế cách B KHÔNG dùng `02b` (bước Dọn của 02b cần dòng `NOTICE ... BEFORE` để biết trạng thái RLS cũ); chỉ dùng phương án 2 (`02`).
- Role có hạn dùng 14 ngày (VALID UNTIL). Quá hạn thì đăng nhập (discover) báo lỗi xác thực. Trong cách B, lối ra DUY NHẤT là: B6 (03e), rồi B3 và B4 lại, rồi B5 với mật khẩu mới. Cách B không gia hạn bằng psql (không có URL quản trị).
- Trong khoảng từ B3 tới B6, hai view khoá cột của `public.articles` và `public.sites`: KHÔNG chạy migration đổi cột các bảng đó của site cũ (ví dụ GTP) giữa B3 và B6; migration đó có thể lỗi vì view đang phụ thuộc cột. Muốn chạy thì làm B6 trước.
- Role `vowasia_migrator` là cấp cụm: Editor chỉ thấy database `postgres` của project; `01e` liệt kê các database mà PUBLIC kết nối được (mục `5c`, dòng `databases PUBLIC can CONNECT to`). Role có thể kết nối các database đó (không đọc được bảng nếu không có quyền); đây là rủi ro đã chấp nhận, không kiểm thêm được từ Editor.

### B1: mở SQL Editor

Mở Supabase, chọn project `globaltravelpost`, vào SQL Editor, bấm New query (một ô trống).

TRƯỚC KHI dán bất kỳ SQL nào (ở B2, B3, B4, B6): nhìn tên project ở góc trên bên trái của Supabase, phải là đúng `globaltravelpost`. Khác thì DỪNG, chọn lại project. Lý do: trên Supabase mọi database đều tên `postgres`, nên chốt tên database trong file SQL (`__LEGACY_DB_NAME__`) KHÔNG phân biệt được project; chỉ có bước nhìn tên project này phân biệt.

### B2: đọc cấu trúc DB cũ (chỉ SELECT)

Dán một lệnh rồi đợi dấu nhắc `%` hiện lại. Lệnh này chép file vào clipboard (không in gì):

```bash
cat scripts/migrate/vowasia/sql/01e-inspect-single-result.sql | pbcopy
```

Dán vào ô New query (Cmd+V), bấm Run. Kết quả là MỘT bảng ba cột `section`, `item`, `detail`. Các hàng đầu là mục `6 vowasia site row` (id, slug, name của dòng site có slug chứa `vow`); tiếp theo là `1 connection` (tên database và role đang dùng: ghi lại tên database, với Supabase thường là `postgres`). Hàng CUỐI là `9 total rows` (tổng số hàng): thấy ít hàng hơn số đó thì Editor đã cắt bớt, cuộn hoặc xem trang sau. Mục nào không có dữ liệu hiện `(none)`.

Nếu cả câu báo lỗi (không ra bảng), hoặc mục 6 ghi `columns missing`: chép lệnh dự phòng dưới vào clipboard, dán vào một New query, Run, rồi báo kết quả (chỉ id, slug, name):

```bash
echo "SELECT id, slug, name FROM public.sites WHERE lower(slug) LIKE '%vow%';" | pbcopy
```

Báo lại đúng các nhóm như mục "Báo lại" của O2 (1 đến 6), đọc từ cột `section`: `6b columns` (cột của hai bảng), `2 public tables/views` và `5 acl of articles/sites` (cờ RLS, quyền), `3 rls policies (public)`, `5 login roles`, `5a nologin roles reading the tables`, `5e role membership`, `5b connected roles`, `5c public privileges` (gồm `databases PUBLIC can CONNECT to` và `password_encryption`), `5d security definer callable by PUBLIC` (chỉ cần dòng `count by schema` và giá trị `in_public` trong cột `detail` của từng hàm), `5f PUBLIC-readable relations (02 stops on any not allowed by its allow-list)` (chỉ báo SỐ hàng, tên nếu là bảng VowAsia, và tên các hàng có nhãn `(allowed by 02 allow-list)` cùng cột `detail` của chúng), `5g schemas where PUBLIC can add objects (02 stops on any)`, `4 site_id column types`, và `6 vowasia site row` (chỉ báo slug và name; id site: không cần gửi cho ai, chỉ dùng trong ô tìm và thay ở B3). Không báo tên bảng nhạy cảm nào khác. Trước khi chụp màn hình: chỉ chụp phần cần báo, không chụp dòng chứa thông tin nhạy cảm.

Về `5f` và hai bảng `net` (Amendment 2, 19-10-26): trên Supabase, tiện ích mở rộng `pg_net` mặc định cho PUBLIC mọi quyền trên `net._http_response` và `net.http_request_queue` (mọi role, kể cả `anon`/`authenticated`, đều có; suy luận từ ACL, chưa kiểm từng role). 02 nay cho qua ĐÚNG hai bảng này theo tên (khớp chính xác schema, tên và loại bảng thường), nên chúng hiện ở `5f` với nhãn `(allowed by 02 allow-list)` và không làm 02 dừng. Mọi hàng `5f` khác (kể cả bảng khác trong `net`, hay cùng tên ở schema khác) vẫn làm 02 dừng. TUYỆT ĐỐI không REVOKE/GRANT hay sửa gì trong schema `net` (site cũ dùng nó). Giới hạn nói thẳng: role mới thừa hưởng quyền đó từ PUBLIC; role mặc định chỉ đọc (`default_transaction_read_only`, 02 tự kiểm dòng này có thật), nhưng ai giữ mật khẩu vẫn tự tắt được bằng `SET`. Rủi ro còn lại được chặn bằng: hạn 14 ngày, mật khẩu chỉ chủ giữ, xoá role khi xong (B6). Chưa thử trong SQL Editor thật, chỉ trên PostgreSQL 16 cục bộ.

Đọc trước chỗ 02 sẽ DỪNG: nếu `5d` có hàm `in_public=yes` (dừng cứng, không có cách nới), hoặc `5d` có hàm `in_public=no` (dừng khi `allow_definer_outside_public` còn là `'no'`, tức mặc định), hoặc `5f` có hàng nào KHÔNG mang nhãn `(allowed by 02 allow-list)`, hoặc `5g` có schema nào, hoặc `5c` dòng `database CONNECT | TEMP | can add schemas` có giá trị cuối là `true`, thì 02 SẼ dừng ở B3. Khi đó KHÔNG chạy B3; báo lại đúng các hàng đó (xem bảng "02 dừng ở đâu" trong B3).

Cũng xem hàng `password_encryption` trong `5c`: nếu giá trị là `md5` (không phải `scram-sha-256`): DỪNG, không làm B3, báo orchestrator.

Ghi chú: file `01e` có dấu `\` trong `LIKE 'pg\_%'`. Đó là ký tự thoát của LIKE (khớp đúng dấu gạch dưới), không phải lệnh của psql; dán nguyên văn.

### B3: tạo role chỉ-đọc (khuyên phương án 2)

Cách B CHỈ dùng phương án 2 (`02`). KHÔNG dùng `02b` trong cách B: Editor không hiện dòng `NOTICE ... BEFORE` của 02b, nên mất trạng thái RLS cũ cần cho bước gỡ, và 02b đổi bảng dùng chung. Chép mẫu 02 vào clipboard:

```bash
cat scripts/migrate/vowasia/sql/02-create-readonly-role-views.sql.template | pbcopy
```

Mở một New query mới, dán (Cmd+V). Mở tìm-và-thay của Editor: trên Mac là Cmd+Option+F, trên Windows/Linux là Ctrl+H. Gõ chỗ giữ chỗ vào ô tìm, giá trị vào ô thay, bấm Replace All (thay hết). Làm lần lượt cho từng chỗ giữ chỗ:
- `__VOWASIA_SITE_ID__`: id site VowAsia (mục `6 vowasia site row`);
- `__VOWASIA_SITE_SLUG__`: slug của dòng đó (phải là `vowasia`; khác thì DỪNG và báo);
- `__ARTICLE_COLUMNS__`: danh sách cột TƯỜNG MINH của bảng bài viết (mục `6b columns`, mỗi tên trong dấu nháy kép, cách nhau bằng dấu phẩy), có `"site_id"`, KHÔNG có cột cá nhân;
- `__LEGACY_DB_NAME__`: tên database ở dòng đầu kết quả B2 (thường là `postgres`).

Sau khi thay hết: tìm `__` (hai dấu gạch dưới) trong Editor; không được còn kết quả nào (còn thì thay tiếp). Giữ nguyên `allow_definer_outside_public` là `'no'` (xem Hạn chế ở trên). Bấm Run, đọc ô kết quả cuối:
- đúng `SELF-CHECK OK`: sang B4;
- `SELF-CHECK FAILED: nothing created`: KHÔNG đặt mật khẩu; làm B6 cho chắc rồi DỪNG và báo;
- một lỗi (ví dụ `SELF-CHECK STOP: ...`, `DB NAME STOP: ...`, `lock timeout`): cả giao dịch đã huỷ, không tạo gì; DỪNG và báo nguyên văn dòng lỗi.

02 dừng ở đâu, và làm gì (mọi trường hợp: cả giao dịch huỷ, KHÔNG tạo gì, site cũ không đổi). Với MỌI dòng dưới: đọc dòng lỗi, báo lại nguyên văn cho orchestrator, KHÔNG tự sửa DB. Tuyệt đối KHÔNG chạy `REVOKE ... FROM PUBLIC` (hay bất kỳ REVOKE/GRANT nào) để "gỡ" một chỗ dừng: đó là việc DUY NHẤT ở đây có thể làm hỏng site cũ.

| Dòng lỗi (bắt đầu bằng) | Nghĩa | Làm gì |
|---|---|---|
| `vowasia: placeholder ... not filled` | còn chỗ giữ chỗ chưa thay | thay hết (tìm `__`), Run lại |
| `DB NAME STOP: ...` | `__LEGACY_DB_NAME__` sai hoặc đang ở `neondb` | kiểm tên project (B1) và tên ở B2, sửa, Run lại; vẫn dừng thì báo |
| `SELF-CHECK STOP: view sites does not return exactly 1 row` | id site sai (số dòng site khác 1) | đối chiếu id ở mục `6 vowasia site row`, sửa, Run lại; vẫn dừng thì báo |
| `SELF-CHECK STOP: the site row slug is not the expected slug` | slug lệch | DỪNG và báo (cần amendment nếu slug thật khác `vowasia`) |
| `role "vowasia_migrator" already exists` | role đã có từ lần chạy trước (02 không tạo đè; lệnh tạo role chặn ngay, không gì đổi) | nếu lần trước 02 đã báo `SELF-CHECK OK`: KHÔNG chạy lại, sang B4; nếu không: làm B6 (03e) rồi B3 lại; vẫn báo lỗi này thì DỪNG và báo |
| `SELF-CHECK STOP: ... bypasses RLS or is superuser` / `... is a member of another role` | role vừa tạo có quyền thừa (ví dụ được thêm vào role khác bởi một cấu hình mặc định của cụm). Không phải do role cùng tên có sẵn: trường hợp đó dừng sớm hơn ở dòng `already exists` | DỪNG và báo |
| `SELF-CHECK STOP: ... can CREATE in this database` | PUBLIC tạo được schema trong database (mục `5c`, giá trị cuối `true`) | DỪNG và báo |
| `SELF-CHECK STOP: ... can CREATE in a schema` | PUBLIC tạo được đối tượng trong một schema (mục `5g`) | DỪNG và báo |
| `SELF-CHECK STOP: ... has a privilege on a table outside vowasia_ro` | PUBLIC đọc/ghi được một bảng KHÔNG nằm trong danh sách cho phép (hàng `5f` không mang nhãn `(allowed by 02 allow-list)`) | DỪNG và báo số hàng mục `5f` không mang nhãn đó; KHÔNG tự thêm tên vào danh sách (cần amendment mới) |
| `SELF-CHECK STOP: ... default_transaction_read_only is not set to on` | dòng `ALTER ROLE ... default_transaction_read_only = on` của 02 bị xoá hoặc gõ sai | dán lại mẫu 02 nguyên vẹn (B3), Run lại; vẫn dừng thì báo |
| `SELF-CHECK STOP: ... SECURITY DEFINER function in schema public` | hàm SECURITY DEFINER thường trong `public` mà PUBLIC gọi được (mục `5d`, `in_public=yes`); hàm trả trigger không tính | DỪNG và báo; không có cách nới |
| `SELF-CHECK STOP: ... SECURITY DEFINER function(s) outside public` | như trên, ở schema khác (`in_public=no`) | DỪNG và báo dòng `count by schema`; chỉ nới `allow_definer_outside_public` khi orchestrator nói rõ |
| `lock timeout` | bảng gốc đang bận | đợi vài phút, Run lại; lặp lại thì báo |

Không lưu truy vấn này (nó chứa id site); xoá nó khỏi Editor sau khi chạy.

### B4: đặt mật khẩu

Chỉ làm khi B3 báo đúng `SELF-CHECK OK`, và hàng `password_encryption` của B2 KHÔNG phải `md5` (là `md5` thì DỪNG, báo orchestrator). Kiểm lại tên project (B1). Chép mẫu 02p vào clipboard:

```bash
cat scripts/migrate/vowasia/sql/02p-set-password.sql.template | pbcopy
```

Mở New query, dán (Cmd+V), KHÔNG sửa gì (file không có chỗ giữ chỗ, không gõ mật khẩu). Bấm Run MỘT lần cho cả file. File tự sinh mật khẩu ngẫu nhiên 64 ký tự (0-9, a-f) ngay trong DB, đặt cho role, và hiện nó ĐÚNG MỘT LẦN ở ô kết quả cuối, cột `new_secret`. Văn bản truy vấn không chứa mật khẩu, nên lịch sử truy vấn không giữ nó.

- Ô `new_secret` ghi `NOT SHOWN: ...`: mật khẩu đã đổi nhưng không hiện; Run lại cả file.
- Lỗi `02P STOP: ...` (role, schema hoặc view của 02 thiếu): không đổi gì; DỪNG và báo.
- MỖI lần Run sinh mật khẩu MỚI, mật khẩu cũ hết dùng được.

CHƯA chép mật khẩu ở bước này: để tab này mở, sang B5 (B5 sẽ quay lại đây chép mật khẩu SAU khi đã chép chuỗi kết nối, vì mỗi lần chép đều ghi đè clipboard). Không chụp màn hình ô đó, không dán vào chat. Nếu lỡ đóng tab trước khi chép được: mở New query, Run lại 02p (sinh mật khẩu mới, mật khẩu cũ hết dùng được).

### B5: nhập URL kết nối và chạy discover

Thứ tự quan trọng: chép chuỗi kết nối TRƯỚC, mật khẩu SAU (mỗi lần chép ghi đè clipboard).

1. Trong Supabase, nút Connect, chọn chuỗi kết nối "Session pooler" (cổng `5432`). KHÔNG dùng "Transaction pooler" (cổng `6543`). Chép chuỗi đó, dán vào một ghi chú tạm KHÔNG đồng bộ (xoá ngay sau bước này).
2. Trong ghi chú, sửa tên đăng nhập: đổi `postgres.MÃ_PROJECT` thành `vowasia_migrator.MÃ_PROJECT` (chỉ đổi chữ `postgres` đứng ngay trước dấu chấm; giữ nguyên phần mã project sau dấu chấm; công cụ chỉ nhận đúng dạng này hoặc `vowasia_migrator`). Database giữ là `postgres`. KHÔNG thêm `?sslmode=...` hay tham số ssl nào (công cụ từ chối).
3. Quay lại tab B4, chép giá trị ô `new_secret` bằng nút copy của ô kết quả. Nếu không thấy nút copy: bấm vào ô đó một lần rồi nhấn Cmd+C (Windows/Linux: Ctrl+C). Không bôi đen tay một phần.
4. Trong ghi chú, bôi đen cả chữ `[YOUR-PASSWORD]` (kể cả hai dấu ngoặc vuông) rồi dán (Cmd+V) để thay bằng mật khẩu.

Tôi chọn cách soạn trong ghi chú (không ghép bằng lệnh shell) vì ít bước hơn và không phụ thuộc cú pháp thay chuỗi của zsh (chưa thử được trong zsh thật). Nếu ghép sai, lỗi chỉ là không kết nối được (an toàn): soạn lại.

Chép cả URL trong ghi chú, rồi nhập bằng `read -s` (dán lệnh, Enter, dán URL, Enter; không hiện gì):

```bash
read -s LEGACY_VOWASIA_DB_URL
```

```bash
export LEGACY_VOWASIA_DB_URL
```

```bash
export LEGACY_VOWASIA_DB_SSL=require
```

Xoá ghi chú tạm ngay. Nếu dùng ứng dụng Notes (Ghi chú) của Apple: ghi chú vừa xoá còn nằm ở thư mục "Recently Deleted" (Đã xoá gần đây) tới 30 ngày; mở thư mục đó và xoá hẳn ghi chú (Delete). Đóng tab B4 (và xoá nó khỏi Saved queries nếu đã lỡ lưu) để ô `new_secret` không còn trên màn hình. Xoá mật khẩu khỏi clipboard: bôi đen một chữ vô hại bất kỳ (ví dụ chữ `vowasia` trong trang này) rồi Cmd+C. Rồi làm O5 (overlay ngoài repo, rồi `npm run migrate:vowasia:discover`). Dòng đầu chỉ in `host:port/database` và chế độ SSL; tên đăng nhập và mã project không được in. Khi xong discover, `unset LEGACY_VOWASIA_DB_URL` như O5.

### B6: dọn

Chép mẫu dọn vào clipboard:

```bash
cat scripts/migrate/vowasia/sql/03e-drop-in-editor.sql.template | pbcopy
```

Kiểm lại tên project (B1). Mở New query, dán, mở tìm-và-thay (Mac: Cmd+Option+F; Windows/Linux: Ctrl+H), thay `__LEGACY_DB_NAME__` bằng tên database ở B2 (thường là `postgres`), bấm Replace All, rồi tìm `__` (hai dấu gạch dưới) để chắc không còn chỗ giữ chỗ (phải ra 0 kết quả). Bấm Run. Ô kết quả cuối, cột `vowasia_cleanup_check`, phải là đúng `CLEANUP OK`; cùng hàng có trạng thái RLS của hai bảng gốc và `vowasia_policies_left` (phải là `0`). Không cần (và không có) dòng `NOTICE`. Nếu thấy lỗi `DB NAME STOP: ...` (chưa thay chỗ giữ chỗ, sai tên, hoặc đang ở `neondb`): không có gì bị xoá; sửa rồi chạy lại. Chạy lại nhiều lần vẫn an toàn. Cách B không dùng `02b`; nếu đã lỡ chạy 02b: KHÔNG chạy 03e, DỪNG và báo. Cuối cùng xoá các file riêng tư như mục Dọn của cách A. Role là cấp cụm: Editor chỉ dọn được trong database `postgres` của project (xem Hạn chế).

## Kiểm thử cục bộ (agent, không cần DB thật)

```bash
npm run test:migrate-vowasia
```

```bash
npm run probe:migrate-vowasia
```

Lệnh đầu là unit test (không DB, không mạng). Lệnh thứ hai dựng PG16 tạm cục bộ (cổng 54336, xác thực trust chỉ trên 127.0.0.1), tự dọn; chạy một mình. Probe kiểm keyset (trùng mili-giây khác micro-giây, `created_at` trùng, NULL, 1970), chạy `01` bằng role không có quyền ghi, áp `02` (kể cả trường hợp tự kiểm STOP thì không tạo gì) và `03`, các bản cho SQL Editor (`01e` trả đúng một bảng, mục site đầu tiên, hàng tổng cuối; `02` dán như một chuỗi, hàm SECURITY DEFINER trả trigger không làm 02 dừng còn hàm thường thì dừng; `02p` dừng khi thiếu role/schema/view, sinh mật khẩu trong SQL và role đăng nhập SCRAM được bằng nó; `03e` báo trạng thái trong ô kết quả), cả bằng chủ bảng KHÔNG phải superuser có CREATEROLE, kiểm hàng rào của `02b`, kiểm role chỉ đọc đúng site và không ghi được, chạy discover qua role và kiểm đầu ra không lộ id site, mật khẩu, thân bài. Nó không chứng minh hành vi trên DB cũ THẬT (đó là O2-O5).
