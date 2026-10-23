# network-legacy: chuyển bài từ DB cũ dùng chung sang Central (mọi tựa trừ GTP)

Một bộ công cụ chạy được cho mọi tựa nằm trong DB cũ dùng chung (Supabase project
**`globaltravelpost`**, database `postgres`). Nó chạy đúng chuỗi của GTP
(`scripts/migrate/GTP-LEGACY.md`) nhưng nhận tham số tựa:

```
npm run migrate:network -- <lệnh> --tenant <slug Central> --site <slug site cũ hoặc id site> [cờ của lệnh]
```

- Lệnh: `discover`, `export`, `validate-mapping`, `import`, `rewrite-links`,
  `timestamps-fix`, `rollback`, `redirects`, `verify`. Cờ của từng lệnh giống hệt bản GTP
  (`scripts/migrate/lib/cli-spec.ts`).
- Mỗi tựa có một hồ sơ trong repo: `network/profiles/<tenant>.json` (tenant, các pillar,
  pillar một nhà, nhãn nguồn `legacy:<domain>`, tên biến môi trường) và một mapping
  `network/mappings/<tenant>.mapping.json`. GTP KHÔNG dùng bộ này (GTP vẫn chạy
  `npm run migrate:gtp:*`, hành vi không đổi).
- `--site`: nếu là id (uuid) thì phải trùng `source.siteFilter` trong overlay; nếu là slug
  thì dòng site phải đúng slug đó. Không bao giờ đoán slug: lấy từ file SQL 01.
- URL DB cũ: biến `LEGACY_DB_URL` (chỉ qua biến môi trường, không qua cờ). Token đọc cho
  `verify --public-base`: biến `CENTRAL_READ_TOKEN`.
- Mọi lệnh ghi Central: mặc định chạy khô; `--apply` mới ghi; DB không phải local cần
  `--confirm-host=<host>`, cần Terminal thật (TTY), và tên database phải đúng `/neondb`.
  Nhật ký ghi ra `scripts/migrate/out/<run-id>/` (git bỏ qua, quyền 700/600).
- Lệnh nạp Payload đôi khi kẹt lúc khởi động (thoát mã 75, chưa làm gì). Bộ này tự chạy
  lại đúng lệnh đó tối đa 3 lần. Nếu vẫn 75: chạy lại y nguyên lệnh.

Diễn tập trên dữ liệu giả (máy dev, không đụng DB thật): `npm run rehearse:network-aer`.
Test: `npm run test:migrate-network`.

## Asia Economic Review (`--tenant aer`)

- Slug Central: **`aer`** (chủ dự án chốt 19-10-26). Role DB cũ: `aer_migrator`; schema
  view: `aer_ro`; overlay riêng: `~/aer-private/overlay.json`; run-id: `aer-real-1`,
  `aer-real-2`, ...
- Dòng site cũ: slug `asiaeconomicreview`, id `211bbbba-cfa2-435c-ba67-f680d48ee1a2` (khám phá 20-10-26: 644 bài = 276 published, 311 archived chưa từng đăng, 53 draft, 4 rejected; 624 ảnh đại diện ở `mbolvnwkmkeroqmvbvmt.supabase.co`, 0 ảnh trong thân).
- Mapping `mappings/aer.mapping.json` **đã chốt** (chủ dự án 20-10-26, `_provisional` rỗng):
  - chỉ chuyển bài `published`; `archived`/`draft`/`scheduled`/`rejected` bỏ qua. Lượt chạy
    bù trước khi chuyển tên miền lấy thêm bài site cũ đăng sau lần chạy đầu;
  - `briefings` và `corporate-asia` giữ nguyên mục con (policy, markets, industry, companies;
    capital, strategy); `essays` vào `asia-watch`, giữ mục con growth-policy,
    money-finance, technology-industry;
  - tác giả chia đều 4 người (`mode: even`, không giữ byline cũ; Lena Ho từng đứng tên
    247/276 bài đã đăng);
  - chỉ giữ 6 tag đã duyệt (`tags.keepOnly`), không nhập 1:1. SEO cũ bỏ.
- Ảnh: ảnh đại diện của từng bài được tải về và tạo thành ảnh của tenant trên R2
  (tối đa 20 MB, dừng nếu hỏng quá 2%). Overlay PHẢI có host Storage cũ
  `mbolvnwkmkeroqmvbvmt.supabase.co` trong `hostAllowlist`. Kho ảnh cũ `media_assets`:
  không chuyển lần này (Q6).
- Các trang cũ không có bài (`/team`, `/the-long-view`, `/the-review-interview`,
  `/data-annual`, `/partner-insights`) không sinh redirect từ mapping: viết tay vào
  `aer-web/src/redirects/redirect-rules.json` lúc cutover.

### Các bước của chủ dự án (B5), mỗi lần một bước

**Trước khi ngồi làm:** `~/apcg-cms/.env.local` phải có đủ 4 biến `R2_BUCKET`, `R2_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` của bucket R2 production. Thiếu biến nào thì
importer từ chối chạy với Central thật (kể cả chạy khô), vì Payload sẽ lưu ảnh vào ổ máy
thay vì R2 và ảnh của mọi bài trên Central sẽ hỏng. Mac cũng cần `psql` (bước 13).

**Chỗ giữ chỗ trong lệnh:** `ID_SITE` (id site cũ, từ bước 1) và `HOST_CENTRAL` (host của
URL Central, từ bước 9) là chữ giữ chỗ. **Agent điền giá trị thật vào trước khi gửi từng
lệnh**; chủ dự án không tự sửa lệnh. Mỗi khối dưới đây là đúng một lệnh, dán cả khối.

Bước 1 đến 4 làm trong trình duyệt: supabase.com/dashboard, project **globaltravelpost**,
SQL Editor, New query. Mỗi file: mở file trong repo, chép TOÀN BỘ, dán, bấm Run một lần.
Không phải sửa gì trong file.

1. **Khám phá**: chạy `scripts/migrate/network/sql/01-discover-aer.sql`. Bấm
   "Download CSV" và gửi file đó. Cần thấy hàng `1 site match | rows matching
   asiaeconomicreview | 1`. Nếu khác 1: dừng và báo.
2. **Chủ dự án chốt bảng quyết định mapping** (agent soạn từ kết quả bước 1).
3. **Tạo role chỉ-đọc**: chạy `sql/02-create-readonly-role-views.sql`. Ô kết quả phải là
   `SELF-CHECK OK` kèm số bài thấy được. Nếu ra lỗi `... STOP ...`: không có gì được tạo,
   gửi nguyên văn dòng lỗi.
4. **Đặt mật khẩu**: chạy `sql/02p-set-password.sql`. Bấm nút copy của ô `new_secret`
   (không chụp màn hình). Đóng tab truy vấn sau bước 6.
5. **Overlay riêng** trên Mac (ngoài repo). Mở Terminal mới trên Mac (không phải cửa sổ
   SSH). Dán lệnh:
   ```
   mkdir -p ~/aer-private
   ```
   ```
   chmod 700 ~/aer-private
   ```
   Agent gửi nội dung file `overlay.json` (có id site lấy từ bước 1) để lưu bằng `nano`.
6. **Đưa URL DB cũ vào Terminal** (không hiện lên màn hình):
   ```
   cd ~/apcg-cms
   ```
   ```
   read -s LEGACY_PW
   ```
   Dán mật khẩu vừa copy, Enter. Rồi:
   ```
   export LEGACY_DB_URL="postgresql://aer_migrator.mbolvnwkmkeroqmvbvmt:$LEGACY_PW@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
   ```
   Host pooler ở trên là ví dụ: lấy đúng host **Session pooler, cổng 5432** ở Supabase >
   Connect. Không dùng cổng 6543.
7. **Khám phá bằng công cụ** (chỉ đọc):
   ```
   npm run migrate:network -- discover --tenant aer --site ID_SITE --mapping-overlay ~/aer-private/overlay.json
   ```
   (agent thay `ID_SITE` bằng id thật trước khi gửi lệnh).
8. **Kiểm mapping đã chốt**:
   ```
   npm run migrate:network -- validate-mapping --tenant aer --mapping-overlay ~/aer-private/overlay.json --require-final
   ```
9. **Đưa URL Central vào Terminal** (không hiện lên màn hình). Gõ lệnh:
   ```
   read -s DATABASE_URL
   ```
   Dán URL Central (agent nói lấy ở đâu), Enter. Rồi:
   ```
   export DATABASE_URL
   ```
   Kiểm tên database, phải in ra đúng `/neondb` (khác thì dừng và báo):
   ```
   node -e 'console.log(new URL(process.env.DATABASE_URL).pathname)'
   ```
   Rồi **chạy khô**:
   ```
   npm run migrate:network -- import --tenant aer --site ID_SITE --mapping-overlay ~/aer-private/overlay.json --confirm-host=HOST_CENTRAL
   ```
10. **Ghi thử 50 bài**, rồi mở xem bằng mắt:
    ```
    npm run migrate:network -- import --tenant aer --site ID_SITE --mapping-overlay ~/aer-private/overlay.json --apply --limit 50 --run-id aer-real-1 --confirm-host=HOST_CENTRAL
    ```
11. **Chạy toàn bộ** (Mac không ngủ; lâu, ước lượng theo số bài ở bước 1):
    ```
    caffeinate -i npm run migrate:network -- import --tenant aer --site ID_SITE --mapping-overlay ~/aer-private/overlay.json --apply --resume --run-id aer-real-1 --confirm-host=HOST_CENTRAL
    ```
    Dừng giữa chừng: chạy lại đúng lệnh này.
12. **Sửa link trong bài**:
    ```
    npm run migrate:network -- rewrite-links --tenant aer --run-id aer-real-1 --apply --confirm-host=HOST_CENTRAL
    ```
13. **Sửa ngày tạo/sửa** bằng psql với URL **direct** của Neon (không qua pooler).
    Lấy URL: console.neon.tech, project **apcg-master-db**, nút **Connect**, chọn database
    **neondb**, TẮT **Connection pooling** (Pooled), bấm copy. Gõ lệnh:
    ```
    read -s DIRECT_URL
    ```
    Dán URL vừa copy, Enter. Rồi:
    ```
    export DIRECT_URL
    ```
    Kiểm tên database, phải in ra đúng `/neondb` (khác thì dừng và báo):
    ```
    node -e 'console.log(new URL(process.env.DIRECT_URL).pathname)'
    ```
    Host của URL direct KHÔNG có chữ `-pooler`. Rồi:
    ```
    npm run migrate:network -- timestamps-fix --tenant aer --run-id aer-real-1
    ```
    ```
    psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/migrate/out/aer-real-1/timestamps-fix.sql
    ```
14. **Kiểm 12 phép**:
    ```
    npm run migrate:network -- verify --tenant aer --site ID_SITE --run-id aer-real-1 --mapping-overlay ~/aer-private/overlay.json --confirm-host=HOST_CENTRAL
    ```
15. **Chạy bù trước cutover**: run-id MỚI (`aer-real-2`, `aer-real-3`), cùng thư mục out,
    không `--resume` run-id cũ. Chạy khô trước để xem số bài mới.
16. **Lúc cutover**: dựng redirect từ known-routes của web (thoát mã 3 nếu có chuỗi, vòng lặp
    hoặc đích không tồn tại), rồi xoá role bằng `sql/03-drop-role-and-views.sql` (ô kết quả
    `CLEANUP OK`). Giữ project cũ tới khi cutover xong.
    ```
    npm run migrate:network -- redirects --tenant aer --run-id aer-real-1 --known-routes ~/aer-private/known-routes.json --mapping-overlay ~/aer-private/overlay.json
    ```

Rủi ro phải nói rõ (giống VowAsia Amendment 2): role `aer_migrator` đọc được hai bảng
pg_net `net._http_response`, `net.http_request_queue` (Supabase cấp cho mọi role), và nếu
tự tắt chế độ chỉ-đọc thì ghi được hàng đợi HTTP, nên lộ mật khẩu là lộ nhiều hơn dữ liệu
AER. Làm bước 3 tới 14 trong một lần ngồi, xoá role khi xong; role tự hết hạn sau 14 ngày.

## AsiaGolfReview (`--tenant agr`)

- Slug Central: **`agr`** (chủ dự án chốt 23-10-26). Role DB cũ: `agr_migrator`; schema
  view: `agr_ro`; overlay riêng: `~/agr-private/overlay.json`; run-id: `agr-real-1`, ...
- Dòng site cũ: **chưa biết** (đoán slug `asiagolfreview`). File khám phá
  `sql/01-discover-agr.sql` tìm dòng site theo `asiagolfreview` / `asia golf review` /
  `asia-golf-review` hoặc slug đúng `agr`, in ra mọi slug site để so, và thêm mục
  `3b countries x section` (để quyết mục con theo nước của Course Reviews).
- File SQL Editor của agr là bản riêng (khác tên với file của AER):
  `sql/01-discover-agr.sql`, `sql/02-create-readonly-role-views-agr.sql`,
  `sql/02p-set-password-agr.sql`, `sql/03-drop-role-and-views-agr.sql`. Các bước giống hệt
  AER ở trên, chỉ thay `aer` bằng `agr` và dùng đúng các file này. Đã chạy thử cả bốn file
  trên Postgres giả trong máy (23-10-26): khám phá ra đúng 1 site, `SELF-CHECK OK`,
  `CLEANUP OK`.
- Mapping `mappings/agr.mapping.json` **CHƯA chốt** (`_provisional` còn: `status.map`,
  `categories.map`, `authors.distribute`, `tags.keepOnly`, `media.bodyImages`, các `urls.*`,
  `archivedAs`). `validate-mapping --require-final` (ngầm bật khi chạy với Central thật) từ
  chối cho tới khi chủ dự án chốt sau bước khám phá. Gợi ý đang ghi:
  - chỉ chuyển bài `published`;
  - mục con cũ trùng tên giữ nguyên (`asia-top-100`, `best-new-courses`, `country-top-10`,
    `destinations`, `itineraries`, `resorts-stays`, `the-practical-game`, `players`,
    `tournament-news`, `watch-prize-money`, `club-management`, `data-insights`,
    `development-design`, `people`);
  - `course-reviews/hidden-gems`, `new-renovated` → `course-reviews` không mục con, thêm
    tag `hidden-gems` / `new-renovated` (`addTags`); `by-country`, `the-review-index` →
    `course-reviews` không mục con (mục con theo nước: chủ dự án quyết);
  - `gear-style/equipment`, `tested-in-the-tropics` → `gear-style` không mục con (gợi ý
    `clubs`, chưa chốt); `gear-style/style` → `gear-style/apparel`;
  - `press-room/*` → `press-room` không mục con (một nhà), chưa gắn tag;
  - `events-awards`: **không có dòng** cố ý; bài ở đó bị từ chối cho tới khi chủ dự án
    chọn pillar;
  - tác giả chia đều 5 người theo băm slug (`slugHash`, D7); chỉ giữ 7 tag đã duyệt.
- Ảnh: như AER, overlay PHẢI có host `mbolvnwkmkeroqmvbvmt.supabase.co`.
