"use client";
import { useActionState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/console/ui/primitives";
import { createCorrectionAction, type FormState } from "./actions";

export function CorrectionForm({
  tenantSlug,
  articles,
}: {
  tenantSlug: string;
  articles: { id: number; title: string }[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createCorrectionAction, { ok: false });
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="tenantSlug" value={tenantSlug} />
      {state.error ? (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
      ) : null}
      <Field label="Article *">
        <Select name="article" required defaultValue="">
          <option value="">— select —</option>
          {articles.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Summary *">
        <Input name="summary" placeholder="What was corrected" />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Was">
          <Textarea name="wasText" rows={2} />
        </Field>
        <Field label="Now">
          <Textarea name="nowText" rows={2} />
        </Field>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add correction"}
      </Button>
    </form>
  );
}
