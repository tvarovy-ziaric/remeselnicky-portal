import React, {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

type Tone = "default" | "success" | "warning" | "error" | "trust";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Preskočiť na hlavný obsah
      </a>
      {children}
    </div>
  );
}

export function PageContainer({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={classes("page-container", className)}>{children}</div>;
}

export function PageHeader({
  actions,
  eyebrow,
  lead,
  title,
}: Readonly<{
  actions?: ReactNode;
  eyebrow?: string;
  lead?: ReactNode;
  title: string;
}>) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="ui-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {lead ? <div className="page-header__lead">{lead}</div> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHeader({
  action,
  eyebrow,
  title,
}: Readonly<{ action?: ReactNode; eyebrow?: string; title: string }>) {
  return (
    <header className="section-header">
      <div>
        {eyebrow ? <p className="ui-eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
      </div>
      {action}
    </header>
  );
}

type ButtonVariant = "primary" | "secondary" | "destructive" | "quiet";

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={classes("ui-button", `ui-button--${variant}`, className)}
      {...props}
    />
  );
}

export function ActionLink({
  children,
  className,
  href,
  variant = "primary",
}: Readonly<{
  children: ReactNode;
  className?: string;
  href: string;
  variant?: ButtonVariant;
}>) {
  return (
    <a
      className={classes("ui-button", `ui-button--${variant}`, className)}
      href={href}
    >
      {children}
    </a>
  );
}

export function Card({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <article className={classes("ui-card", className)} {...props}>
      {children}
    </article>
  );
}

export function StatCard({
  label,
  value,
}: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <Card className="stat-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </Card>
  );
}

export function StatusBadge({
  children,
  tone = "default",
}: Readonly<{ children: ReactNode; tone?: Tone }>) {
  return (
    <span className={classes("ui-badge", `ui-badge--${tone}`)}>{children}</span>
  );
}

export function TrustBadge({
  children,
  provenance,
}: Readonly<{
  children: ReactNode;
  provenance: "declared" | "evidence" | "verified";
}>) {
  const labels = {
    declared: "Uvedené remeselníkom",
    evidence: "Podložené dokladom",
    verified: "Overené platformou",
  } as const;
  return (
    <span
      className={classes("trust-badge", `trust-badge--${provenance}`)}
      title={labels[provenance]}
    >
      <span className="visually-hidden">{labels[provenance]}: </span>
      {children}
    </span>
  );
}

export function FormField({
  children,
  description,
  error,
  label,
}: Readonly<{
  children: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  label: ReactNode;
}>) {
  return (
    <label
      className={classes("form-field", Boolean(error) && "form-field--error")}
    >
      <span className="form-field__label">{label}</span>
      {children}
      {description ? (
        <span className="form-field__description">{description}</span>
      ) : null}
      {error ? <span className="form-field__error">{error}</span> : null}
    </label>
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={classes("ui-control", className)} {...props} />;
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={classes("ui-control", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={classes("ui-control", className)} {...props} />;
}

export function EmptyState({
  action,
  description,
  title,
}: Readonly<{ action?: ReactNode; description: ReactNode; title: string }>) {
  return (
    <div className="empty-state">
      <div aria-hidden="true" className="empty-state__mark">
        ·
      </div>
      <h2>{title}</h2>
      <div>{description}</div>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}

export function Notice({
  children,
  title,
  tone = "trust",
}: Readonly<{ children: ReactNode; title?: string; tone?: Tone }>) {
  return (
    <aside className={classes("ui-notice", `ui-notice--${tone}`)}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </aside>
  );
}

export function Tabs({
  items,
  label,
}: Readonly<{
  items: ReadonlyArray<{ current?: boolean; href: string; label: string }>;
  label: string;
}>) {
  return (
    <nav aria-label={label} className="ui-tabs">
      {items.map((item) => (
        <a
          aria-current={item.current ? "page" : undefined}
          href={item.href}
          key={item.href}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

export function Stepper({
  current,
  steps,
}: Readonly<{ current: number; steps: readonly string[] }>) {
  return (
    <ol aria-label="Priebeh" className="ui-stepper">
      {steps.map((step, index) => {
        const position = index + 1;
        return (
          <li
            aria-current={position === current ? "step" : undefined}
            className={position < current ? "is-complete" : undefined}
            key={step}
          >
            <span>{position}</span>
            {step}
          </li>
        );
      })}
    </ol>
  );
}

export function Timeline({
  items,
}: Readonly<{
  items: ReadonlyArray<{
    description?: ReactNode;
    label: string;
    time?: string;
  }>;
}>) {
  return (
    <ol className="ui-timeline">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`}>
          <div>
            <strong>{item.label}</strong>
            {item.description ? <div>{item.description}</div> : null}
          </div>
          {item.time ? <time>{item.time}</time> : null}
        </li>
      ))}
    </ol>
  );
}

export function NextActionCard({
  action,
  description,
  title,
}: Readonly<{ action: ReactNode; description: ReactNode; title: string }>) {
  return (
    <Card className="next-action-card">
      <p className="ui-eyebrow">Ďalší krok</p>
      <h2>{title}</h2>
      <div>{description}</div>
      <div className="next-action-card__action">{action}</div>
    </Card>
  );
}

export function SearchResultCard({
  actions,
  badges,
  facts,
  media,
  profileHref,
  reasons,
  summary,
  title,
}: Readonly<{
  actions?: ReactNode;
  badges?: ReactNode;
  facts: ReactNode;
  media?: ReactNode;
  profileHref: string;
  reasons?: ReactNode;
  summary?: ReactNode;
  title: string;
}>) {
  return (
    <Card
      className={classes(
        "search-result-card",
        !media && "search-result-card--without-media",
      )}
    >
      {media ? <div className="search-result-card__media">{media}</div> : null}
      <div className="search-result-card__body">
        <div className="search-result-card__heading">
          <div>
            <h2>
              <a href={profileHref}>{title}</a>
            </h2>
            {summary ? (
              <div className="search-result-card__summary">{summary}</div>
            ) : null}
          </div>
          {badges ? (
            <div className="search-result-card__badges">{badges}</div>
          ) : null}
        </div>
        <div className="search-result-card__facts">{facts}</div>
        {reasons ? (
          <div className="search-result-card__reasons">{reasons}</div>
        ) : null}
        <div className="search-result-card__actions">
          <ActionLink href={profileHref}>Zobraziť profil</ActionLink>
          {actions}
        </div>
      </div>
    </Card>
  );
}

export function ProfileHero({
  actions,
  description,
  eyebrow,
  facts,
  subtitle,
  title,
}: Readonly<{
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow: string;
  facts?: ReactNode;
  subtitle?: ReactNode;
  title: string;
}>) {
  return (
    <header className="profile-hero">
      <div className="profile-hero__content">
        <p className="ui-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {subtitle ? (
          <div className="profile-hero__subtitle">{subtitle}</div>
        ) : null}
        {description ? (
          <div className="profile-hero__description">{description}</div>
        ) : null}
        {facts ? <div className="profile-hero__facts">{facts}</div> : null}
      </div>
      {actions ? <div className="profile-hero__actions">{actions}</div> : null}
    </header>
  );
}
