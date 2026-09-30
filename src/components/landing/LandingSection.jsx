export const LandingSection = ({ title, eyebrow, description, children, className = '' }) => (
  <section className={`relative mx-auto max-w-7xl px-4 py-20 lg:px-6 ${className}`}>
    <div className="max-w-3xl">
      {eyebrow ? (
        <div className="inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-lime-400/10 px-3.5 py-1 text-xs font-bold uppercase tracking-[0.2em] text-lime-400">
          <span className="h-1.5 w-1.5 rounded-full bg-lime-400 animate-pulse" />
          {eyebrow}
        </div>
      ) : null}
      <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-white md:text-5xl">
        {title}
      </h2>
      {description ? (
        <p className="mt-4 text-lg leading-relaxed text-slate-400 md:text-xl">
          {description}
        </p>
      ) : null}
    </div>
    <div className="mt-12">{children}</div>
  </section>
);
