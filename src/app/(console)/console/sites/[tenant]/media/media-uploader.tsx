"use client";
import { useActionState } from "react";
import { Button, Field, Input } from "@/console/ui/primitives";
import { uploadMediaAction, type FormState } from "./actions";

export function MediaUploader({ tenantSlug }: { tenantSlug: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(uploadMediaAction, { ok: false });
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="tenantSlug" value={tenantSlug} />
      {state.error ? (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
      ) : null}
      <Field label="Image file">
        <Input name="file" type="file" accept="image/*" required />
      </Field>
      <Field label="Alt text" hint="Required for accessibility">
        <Input name="alt" placeholder="Describe the image" />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Uploading…" : "Upload"}
      </Button>
    </form>
  );
}
