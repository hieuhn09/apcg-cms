"use client";

/**
 * VideoFieldGate — renders an Articles video field ONLY when the tenant that
 * OWNS THE ARTICLE BEING EDITED has the `video` feature enabled.
 *
 * Why a custom component and not `admin.condition`: `condition(data,
 * siblingData, { user, operation })` is synchronous and is handed no tenant
 * feature state, so it cannot answer "is video on for this article's tenant?"
 * without a stale cached boolean baked into the admin bundle. Feature flags are
 * per-tenant rows that change at runtime, so the check has to happen
 * client-side, live.
 *
 * TENANT RESOLUTION ORDER (this is the whole point — see the note below):
 *   1. the article's OWN `tenant` field, read out of form state
 *   2. the admin's currently-selected tenant (multi-tenant selection provider)
 *   3. the `payload-tenant` cookie
 *
 * (1) must come first. An earlier version started at (2), which is the tenant
 * the admin is BROWSING AS, not the tenant the open document belongs to. Those
 * differ in a state the plugin treats as completely normal: a user with more
 * than one tenant option and no `payload-tenant` cookie gets
 * `selectedTenantID === undefined` and the provider deliberately does not
 * auto-select one ("users with multiple tenants can clear the tenant
 * selection" — TenantSelectionProvider/index.client.js). In that state the old
 * order resolved no tenant at all and the fields stayed hidden forever on a
 * document whose tenant genuinely has video enabled.
 *
 * This is the UI half of Criterion 2 only. The API half is enforced
 * independently by the `canSetVideo` field access function in Articles.ts — a
 * tenant without the flag cannot write these fields even if this component is
 * bypassed, and neither mechanism depends on the other.
 *
 * FAIL CLOSED: state starts `null` (hidden) and only flips to visible on a
 * confirmed `true`. That means a brief flash of NOTHING while the feature fetch
 * is in flight, which is deliberate — do not "fix" it by defaulting to visible,
 * that would leak the field to every tenant for the duration of the fetch.
 */

import { useEffect, useState } from "react";
import { TextField, UploadField, useFormFields } from "@payloadcms/ui";
import { useTenantSelection } from "@payloadcms/plugin-multi-tenant/client";
import type {
  TextFieldClientComponent,
  UploadFieldClientComponent,
} from "payload";

/**
 * Name of the relationship field the multi-tenant plugin injects into every
 * tenant-scoped collection. This is the plugin's default (`defaults.js`
 * → `tenantFieldName: 'tenant'`) and payload.config.ts does not override it, so
 * the form-state path for an Articles document is exactly `tenant`.
 */
const TENANT_FIELD_NAME = "tenant";

/**
 * Normalize a relationship field's form-state value to a bare id.
 *
 * Form state usually carries the raw id for a single-relationTo field, but a
 * depth-populated value (`{ id, ... }`) and the polymorphic shape
 * (`{ relationTo, value }`) both show up depending on how the document was
 * loaded. Unwrap exactly one level — no recursion, so a self-referencing object
 * cannot spin.
 */
function toTenantId(value: unknown): number | string | undefined {
  const unwrapped =
    value !== null && typeof value === "object"
      ? ((value as { id?: unknown; value?: unknown }).id ??
        (value as { id?: unknown; value?: unknown }).value)
      : value;
  if (typeof unwrapped === "number") return unwrapped;
  if (typeof unwrapped === "string") return unwrapped === "" ? undefined : unwrapped;
  return undefined;
}

/** Cookie fallback for the selected tenant id — last resort only.
 *
 * Same cookie the plugin's own server-side `getTenantFromCookie` reads, and the
 * same value the injected `tenant` field uses as its create-view defaultValue,
 * so on the create view this agrees with (1) rather than fighting it. */
function tenantIdFromCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith("payload-tenant="))
    ?.slice("payload-tenant=".length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    return raw;
  }
}

/**
 * The tenant whose feature flags govern this field.
 *
 * `useTenantSelection()` is `React.use(Context)` over a context created with a
 * concrete default value, so it returns `{ selectedTenantID: undefined, ... }`
 * outside the provider rather than throwing — no try/catch needed, and calling
 * it unconditionally keeps hook order stable.
 */
function useGateTenantId(): number | string | undefined {
  const fromDoc = useFormFields(([fields]) =>
    toTenantId(fields?.[TENANT_FIELD_NAME]?.value),
  );
  const fromSelection = useTenantSelection()?.selectedTenantID;

  const [fromCookie, setFromCookie] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (fromDoc == null && fromSelection == null) {
      setFromCookie(tenantIdFromCookie());
    }
  }, [fromDoc, fromSelection]);

  return fromDoc ?? fromSelection ?? fromCookie;
}

/** null = unknown/loading (hidden), true/false = resolved. */
function useVideoFeature(): boolean | null {
  const tenantId = useGateTenantId();
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (tenantId == null) {
      setEnabled(null);
      return;
    }
    let cancelled = false;
    setEnabled(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/tenants/${encodeURIComponent(String(tenantId))}?depth=0`,
          { credentials: "include" },
        );
        if (!res.ok) throw new Error(`tenants fetch failed: ${res.status}`);
        const doc: unknown = await res.json();
        const features = (doc as { features?: Record<string, unknown> } | null)?.features;
        if (!cancelled) setEnabled(Boolean(features?.video));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return enabled;
}

export const VideoUploadFieldGate: UploadFieldClientComponent = (props) => {
  const enabled = useVideoFeature();
  if (enabled !== true) return null;
  return <UploadField {...props} />;
};

export const VideoTextFieldGate: TextFieldClientComponent = (props) => {
  const enabled = useVideoFeature();
  if (enabled !== true) return null;
  return <TextField {...props} />;
};
