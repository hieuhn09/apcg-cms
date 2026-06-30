"use client";
import { useActionState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/console/ui/primitives";
import { humanize } from "@/console/lib/format";
import type { FormState } from "./actions";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface ArticleFormOptions {
  pillars: { id: number; title: string }[];
  authors: { id: number; name: string }[];
  statuses: string[];
}

export interface ArticleInitial {
  id?: number | string;
  title?: string;
  slug?: string;
  dek?: string;
  takeaways?: string;
  pillar?: number;
  author?: number;
  workflowStatus?: string;
}

export function ArticleForm({
  action,
  tenantSlug,
  options,
  initial,
  submitLabel,
  isEdit,
}: {
  action: Action;
  tenantSlug: string;
  options: ArticleFormOptions;
  initial?: ArticleInitial;
  submitLabel: string;
  isEdit?: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, { ok: false });

  return (
    <form action={formAction} className="max-w-3xl space-y-4">
      <input type="hidden" name="tenantSlug" value={tenantSlug} />
      {initial?.id != null ? <input type="hidden" name="id" value={String(initial.id)} /> : null}

      {state.error ? (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
      ) : null}

      <Field label="Title">
        <Input name="title" defaultValue={initial?.title ?? ""} required placeholder="Headline" />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Slug" hint="Leave blank to derive from title">
          <Input name="slug" defaultValue={initial?.slug ?? ""} placeholder="auto" />
        </Field>
        <Field label="Status">
          <Select name="workflowStatus" defaultValue={initial?.workflowStatus ?? "draft"}>
            {options.statuses.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Dek (standfirst)">
        <Input name="dek" defaultValue={initial?.dek ?? ""} placeholder="Short summary" />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Pillar">
          <Select name="pillar" defaultValue={initial?.pillar ? String(initial.pillar) : ""}>
            <option value="">— none —</option>
            {options.pillars.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Author">
          <Select name="author" defaultValue={initial?.author ? String(initial.author) : ""}>
            <option value="">— none —</option>
            {options.authors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Takeaways" hint="One per line">
        <Textarea name="takeaways" defaultValue={initial?.takeaways ?? ""} rows={3} />
      </Field>

      <Field
        label="Body (Markdown)"
        hint={isEdit ? "Leave blank to keep the current body; enter Markdown to replace it." : "Markdown — converted to the CMS rich-text format on save."}
      >
        <Textarea name="body" defaultValue="" rows={14} placeholder={"## Section\n\nWrite the story in Markdown..."} />
      </Field>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
