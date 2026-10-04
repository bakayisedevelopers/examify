export const Logo = ({ className = '', showText = true }) => (
  <div className={`inline-flex items-center gap-3 ${className}`}>
    <img src="/logo.png" alt={showText ? '' : 'Examifying'} className="h-10 w-10 shrink-0 object-contain drop-shadow-lg sm:h-11 sm:w-11" />
    {showText ? (
      <div>
        <div className="flex items-center gap-2">
          <p className="bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 bg-clip-text text-base font-bold tracking-tight text-transparent sm:text-lg">Examifying</p>
          <span className="hidden sm:inline-block rounded-full bg-lime-400/15 px-2 py-0.5 text-[10px] font-bold text-lime-400 border border-lime-400/30 tracking-wider uppercase">
            Maths
          </span>
        </div>
        <p className="hidden sm:block text-xs text-slate-400">Subject mastery • 70-20-10 learning</p>
      </div>
    ) : null}
  </div>
);
