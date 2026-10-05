const getInitials = (account = {}) => {
  const displayName = account.displayName || account.name || account.fullName || '';
  return (displayName || account.email || 'U')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || 'U';
};

export const ProfileIdentityCard = ({ account = {}, roleLabel = 'Account' }) => {
  const displayName = account.displayName || account.name || account.fullName || 'Account';
  const avatarUrl = account.photoURL || account.photoUrl || account.avatarUrl || account.profileImageUrl || account.avatar || '';

  return (
    <section className="panel flex min-w-0 items-center gap-4 p-4 sm:p-5" aria-label="Account profile">
      <span className="relative flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-slate-800 text-sm font-semibold text-lime-300 sm:h-16 sm:w-16">
        {getInitials(account)}
        {avatarUrl ? <img src={avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-base font-semibold text-white sm:text-lg">{displayName}</span>
        {account.email ? <span className="mt-0.5 block break-all text-sm text-slate-400">{account.email}</span> : null}
        <span className="mt-2 inline-flex max-w-full truncate rounded-full border border-lime-400/20 bg-lime-400/10 px-2.5 py-1 text-xs font-medium text-lime-300">{roleLabel}</span>
      </span>
    </section>
  );
};
