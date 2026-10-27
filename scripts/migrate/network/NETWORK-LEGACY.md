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
- Dòng site cũ: slug `asiagolfreview`, id `773fee2f-8ab7-4787-a31c-2947267a03e7` (khám phá 26-10-26: 605 bài = 343 published, 208 archived (193 chưa từng có ngày đăng), 51 draft, 3 rejected; cột countries rỗng ở mọi bài; 578 ảnh đại diện ở `mbolvnwkmkeroqmvbvmt.supabase.co`, 27 bài không ảnh, 0 ảnh trong thân; không có bài `rankings`, `press-room`, `events-awards`; site cũ vẫn đang đăng bài).
- Mục con cũ thật khác dự đoán: `golf-travel/practical-game` (mới: `the-practical-game`) và `gear-style/tested-in-tropics` đã có dòng riêng trong mapping; `the-game` không mục con đi qua `the-game/*`.
- Mapping `mappings/agr.mapping.json` **đã chốt** (chủ dự án 26-10-26, `_provisional` rỗng,
  `validate-mapping --require-final` OK):
  - chỉ chuyển bài `published` (343); `archived`/`draft`/`scheduled`/`rejected` bỏ qua. Lượt
    chạy bù trước khi chuyển tên miền lấy thêm bài site cũ đăng sau lần chạy đầu;
  - mục con cũ trùng tên giữ nguyên; `golf-travel/practical-game` → `the-practical-game`;
  - `course-reviews/by-country` → `course-reviews` không mục con (DB cũ không có nước,
    biên tập gán sau); `new-renovated`, `hidden-gems` → `course-reviews` không mục con, thêm
    tag cùng tên;
  - `gear-style/equipment`, `tested-in-tropics` → `gear-style` không mục con (biên tập gán
    clubs/balls/bags sau); `gear-style/style` → `apparel`;
  - `events-awards`: không có dòng (DB cũ cũng không có bài);
  - tác giả chia đều 5 người trang Team (`mode: even`, lệch tối đa 1 bài; bản băm slug cho 61/70/83/64/65 ở lần chạy khô đầu nên đổi), không giữ byline cũ; chỉ giữ 7 tag
    đã duyệt; bài cũ không chuyển → 301 về trang chuyên mục (không 410); gốc cũ
    `https://asiagolfreview.com` (bản `www` cũng đang chạy, redirect lúc cutover phủ cả hai).
- Thân bài: site cũ lưu mỗi mục thành MỘT khối và tách đoạn lúc hiển thị (như AER) ⇒ `body.reflowMaxChars: 380` (khớp 104/117 mục mẫu trên site cũ). Lượt `agr-real-1` (8 bài, nhập trước khi có reflow) phải rollback rồi nhập lại bằng `agr-real-2`.
- Overlay của chủ dự án `~/agr-private/overlay.json`: `source.siteFilter` =
  `773fee2f-8ab7-4787-a31c-2947267a03e7`, `media.hostAllowlist` =
  `["mbolvnwkmkeroqmvbvmt.supabase.co"]`. Role DB cũ `agr_migrator`, schema `agr_ro`, run-id
  `agr-real-1`, `agr-real-2`, ...
- Ảnh: như AER, overlay PHẢI có host `mbolvnwkmkeroqmvbvmt.supabase.co`.
- **Đã chạy 26-10-26:** lượt `agr-real-2` nhập 343 bài published (334 ảnh tạo, 1 bài không ảnh), timestamps-fix `COMMIT`, `verify` PASS (phép 8 redirects SKIP). Role `agr_migrator` đã xoá bằng file 03, khoá R2 tạm `agr-migrate-temp` đã xoá. Site cũ vẫn đăng bài.
- **Lượt chạy bù lúc cutover** (chủ dự án tắt pipeline cũ NGAY TRƯỚC lượt này, Q8):
  1. Tạo lại quyền: chạy `02-create-readonly-role-views-agr.sql` (`SELF-CHECK OK`), rồi `02p-set-password-agr.sql`; tạo khoá R2 tạm mới (Object Read & Write, chỉ `apcg-central-media`), ghi 4 biến R2 vào `.env.local` bằng `read -s`.
  2. `read -s LEGACY_PW`, `export LEGACY_DB_URL=...` (host Session pooler `aws-0-ap-southeast-1.pooler.supabase.com:5432`, user `agr_migrator.mbolvnwkmkeroqmvbvmt`).
  3. Chạy khô với run-id MỚI `agr-real-3` (không `--resume` run-id cũ): bài đã có sẽ là `skippedExisting`, chỉ bài mới được tạo; tác giả của bài cũ giữ nguyên, bài mới được chia để tổng vẫn lệch tối đa 1.
  4. `--apply --run-id agr-real-3`, rồi `timestamps-fix --run-id agr-real-3` + `psql "$DIRECT_URL" -f scripts/migrate/out/agr-real-3/timestamps-fix.sql`, rồi `verify --run-id agr-real-3`.
  5. Dựng redirect (`redirects --run-id agr-real-3 --known-routes ~/agr-private/known-routes.json`), chạy file 03 (`CLEANUP OK`), xoá khoá R2 tạm.
  - Giới hạn: lượt bù chỉ THÊM bài mới đăng (kể cả bài lúc trước là nháp nay đã đăng). Bài đã nhập mà site cũ sửa sau đó KHÔNG được cập nhật lại; bài site cũ gỡ đi vẫn còn trên Central (biên tập tự ẩn nếu cần).

## AsiaMaterialsBrief (`--tenant amb`)

- Slug Central: **`amb`** (mặc định agent điền, chủ dự án sửa được trước khi merge; plan
  delta 27-10-26). Role DB cũ: `amb_migrator`; schema view: `amb_ro`; overlay riêng:
  `~/amb-private/overlay.json`; run-id: `amb-real-1`, `amb-real-2`, ...
- Tenant tạo tay trong /admin với feature **`exhibition` BẬT** (The Exhibition dùng chung
  collection `booths` với abb; danh sách trường: `AMB_TENANT_FIELDS` trong
  `scripts/lib/amb-taxonomy.ts`, `docs/07-website-management.md`).
- File SQL Editor của amb là bản riêng: `sql/01-discover-amb.sql`,
  `sql/01b-inspect-amb-booths.sql`, `sql/02-create-readonly-role-views-amb.sql`,
  `sql/02p-set-password-amb.sql`, `sql/03-drop-role-and-views-amb.sql`. Đã chạy thử cả năm
  file trên Postgres 16 giả trong máy (27-10-26): khám phá ra đúng 1 site (2 site khớp thì
  không mô tả bài, 02 dừng `SITE STOP`), `SELF-CHECK OK`, `CLEANUP OK`; 01b: bảng thiếu in
  `missing`, cột giống bí mật chỉ in tên.
- Dòng site cũ: slug `asiamaterialsbrief`, id `149a9792-a169-47ca-b592-ea1ff1a9ea82`, tên
  AsiaMaterialsBrief (khám phá 27-10-26, DB có 14 site): 440 bài = 252 published, 164 archived
  (161 chưa từng có ngày đăng), 24 draft; created_at 08-08-26 → 27-10-26, 439/440 có phần
  micro giây khác 0, 0 trùng thời điểm; 0 slug rỗng/trùng/sai; 2.258 tag cũ (3.222 lượt, 439
  bài), không tag nào trùng 6 tag đã duyệt; 428 ảnh đại diện ở
  `mbolvnwkmkeroqmvbvmt.supabase.co`, 12 bài không ảnh (hoặc đường dẫn tương đối); 1.684 mục
  thân bài, 0 ảnh trong thân; `media_assets` của site này: 0 dòng (6.769 của mọi site) ⇒
  không có gì chuyển sang Media Engine của content engine. Giá trị section/subsection là
  SLUG (không phải tên hiển thị `?sub=`). Không có bài `intelligence`, `exhibition`,
  `events-awards`, `press-room`. Bảng danh bạ: `amb_booths` 6 dòng, `amb_booth_applications`
  1 dòng (còn `press_submissions` 1, `scraping_sources` 29: không chuyển). Kiểm trước của
  file 02: role/schema chưa có, 0 bảng PUBLIC đọc được ngoài danh sách cho phép, 0 hàm
  SECURITY DEFINER PUBLIC gọi được, không schema nào PUBLIC tạo được.
- Mapping `mappings/amb.mapping.json` **đã chốt** (chủ dự án "ok" 27-10-26, `_provisional`
  rỗng, `validate-mapping --require-final` OK):
  - chỉ chuyển bài `published` (252); `archived`/`draft`/`scheduled`/`rejected` bỏ qua. Lượt
    chạy bù trước khi chuyển tên miền lấy thêm bài site cũ đăng sau lần chạy đầu;
  - mục con cũ trùng slug giữ nguyên (`briefing/*` cả 4, `interiors-ffe/*` cả 4,
    `lighting-tech/building-systems`, `lighting-tech/lighting`, `materials/architectural`,
    `materials/surfaces`, `materials/wood-panels`, `projects/home-renovation`);
    `lighting-tech/smart-building` → `smart-building-home`; `materials/new-sustainable` →
    `new-sustainable-materials`; `projects` không mục con → pillar `projects`; mỗi pillar giữ
    dòng dự phòng `<pillar>/*` → pillar đó, không mục con;
  - `projects/design-voices` (59 bài published, tin dự án do AI viết, không phải phỏng vấn) →
    `projects` KHÔNG mục con (Design Voices để dành cho chân dung/Q&A biên tập viết);
    `projects/specified` (không có bài) cũng → `projects` không mục con, cùng lý do;
  - `press-room/*` → `press-room` không mục con (một nhà); `intelligence`, `exhibition`,
    `events-awards`: không có dòng (trang, không phải pillar; không có bài);
  - tác giả chia đều 6 người trang Team (`mode: even`, lệch tối đa 1 bài: 252 bài = 42 mỗi
    người), không giữ byline cũ; chỉ giữ 6 tag đã duyệt, bỏ hết 2.258 tag cũ (không có
    `renames`); không ảnh trong thân (`bodyImages: drop`);
  - bài cũ không chuyển → 301 về trang chuyên mục (`archivedAs: section`, như agr); thân bài
    `reflowMaxChars: 380` như AER/AGR (cùng nền tảng cũ); gốc cũ
    `https://asiamaterialsbrief.com`, bài `/article/{slug}`, chuyên mục `/briefing`,
    `/materials`, `/interiors-ffe`, `/lighting-tech`, `/projects`, `/press-room`.
- Trang cũ không có bài: mapping không sinh rule (như agr, `extraLegacyPaths` và
  `gonePaths` rỗng). `/intelligence`, `/exhibition`, `/exhibition/get-listed`,
  `/events-awards`, `/press-room-submit`, `/editorial-standards` giữ nguyên đường dẫn ở
  amb-web (không cần redirect); `/pro` → 301 `/intelligence` và `/studio` → 301 `/about`
  viết tay ở amb-web lúc cutover. Trang gian hàng cũ `/exhibition/<booth>` thuộc bước gian
  hàng riêng.
- Gian hàng (`amb_booths`, `amb_booth_applications`): NGOÀI phạm vi lượt nhập bài này, làm
  ở bước riêng sau. Chuẩn bị: `sql/01b-inspect-amb-booths.sql` (chỉ đọc, một bảng kết quả)
  in danh sách cột, số dòng của site này, và từng dòng gian hàng/đơn đăng ký dạng JSON; cột
  có tên giống email/phone/password/token/secret chỉ in TÊN, không in giá trị.
- Overlay của chủ dự án `~/amb-private/overlay.json` (ngoài repo):
  ```
  {
    "source": { "siteFilter": "149a9792-a169-47ca-b592-ea1ff1a9ea82" },
    "media": { "hostAllowlist": ["mbolvnwkmkeroqmvbvmt.supabase.co"], "hostRewrite": {} }
  }
  ```

### Các bước của chủ dự án (amb), mỗi lần một bước

Giống hệt AER ở trên, với tên amb. **Trước khi ngồi làm:** `~/apcg-cms/.env.local` phải có
đủ 4 biến R2 của bucket production (`R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`; như agr: tạo khoá R2 tạm Object Read & Write chỉ cho
`apcg-central-media`, ghi bằng `read -s`, xoá khoá khi xong). Mac cần `psql`. `HOST_CENTRAL`
(host của URL Central, từ bước 9) là chữ giữ chỗ: agent điền giá trị thật trước khi gửi
lệnh. Mỗi khối là đúng một lệnh.

1. **Khám phá** (`sql/01-discover-amb.sql`): XONG 27-10-26 (số liệu ở trên).
1b. **Xem gian hàng** (không bắt buộc cho lượt nhập bài; cho bước gian hàng sau): SQL Editor,
    chạy `sql/01b-inspect-amb-booths.sql`, "Download CSV" và gửi. Hàng `1 site` phải in
    `slug=asiamaterialsbrief`.
2. **Chốt mapping**: XONG 27-10-26.
3. **Tạo role chỉ-đọc**: SQL Editor, chạy `sql/02-create-readonly-role-views-amb.sql`. Ô kết
   quả phải là `SELF-CHECK OK` kèm số bài thấy được (440). Lỗi `... STOP ...`: không có gì
   được tạo, gửi nguyên văn dòng lỗi.
4. **Đặt mật khẩu**: chạy `sql/02p-set-password-amb.sql`. Bấm nút copy của ô `new_secret`
   (không chụp màn hình). Đóng tab truy vấn sau bước 6.
5. **Overlay riêng** trên Mac (Terminal mới trên Mac, không phải cửa sổ SSH):
   ```
   mkdir -p ~/amb-private
   ```
   ```
   chmod 700 ~/amb-private
   ```
   ```
   nano ~/amb-private/overlay.json
   ```
   Dán nội dung overlay ở trên, lưu (Ctrl+O, Enter, Ctrl+X).
6. **Đưa URL DB cũ vào Terminal** (không hiện lên màn hình):
   ```
   cd ~/apcg-cms
   ```
   ```
   read -s LEGACY_PW
   ```
   Dán mật khẩu vừa copy, Enter. Rồi:
   ```
   export LEGACY_DB_URL="postgresql://amb_migrator.mbolvnwkmkeroqmvbvmt:$LEGACY_PW@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
   ```
   Host **Session pooler, cổng 5432** (Supabase > Connect); không dùng cổng 6543.
7. **Khám phá bằng công cụ** (chỉ đọc):
   ```
   npm run migrate:network -- discover --tenant amb --site 149a9792-a169-47ca-b592-ea1ff1a9ea82 --mapping-overlay ~/amb-private/overlay.json
   ```
8. **Kiểm mapping đã chốt**:
   ```
   npm run migrate:network -- validate-mapping --tenant amb --mapping-overlay ~/amb-private/overlay.json --require-final
   ```
   Phải in `[validate-mapping] OK` và `PROVISIONAL: none`.
9. **Đưa URL Central vào Terminal** (không hiện lên màn hình):
   ```
   read -s DATABASE_URL
   ```
   Dán URL Central, Enter. Rồi:
   ```
   export DATABASE_URL
   ```
   Phải in đúng `/neondb` (khác thì dừng và báo):
   ```
   node -e 'console.log(new URL(process.env.DATABASE_URL).pathname)'
   ```
   Rồi **chạy khô** (cần thấy 252 bài sẽ tạo, 0 bài bị từ chối vì mapping; tác giả chia đều,
   42 bài mỗi người):
   ```
   npm run migrate:network -- import --tenant amb --site 149a9792-a169-47ca-b592-ea1ff1a9ea82 --mapping-overlay ~/amb-private/overlay.json --confirm-host=HOST_CENTRAL
   ```
10. **Ghi thử 50 bài**, rồi mở xem bằng mắt (đoạn văn tách đúng như site cũ, ảnh, chuyên mục):
    ```
    npm run migrate:network -- import --tenant amb --site 149a9792-a169-47ca-b592-ea1ff1a9ea82 --mapping-overlay ~/amb-private/overlay.json --apply --limit 50 --run-id amb-real-1 --confirm-host=HOST_CENTRAL
    ```
11. **Chạy toàn bộ** (Mac không ngủ). Dừng giữa chừng: chạy lại đúng lệnh này.
    ```
    caffeinate -i npm run migrate:network -- import --tenant amb --site 149a9792-a169-47ca-b592-ea1ff1a9ea82 --mapping-overlay ~/amb-private/overlay.json --apply --resume --run-id amb-real-1 --confirm-host=HOST_CENTRAL
    ```
12. **Sửa link trong bài**:
    ```
    npm run migrate:network -- rewrite-links --tenant amb --run-id amb-real-1 --apply --confirm-host=HOST_CENTRAL
    ```
13. **Sửa ngày tạo/sửa** bằng psql với URL **direct** của Neon (console.neon.tech, project
    **apcg-master-db**, **Connect**, database **neondb**, TẮT **Connection pooling**, copy):
    ```
    read -s DIRECT_URL
    ```
    ```
    export DIRECT_URL
    ```
    Phải in đúng `/neondb`; host KHÔNG có chữ `-pooler`:
    ```
    node -e 'console.log(new URL(process.env.DIRECT_URL).pathname)'
    ```
    ```
    npm run migrate:network -- timestamps-fix --tenant amb --run-id amb-real-1
    ```
    ```
    psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/migrate/out/amb-real-1/timestamps-fix.sql
    ```
14. **Kiểm 12 phép**:
    ```
    npm run migrate:network -- verify --tenant amb --site 149a9792-a169-47ca-b592-ea1ff1a9ea82 --run-id amb-real-1 --mapping-overlay ~/amb-private/overlay.json --confirm-host=HOST_CENTRAL
    ```
15. **Chạy bù trước cutover** (chủ dự án tắt pipeline cũ NGAY TRƯỚC lượt này): run-id MỚI
    (`amb-real-2`, `amb-real-3`), không `--resume` run-id cũ; chạy khô trước để xem số bài mới
    (bài đã có là `skippedExisting`, tác giả bài cũ giữ nguyên), rồi `--apply`,
    `timestamps-fix` + `psql`, `verify` với cùng run-id. Nếu đã xoá role ở bước 16 thì tạo
    lại bằng bước 3, 4, 6. Giới hạn như agr: chỉ THÊM bài mới đăng; bài đã nhập mà site cũ sửa
    sau đó không cập nhật lại.
16. **Lúc cutover**: dựng redirect từ known-routes của web (thoát mã 3 nếu có chuỗi, vòng lặp
    hoặc đích không tồn tại), rồi xoá role bằng `sql/03-drop-role-and-views-amb.sql` (ô kết quả
    `CLEANUP OK`) và xoá khoá R2 tạm. Giữ project cũ tới khi cutover xong.
    ```
    npm run migrate:network -- redirects --tenant amb --run-id amb-real-1 --known-routes ~/amb-private/known-routes.json --mapping-overlay ~/amb-private/overlay.json
    ```

Rủi ro như AER: role `amb_migrator` đọc được hai bảng pg_net (`net._http_response`,
`net.http_request_queue`); làm bước 3 tới 14 trong một lần ngồi, xoá role khi xong; role tự
hết hạn sau 14 ngày.

- Lưu ý chung (phát hiện 27-10-26 khi chạy thử): mục `8 other tables of this site` của
  `01-discover-aer.sql` / `01-discover-agr.sql` luôn để trống cột `detail`, vì
  `query_to_xml(..., tableforest => false)` bọc kết quả trong `<table>` mà xpath lại tìm
  `/row/n`. File amb dùng `/table/row/n` (đã thử).
