## Inventory

| table | columns | site-scoped rows | key columns | has created_at |
|---|---|---|---|---|
| articles | 35 | 300 | id | true |
| sites | 5 | 1 | id | false |
| site_authors | 6 | 5 | slug | false |
| media_assets | 13 | 5 | storage_path | false |
| scraping_sources | 10 | 5 | feed_url | false |
| gtp_subscribers | 5 | 16 | email | true |
| visa_rules | 15 | 30 | country_code | true |
| events | 11 | 15 | id | false |
| press_submissions | 10 | 6 | contact_email, title | true |
