import { notFound } from "next/navigation";
import { requireSystemAdmin } from "@/console/auth";
import { getDoc } from "@/console/data/payload";
import { listTenants } from "@/console/data/tenants";
import { Card, CardBody, CardHeader, PageHeader } from "@/console/ui/primitives";
import { EngineForm } from "../engine-form";
import { TokenRotate } from "../token-rotate";
import { updateEngineAction } from "../actions";

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "object" && v ? Number((v as { id?: unknown }).id) : Number(v)))
    .filter((n) => !Number.isNaN(n));
}

export default async function EditEnginePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSystemAdmin();
  const [doc, tenants] = await Promise.all([getDoc("content-engines", id, user, { depth: 0 }), listTenants(user)]);
  if (!doc) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title={String(doc.name ?? "Engine")} description={`Token ${doc.tokenPrefix ? `${doc.tokenPrefix}…` : "—"}`} />

      <Card>
        <CardHeader title="Configuration" />
        <CardBody>
          <EngineForm
            action={updateEngineAction}
            isEdit
            tenants={tenants.map((t) => ({ id: t.id, name: t.name }))}
            initial={{
              id: doc.id,
              name: String(doc.name ?? ""),
              engineType: String(doc.engineType ?? "writer"),
              status: String(doc.status ?? "active"),
              allowedTenants: ids(doc.allowedTenants),
              allowedActions: Array.isArray(doc.allowedActions) ? (doc.allowedActions as string[]) : [],
              rateLimitPerMin: typeof doc.rateLimitPerMin === "number" ? doc.rateLimitPerMin : undefined,
              notes: typeof doc.notes === "string" ? doc.notes : "",
            }}
            submitLabel="Save engine"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Token" />
        <CardBody>
          <p className="mb-3 text-sm text-muted">
            Rotating immediately invalidates the old token. Update the engine&apos;s configuration with the new value.
          </p>
          <TokenRotate engineId={doc.id} />
        </CardBody>
      </Card>
    </div>
  );
}
