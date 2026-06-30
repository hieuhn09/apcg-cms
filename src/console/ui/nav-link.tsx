"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../lib/cn";

export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={cn(
        "block truncate rounded-md px-3 py-2 text-sm font-medium",
        active ? "bg-accent text-white" : "text-ink hover:bg-line/60",
      )}
    >
      {children}
    </Link>
  );
}

/** Horizontal tab link for per-section sub-navigation. */
export function TabLink({ href, exact, children }: { href: string; exact?: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={cn(
        "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold",
        active ? "border-accent text-accent" : "border-transparent text-muted hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
