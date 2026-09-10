---
name: ref:article-video-support-adoption
description: "How a second publication adopts article video support — files to copy, wiring, and the one CMS checkbox"
date: 10-09-26
feature: article-video-support
---

# Adopting article video support (for a second publication)

Video support is already built org-wide in `apcg-cms`. Adopting it for another
tenant needs **no apcg-cms code change** — one checkbox, plus a small, bounded
copy job in that tenant's reader repo.

## 1. Files to copy (reader repo)

Copy these two from `brief-asia-web` unchanged — neither contains any
publication-specific logic:

| File | Notes |
|---|---|
| `src/lib/article-video-view.ts` | The `ArticleVideoView` type + `toArticleVideoView()`. Pure narrowing of the object the CMS already resolved — no lookups, no fetches. |
| `src/components/article/video-player.tsx` | The player + its caption line. `preload="none"`, no autoplay. Adjust only the inline `style` object to match your own hero-figure styling. |

Then apply the **video branch** to your own hero-figure component (named
per-site, so this is a pattern rather than a literal diff):

```tsx
<figure /* your existing hero figure */>
  {video ? (
    <VideoPlayer {...video} />
  ) : (
    <>{/* your existing image / cover-art branch + its figcaption, unchanged */}</>
  )}
</figure>
```

The non-video path must stay byte-identical to what it is today.

## 2. What to wire up

1. **Types first.** Regenerate in apcg-cms (`npm run payload:generate-types`)
   and bring the video types into your reader's `payload-types.ts`. This is the
   hard ordering gate — your reader's `tsc --noEmit` will fail on `Article.video`
   until it lands. Note the reader type files are NOT byte-identical mirrors of
   the CMS one, so prefer merging in the `VideoMedia` interface + the four
   `Article.video*` fields over a wholesale overwrite.
2. **Thread one prop.** Compute `const video = toArticleVideoView(article)` in
   the article page and pass `video={video}` to your article component.
3. **Keep it off the shared list/card view type.** Do NOT add a video field to
   whatever your `ArticleView` equivalent is. That type boundary — not a
   per-card `if` — is what guarantees no listing surface can ever render or
   prefetch a video.

## 3. What the CMS side needs

Exactly one thing: flip the target tenant's **`Tenants.features.video`**
checkbox on. Either surface works and both are system-admin-only:

- the Payload admin's **Tenants** screen, or
- the `console` app's per-tenant **settings** page.

No apcg-cms code change is required — the `videoMedia` collection and the four
`Articles` video fields already exist org-wide and are gated purely by that flag
(collection-level `featureGatedAccess("video", …)`, field-level `canSetVideo`,
plus the admin field-visibility component). Editors on that tenant will then see
the video field in the article editor, and that tenant's
`/api/public/articles/[slug]` responses will carry the resolved `video` object.
