"use client";
import { useActionState } from "react";
import { Button, Card, CardBody, CardHeader, Field, Input, Select } from "@/console/ui/primitives";
import { FEATURE_KEYS, type FeatureKey } from "@/lib/constants";
import { humanize } from "@/console/lib/format";
import { updateSettingsAction, type FormState } from "./actions";

export interface SettingsInitial {
  frontendUrl: string;
  brandColor: string;
  seoTitleSuffix: string;
  seoTwitterHandle: string;
  contactGeneralEmail: string;
  contactEditorialEmail: string;
  contactAdvertisingEmail: string;
  status: string;
  features: Record<FeatureKey, boolean>;
}

export function SettingsForm({
  tenantSlug,
  admin,
  initial,
}: {
  tenantSlug: string;
  admin: boolean;
  initial: SettingsInitial;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(updateSettingsAction, { ok: false });

  return (
    <form action={formAction} className="max-w-2xl space-y-6">
      <input type="hidden" name="tenantSlug" value={tenantSlug} />

      {state.error ? (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
      ) : null}
      {state.ok ? (
        <div className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">Saved.</div>
      ) : null}

      <Card>
        <CardHeader title="Brand & integration" />
        <CardBody className="space-y-4">
          <Field label="Frontend URL" hint="Where revalidate webhooks are sent">
            <Input name="frontendUrl" defaultValue={initial.frontendUrl} placeholder="https://example.com" />
          </Field>
          <Field label="Brand color">
            <Input name="brandColor" defaultValue={initial.brandColor} placeholder="#a60f2d" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="SEO title suffix">
              <Input name="seoTitleSuffix" defaultValue={initial.seoTitleSuffix} />
            </Field>
            <Field label="Twitter handle">
              <Input name="seoTwitterHandle" defaultValue={initial.seoTwitterHandle} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="General email">
              <Input name="contactGeneralEmail" defaultValue={initial.contactGeneralEmail} />
            </Field>
            <Field label="Editorial email">
              <Input name="contactEditorialEmail" defaultValue={initial.contactEditorialEmail} />
            </Field>
            <Field label="Advertising email">
              <Input name="contactAdvertisingEmail" defaultValue={initial.contactAdvertisingEmail} />
            </Field>
          </div>
        </CardBody>
      </Card>

      {admin ? (
        <Card>
          <CardHeader title="Features & status (system admin)" />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {FEATURE_KEYS.map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={`feature_${k}`} defaultChecked={initial.features[k]} />
                  {humanize(k)}
                </label>
              ))}
            </div>
            <Field label="Status">
              <Select name="status" defaultValue={initial.status}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="archived">Archived</option>
              </Select>
            </Field>
          </CardBody>
        </Card>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
