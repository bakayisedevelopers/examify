import { Logo } from './Logo';

export const SectionHeader = ({ eyebrow, title, description, action, showLogo = false }) => (
  <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
    <div>
      {eyebrow ? <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">{eyebrow}</p> : null}
      <div className="flex items-center gap-3">
        {showLogo ? <Logo className="h-8 w-8" /> : null}
        <h2 className="text-2xl font-bold tracking-tight text-white">{title}</h2>
      </div>
      {description ? <p className="mt-2 max-w-2xl text-sm text-slate-400">{description}</p> : null}
    </div>
    {action}
  </div>
);
