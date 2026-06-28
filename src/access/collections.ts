/**
 * Preset access bundles for tenant-scoped collections, composed from the
 * factories in helpers.ts. Two shapes cover almost everything:
 *
 *   editorialContentAccess — Articles-like: contributors may edit rows they own
 *     (author / assignedTo); editors+ edit anything in their tenant.
 *   tenantManagedAccess — taxonomy / config / media: editors+ create & edit
 *     anything in their tenant; no per-row ownership.
 *
 * All reads are tenant-scoped (members see only their tenants); System Admin
 * bypasses everything. Public/engine traffic does NOT come through these — it
 * uses overrideAccess via the scoped helpers.
 */

import type { Access, PayloadRequest, Where } from "payload";
import {
  isSystemAdmin,
  readOwnTenants,
  createInWritableTenants,
  deleteInAdminTenants,
  updateEditorialContent,
  tenantIdsWithRole,
} from "@/access/helpers";

function updateInEditorTenants(req: PayloadRequest): boolean | Where {
  if (isSystemAdmin(req)) return true;
  const ids = tenantIdsWithRole(req, ["websiteAdmin", "editor"]);
  return ids.length ? { tenant: { in: ids } } : false;
}

export const editorialContentAccess: {
  read: Access;
  create: Access;
  update: Access;
  delete: Access;
} = {
  read: ({ req }) => readOwnTenants(req),
  create: ({ req }) => createInWritableTenants(req),
  update: ({ req }) => updateEditorialContent(req),
  delete: ({ req }) => deleteInAdminTenants(req),
};

export const tenantManagedAccess: {
  read: Access;
  create: Access;
  update: Access;
  delete: Access;
} = {
  read: ({ req }) => readOwnTenants(req),
  create: ({ req }) => (isSystemAdmin(req) ? true : updateInEditorTenants(req)),
  update: ({ req }) => updateInEditorTenants(req),
  delete: ({ req }) => deleteInAdminTenants(req),
};
