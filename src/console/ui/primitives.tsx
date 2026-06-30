/**
 * Minimal Tailwind UI kit for the console. Presentational only (server-safe);
 * interactive behavior is added by client parents. Colors come from the @theme
 * tokens in (console)/globals.css (bg-panel, text-muted, border-line, …).
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import Link from "next/link";
import { cn } from "../lib/cn";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-lg border border-line bg-panel", className)}>{children}</div>;
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <h2 className="text-xs font-extrabold uppercase tracking-wider text-muted">{title}</h2>
      {action}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

type BadgeTone = "default" | "good" | "warn" | "bad" | "muted" | "accent";
const badgeTone: Record<BadgeTone, string> = {
  default: "bg-line/60 text-ink",
  good: "bg-good/12 text-good",
  warn: "bg-warn/12 text-warn",
  bad: "bg-bad/12 text-bad",
  muted: "bg-line/40 text-muted",
  accent: "bg-accent/12 text-accent",
};

export function Badge({ tone = "default", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold", badgeTone[tone])}>
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const buttonVariant: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:opacity-90 border-accent",
  secondary: "bg-panel text-accent border-accent hover:bg-accent/5",
  ghost: "bg-transparent text-ink border-transparent hover:bg-line/50",
  danger: "bg-bad text-white border-bad hover:opacity-90",
};

const buttonBase =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed";

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button className={cn(buttonBase, buttonVariant[variant], className)} {...props} />;
}

export function ButtonLink({
  href,
  variant = "secondary",
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={cn(buttonBase, buttonVariant[variant], className)}>
      {children}
    </Link>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="text-xs font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-2xl font-extrabold text-ink">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

/** Simple horizontal bar list (no chart library). */
export function BarList({ items }: { items: { label: string; value: number; tone?: BadgeTone }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const toneBg: Record<BadgeTone, string> = {
    default: "bg-accent",
    good: "bg-good",
    warn: "bg-warn",
    bad: "bg-bad",
    muted: "bg-muted",
    accent: "bg-accent",
  };
  if (!items.length) return <EmptyState>No data</EmptyState>;
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => (
        <div key={it.label} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-2 text-sm">
          <span className="truncate text-muted">{it.label}</span>
          <span className="h-2 rounded-full bg-line/60">
            <span
              className={cn("block h-2 rounded-full", toneBg[it.tone ?? "accent"])}
              style={{ width: `${Math.round((it.value / max) * 100)}%` }}
            />
          </span>
          <span className="text-right font-semibold tabular-nums">{it.value}</span>
        </div>
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">{children}</div>;
}

/* ── Table ─────────────────────────────────────────────────────────────── */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-panel">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}
export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-line bg-line/30 text-left text-xs uppercase tracking-wider text-muted">{children}</thead>;
}
export function TH({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn("px-3 py-2 font-bold", className)}>{children}</th>;
}
export function TR({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn("border-b border-line/70 last:border-0", className)}>{children}</tr>;
}
export function TD({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2 align-middle", className)}>{children}</td>;
}

/* ── Form fields ───────────────────────────────────────────────────────── */
const fieldBase =
  "w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />;
}
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-32 font-mono text-xs leading-relaxed", className)} {...props} />;
}
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldBase, className)} {...props}>
      {children}
    </select>
  );
}
