"use client";
import { useActionState } from "react";
import { Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Textarea } from "@/console/ui/primitives";
import type { CollectionDef } from "@/console/data/collection-config";
import { createItemAction, deleteItemAction, type FormState } from "./collection-actions";

export interface ManagedItem {
  id: number | string;
  title: string;
  sub?: string;
}

export function CollectionManager({
  def,
  tenantSlug,
  items,
}: {
  def: CollectionDef;
  tenantSlug: string;
  items: ManagedItem[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createItemAction, { ok: false });

  return (
    <Card>
      <CardHeader title={def.plural} />
      <CardBody className="space-y-4">
        {items.length === 0 ? (
          <EmptyState>No {def.plural.toLowerCase()} yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-line/70 rounded-md border border-line">
            {items.map((it) => (
              <li key={String(it.id)} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-semibold">{it.title}</span>
                  {it.sub ? <span className="ml-2 text-muted">{it.sub}</span> : null}
                </span>
                <form action={deleteItemAction}>
                  <input type="hidden" name="tenantSlug" value={tenantSlug} />
                  <input type="hidden" name="collection" value={def.slug} />
                  <input type="hidden" name="id" value={String(it.id)} />
                  <button type="submit" className="text-xs font-semibold text-bad hover:underline">
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form action={formAction} className="space-y-3 border-t border-line pt-4">
          <input type="hidden" name="tenantSlug" value={tenantSlug} />
          <input type="hidden" name="collection" value={def.slug} />
          {state.error ? (
            <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {def.fields.map((f) => (
              <div key={f.name} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
                <Field label={f.label + (f.required ? " *" : "")}>
                  {f.type === "textarea" ? (
                    <Textarea name={f.name} rows={2} placeholder={f.placeholder} />
                  ) : (
                    <Input name={f.name} type={f.type === "number" ? "number" : "text"} placeholder={f.placeholder} />
                  )}
                </Field>
              </div>
            ))}
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : `Add ${def.singular.toLowerCase()}`}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
