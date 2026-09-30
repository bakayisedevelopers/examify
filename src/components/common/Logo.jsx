export const Logo = ({ className = '', showText = true }) => (
  <div className={`inline-flex items-center gap-3 ${className}`}>
    <div className="relative flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-lime-400 to-lime-500 text-base sm:text-lg font-black text-slate-950 shadow-lg shadow-lime-500/25 ring-2 ring-lime-400/40">
      <span className="tracking-tight font-extrabold text-slate-950">Ex</span>
    </div>
    {showText ? (
      <div>
        <div className="flex items-center gap-2">
          <p className="text-base sm:text-lg font-bold tracking-tight text-white">Examifying</p>
          <span className="hidden sm:inline-block rounded-full bg-lime-400/15 px-2 py-0.5 text-[10px] font-bold text-lime-400 border border-lime-400/30 tracking-wider uppercase">
            Maths
          </span>
        </div>
        <p className="hidden sm:block text-xs text-slate-400">Subject mastery • 70-20-10 learning</p>
      </div>
    ) : null}
  </div>
);
