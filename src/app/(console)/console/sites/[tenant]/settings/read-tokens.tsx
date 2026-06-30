"use client";
import { useActionState } from "react";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input } from "@/console/ui/primitives";
import { mintReadTokenAction, revokeReadTokenAction, type TokenFormState } from "./token-actions";

export interface ReadTokenRow {
  label: string;
  prefix: string;
  status: string;
}

export function ReadTokens({ tenantSlug, tokens }: { tenantSlug: string; tokens: ReadTokenRow[] }) {
  const [state, formAction, pending] = useActionState<TokenFormState, FormData>(mintReadTokenAction, { ok: false });
  return (
    <Card>
      <CardHeader title="Read tokens (frontend)" />
      <CardBody className="space-y-4">
        {state.error ? (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
        ) : null}
        {state.rawToken ? (
          <div className="rounded-md border border-good/40 bg-good/10 px-3 py-3 text-sm">
            <div className="font-bold text-good">Read token — copy now, shown once:</div>
            <code className="mt-1 block break-all rounded bg-ink/90 px-2 py-1 font-mono text-xs text-paper">
              {state.rawToken}
            </code>
          </div>
        ) : null}

        {tokens.length === 0 ? (
          <EmptyState>No read tokens. Mint one for the frontend.</EmptyState>
        ) : (
          <ul className="divide-y divide-line/70 rounded-md border border-line">
            {tokens.map((t) => (
              <li key={t.prefix} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className="font-semibold">{t.label}</span>
                  <code className="font-mono text-xs text-muted">{t.prefix}…</code>
                  <Badge tone={t.status === "active" ? "good" : "muted"}>{t.status}</Badge>
                </span>
                {t.status === "active" ? (
                  <form action={revokeReadTokenAction}>
                    <input type="hidden" name="tenantSlug" value={tenantSlug} />
                    <input type="hidden" name="prefix" value={t.prefix} />
                    <button type="submit" className="text-xs font-semibold text-bad hover:underline">
                      Revoke
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <form action={formAction} className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
          <input type="hidden" name="tenantSlug" value={tenantSlug} />
          <div className="grow">
            <Field label="Label">
              <Input name="label" placeholder="frontend" />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Minting…" : "Mint read token"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
