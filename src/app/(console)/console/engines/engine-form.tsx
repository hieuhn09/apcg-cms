"use client";
import { useActionState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/console/ui/primitives";
import { ENGINE_ACTIONS, ENGINE_TYPES } from "@/lib/constants";
import { humanize } from "@/console/lib/format";
import type { EngineFormState } from "./actions";

type Action = (prev: EngineFormState, formData: FormData) => Promise<EngineFormState>;

export interface EngineInitial {
  id?: number | string;
  name?: string;
  engineType?: string;
  status?: string;
  allowedTenants?: number[];
  allowedActions?: string[];
  rateLimitPerMin?: number;
  notes?: string;
}

export function EngineForm({
  action,
  tenants,
  initial,
  submitLabel,
  isEdit,
}: {
  action: Action;
  tenants: { id: number; name: string }[];
  initial?: EngineInitial;
  submitLabel: string;
  isEdit?: boolean;
}) {
  const [state, formAction, pending] = useActionState<EngineFormState, FormData>(action, { ok: false });
  const tenantSet = new Set(initial?.allowedTenants ?? []);
  const actionSet = new Set(initial?.allowedActions ?? []);

  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      {initial?.id != null ? <input type="hidden" name="id" value={String(initial.id)} /> : null}

      {state.error ? (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
      ) : null}
      {state.rawToken ? (
        <div className="rounded-md border border-good/40 bg-good/10 px-3 py-3 text-sm">
          <div className="font-bold text-good">Engine token — copy now, shown once:</div>
          <code className="mt-1 block break-all rounded bg-ink/90 px-2 py-1 font-mono text-xs text-paper">
            {state.rawToken}
          </code>
        </div>
      ) : null}

      {!isEdit ? (
        <Field label="Name">
          <Input name="name" defaultValue={initial?.name ?? ""} required placeholder="content-engine" />
        </Field>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Type">
          <Select name="engineType" defaultValue={initial?.engineType ?? "writer"}>
            {ENGINE_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={initial?.status ?? "active"}>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="revoked">Revoked</option>
          </Select>
        </Field>
        <Field label="Rate limit / min">
          <Input name="rateLimitPerMin" type="number" defaultValue={initial?.rateLimitPerMin ?? ""} />
        </Field>
      </div>

      <Field label="Allowed publications">
        <div className="grid grid-cols-2 gap-2 rounded-md border border-line p-3 sm:grid-cols-3">
          {tenants.map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="allowedTenants" value={t.id} defaultChecked={tenantSet.has(t.id)} />
              {t.name}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Allowed actions">
        <div className="grid grid-cols-2 gap-2 rounded-md border border-line p-3 sm:grid-cols-3">
          {ENGINE_ACTIONS.map((a) => (
            <label key={a} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="allowedActions" value={a} defaultChecked={actionSet.has(a)} />
              {humanize(a)}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Notes">
        <Textarea name="notes" rows={2} defaultValue={initial?.notes ?? ""} />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
