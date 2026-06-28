# Roles & Permissions

Two layers enforce access:

1. **`@payloadcms/plugin-multi-tenant`** scopes *which tenants* an admin session
   may touch (a tenant selector + auto-filtered list views). It reads tenant
   access from the `tenants` array on the Users collection (each row =
   `{ tenant, roles[], canPublish }`).
2. **Collection + field `access` functions** (`src/access/`) encode *what each
   role may do*, on top of that tenant scoping. `isSystemAdmin(req)` is the
   first-line bypass.

Machine (engine) and public (frontend) traffic do **not** authenticate as a
Payload user — they use route handlers with explicit tenant filters
(`src/lib/scoped.ts`), so the plugin's admin scoping never applies to them.

## Role matrix

| Role | Scope | Can | Cannot |
|---|---|---|---|
| **System Admin** | All tenants | Everything: provision tenants, manage global users/engines/countries, all content, all config | — |
| **Website Admin** | Assigned tenant(s) | Manage own-tenant content, taxonomy, media, menus; edit own-tenant brand/SEO/contact; delete own-tenant content; publish | Provision tenants, manage engines or global reference data, edit protected tenant fields (domain/status/languages/features/engines), see other tenants |
| **Editor** | Assigned tenant(s) | Create/edit/submit, publish/schedule, edit translations, manage taxonomy & media | System config, manage memberships, cross-tenant |
| **Contributor** | Assigned tenant(s) | Create drafts; edit articles they authored or are assigned to | Self-publish unless `canPublish` granted (limited to `draft`/`pending_review`); config |
| **Content Engine** | `allowedTenants` only | Send/update content within `allowedActions` | Anything outside allowed tenants/actions; overwrite human-locked or human-edited fields; publish directly (creates `pending_review`) |
| **Frontend** | Own tenant only | Read **published** content + menus + site settings via read token; draft via signed preview token | Drafts without a preview token, any write, other tenants |

## How publish authority is enforced

The article `workflowStatus` field is governed by:
- collection-level access (who can update the article at all), plus
- a `beforeValidate` value rule (`enforceStatusAuthority` in
  `src/hooks/article-workflow.ts`): a contributor without `canPublish` may only
  set `draft` or `pending_review`. Editors/Website Admins/System Admins may set
  any status.

## Engine-managed fields

`origin`, `editedByHuman`, `version`, `engineSourceUrl/Name/Context`, `lastEngine`,
`processingVersion` are read-only in admin (set by the system / intake handler).
`editedByHuman` flips true on any human write (bookkeeping hook); the intake
handler refuses to overwrite a human-edited or locked field.

## Memberships note (deviation from a separate collection)

Tenant membership + per-tenant role + `canPublish` live on the plugin-native
`Users.tenants` array — not a separate `tenant-memberships` collection — to avoid
two sources of truth for "who can access which tenant." Trade-off: a Website Admin
editing a user sees that user's full tenant list. Acceptable for MVP; revisit if
cross-tenant roster privacy becomes a requirement. (For MVP, user/membership
management is a System Admin function.)
