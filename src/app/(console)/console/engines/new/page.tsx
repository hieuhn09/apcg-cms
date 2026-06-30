import { requireSystemAdmin } from "@/console/auth";
import { listTenants } from "@/console/data/tenants";
import { PageHeader } from "@/console/ui/primitives";
import { EngineForm } from "../engine-form";
import { createEngineAction } from "../actions";

export default async function NewEnginePage() {
  const user = await requireSystemAdmin();
  const tenants = await listTenants(user);

  return (
    <div>
      <PageHeader title="Register content engine" description="Create a machine credential with scoped tenants + actions." />
      <EngineForm
        action={createEngineAction}
        tenants={tenants.map((t) => ({ id: t.id, name: t.name }))}
        submitLabel="Create engine"
      />
    </div>
  );
}
