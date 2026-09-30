export const StatCard = ({ label, value, detail }) => (
  <div className="panel p-5 border border-slate-800 bg-slate-900/90 shadow-sm transition hover:border-lime-500/30">
    <p className="text-sm font-medium text-slate-400">{label}</p>
    <p className="mt-3 text-3xl font-extrabold tracking-tight text-white">{value}</p>
    <p className="mt-2 text-xs font-semibold text-lime-400">{detail}</p>
  </div>
);
