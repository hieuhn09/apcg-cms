"use client";
import { useActionState } from "react";
import { Button, Field, Input, Select } from "@/console/ui/primitives";
import { USER_ROLES, MEMBERSHIP_ROLES } from "@/lib/constants";
import { humanize } from "@/console/lib/format";
import {
  createUserAction,
  updateUserAction,
  setPasswordAction,
  addMembershipAction,
  type UserFormState,
} from "./actions";

function Banner({ state }: { state: UserFormState }) {
  if (state.error) return <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>;
  if (state.ok) return <div className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">Saved.</div>;
  return null;
}

export function UserCreateForm() {
  const [state, formAction, pending] = useActionState<UserFormState, FormData>(createUserAction, { ok: false });
  return (
    <form action={formAction} className="space-y-3">
      <Banner state={state} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" required />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" required />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" required />
        </Field>
        <Field label="Role">
          <Select name="role" defaultValue="standard">
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create user"}
      </Button>
    </form>
  );
}

export function UserEditForm({ id, name, role }: { id: number | string; name: string; role: string }) {
  const [state, formAction, pending] = useActionState<UserFormState, FormData>(updateUserAction, { ok: false });
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="id" value={String(id)} />
      <Banner state={state} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" defaultValue={name} required />
        </Field>
        <Field label="Global role">
          <Select name="role" defaultValue={role}>
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export function PasswordReset({ id }: { id: number | string }) {
  const [state, formAction, pending] = useActionState<UserFormState, FormData>(setPasswordAction, { ok: false });
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={String(id)} />
      <div className="grow">
        <Field label="New password">
          <Input name="password" type="password" />
        </Field>
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "…" : "Set password"}
      </Button>
      {state.ok ? <span className="text-sm text-good">Updated.</span> : null}
      {state.error ? <span className="text-sm text-bad">{state.error}</span> : null}
    </form>
  );
}

export function AddMembershipForm({
  id,
  tenants,
}: {
  id: number | string;
  tenants: { id: number; name: string }[];
}) {
  return (
    <form action={addMembershipAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={String(id)} />
      <div>
        <Field label="Publication">
          <Select name="tenant" required defaultValue="">
            <option value="">— select —</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div>
        <Field label="Role">
          <Select name="role" defaultValue="editor">
            {MEMBERSHIP_ROLES.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="canPublish" /> Can publish
      </label>
      <Button type="submit" variant="secondary">
        Add
      </Button>
    </form>
  );
}
