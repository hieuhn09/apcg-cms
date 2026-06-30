"use client";
import { useActionState } from "react";
import { Button } from "@/console/ui/primitives";
import { rotateEngineTokenAction, type EngineFormState } from "./actions";

export function TokenRotate({ engineId }: { engineId: number | string }) {
  const [state, formAction, pending] = useActionState<EngineFormState, FormData>(rotateEngineTokenAction, { ok: false });
  return (
    <div className="space-y-3">
      {state.error ? (
        <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>
      ) : null}
      {state.rawToken ? (
        <div className="rounded-md border border-good/40 bg-good/10 px-3 py-3 text-sm">
          <div className="font-bold text-good">New token — copy now, shown once:</div>
          <code className="mt-1 block break-all rounded bg-ink/90 px-2 py-1 font-mono text-xs text-paper">
            {state.rawToken}
          </code>
        </div>
      ) : null}
      <form action={formAction}>
        <input type="hidden" name="id" value={String(engineId)} />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Rotating…" : "Rotate token"}
        </Button>
      </form>
    </div>
  );
}
