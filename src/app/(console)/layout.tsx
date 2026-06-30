import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { requireUser, isAdmin } from "@/console/auth";
import { listTenants } from "@/console/data/tenants";
import { NavLink } from "@/console/ui/nav-link";
import { Badge } from "@/console/ui/primitives";

export const metadata: Metadata = { title: "Central CMS Console" };

// Auth + live data on every console request.
export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const admin = isAdmin(user);
  const tenants = await listTenants(user);
  const profile = user as { email?: string; name?: string };

  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
            <div className="border-b border-line px-4 py-4">
              <div className="font-serif text-lg font-bold text-accent">Central CMS</div>
              <div className="text-xs font-bold uppercase tracking-wider text-muted">Console</div>
            </div>

            <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
              <div className="space-y-1">
                <NavLink href="/console" exact>
                  Overview
                </NavLink>
              </div>

              <div>
                <div className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">Publications</div>
                <div className="space-y-1">
                  {tenants.map((t) => (
                    <NavLink key={t.id} href={`/console/sites/${t.slug}`}>
                      {t.name}
                    </NavLink>
                  ))}
                  {tenants.length === 0 ? <div className="px-3 py-2 text-xs text-muted">No publications</div> : null}
                </div>
              </div>

              {admin ? (
                <div>
                  <div className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">System</div>
                  <div className="space-y-1">
                    <NavLink href="/console/users">Users</NavLink>
                    <NavLink href="/console/engines">Content Engines</NavLink>
                  </div>
                </div>
              ) : null}
            </nav>

            <div className="border-t border-line px-4 py-3 text-xs">
              <div className="truncate font-semibold text-ink">{profile.name || profile.email || "Signed in"}</div>
              <div className="mt-1 flex items-center justify-between">
                <Badge tone={admin ? "accent" : "muted"}>{admin ? "System Admin" : "Member"}</Badge>
                <Link href="/admin/logout" className="text-muted underline hover:text-ink">
                  Sign out
                </Link>
              </div>
              <Link href="/admin" className="mt-2 block text-muted underline hover:text-ink">
                Open Payload admin →
              </Link>
            </div>
          </aside>

          <main className="min-w-0 flex-1 p-6 lg:p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
