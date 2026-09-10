"use client";

/**
 * VideoFieldGate — renders an Articles video field ONLY when the currently
 * selected admin tenant has the `video` feature enabled.
 *
 * Why a custom component and not `admin.condition`: `condition(data,
 * siblingData, { user, operation })` is synchronous and is handed no tenant
 * feature state, so it cannot answer "is video on for the tenant I am editing
 * as?" without a stale cached boolean baked into the admin bundle. The selected
 * tenant is client state (the multi-tenant plugin's selection provider, backed
 * by the `payload-tenant` cookie), so the check has to happen client-side, live.
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
import { TextField, UploadField } from "@payloadcms/ui";
import { useTenantSelection } from "@payloadcms/plugin-multi-tenant/client";
import type {
  TextFieldClientComponent,
  UploadFieldClientComponent,
} from "payload";

/** Cookie fallback for the selected tenant id.
 *
 * Defensive only: `useTenantSelection()` is the intended source and is exported
 * by the plugin at the pinned version. This covers the case where a custom Field
 * component ends up rendered outside the selection provider's React context, in
 * which case the hook throws or yields `undefined`. Same cookie the plugin's own
 * server-side `getTenantFromCookie` reads. */
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

function useSelectedTenantId(): number | string | undefined {
  let fromHook: number | string | undefined;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    fromHook = useTenantSelection()?.selectedTenantID;
  } catch {
    fromHook = undefined;
  }
  const [fromCookie, setFromCookie] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (fromHook == null) setFromCookie(tenantIdFromCookie());
  }, [fromHook]);
  return fromHook ?? fromCookie;
}

/** null = unknown/loading (hidden), true/false = resolved. */
function useVideoFeature(): boolean | null {
  const tenantId = useSelectedTenantId();
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
