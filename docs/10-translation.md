# Translation

## Model

Built on Payload native field localization (localized: title, slug, dek, body,
imageLabel) plus a status sidecar and a job queue:

- `Articles.sourceLanguage` — the locale the article is authored in.
- `Articles.translationStatus[]` — one row per target locale:
  `{ locale, state, engine, sourceVersionAtTranslation, updatedAt }`.
- `translationJobs` — the queue (per tenant, feature-gated by `translations`).

### States

`none → pending → translating → machine_translated → needs_review → approved →
locked`. Plus `outdated` (source changed) and `failed`. **approved** and
**locked** are protected — never auto-overwritten.

## Process

1. **Source published** → `enqueueTranslations` computes targets =
   `tenant.supportedLanguages − sourceLanguage`, creates a `translationJob(queued,
   sourceVersion)` for each non-protected, not-up-to-date target, and sets that
   locale's `state = pending`. Idempotent (one job per article × locale ×
   sourceVersion).
2. **Translation engine** (identity with action `create_translation`) claims work:
   `GET /api/engine/translation?publicationId=…` → queued jobs.
3. Engine returns a result: `POST /api/engine/translation { articleId, locale,
   fields:{title,dek,body_markdown} }`. The CMS writes the localized fields **for
   that locale only**, sets `state = machine_translated`, records
   `sourceVersionAtTranslation`, and completes the job. A request targeting an
   `approved`/`locked` locale returns **409** and writes nothing.
4. **Editor reviews** in admin (locale switcher) and sets `state = approved` (or
   `locked`).
5. **Frontend reads** the stored translation for the requested locale. Translation
   never happens on a reader request.
6. **Source changes** → non-protected targets are flagged `outdated`
   (`articleBookkeeping`), re-queued on the next publish.

## When to use which method

- **Machine translation (translation engine):** default for all supported target
  languages. Fast, cheap, stored once.
- **AI editing / human review:** promote important languages to `needs_review` →
  editor approves (`approved`). Use for flagship pieces and primary markets.
- **Lock (`locked`):** for legally-sensitive or finalized copy that must never be
  re-touched by automation.

## Avoiding unnecessary re-translation

- Jobs are keyed by `(article, targetLocale, sourceVersion)` — re-publishing
  without a content change does not create new jobs.
- `machine_translated`/`needs_review` rows whose `sourceVersionAtTranslation`
  matches the current version are skipped.
- `approved`/`locked` are never re-queued automatically.

## Protecting approved translations

The enqueue hook skips protected states; the translation result endpoint refuses
(409) to overwrite a protected locale. The only way to change an approved/locked
translation is a human edit in admin.

## Strategy recommendation

- Translate the **primary** languages immediately on publish (machine).
- Translate the rest on demand or in a batch.
- Use **human review** only for important articles / primary markets.
- Ordinary articles can stay machine-translated.
