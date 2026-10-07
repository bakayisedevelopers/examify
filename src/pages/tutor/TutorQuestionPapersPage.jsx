import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getRoleDashboardData } from '../../services/firestoreService';

export const TutorQuestionPapersPage = () => {
  const { profile, logout } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    getRoleDashboardData('tutor').then((data) => { if (active) setDashboard(data); })
      .catch((error) => { if (active) setLoadError(error.message || 'Could not load question papers.'); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <AppShell title="Question papers" subtitle="Manage uploaded subject papers and reference metadata for exercise generation." role="tutor" user={profile} onLogout={logout}>
      <SectionHeader eyebrow="Repository" title="Available papers" description="Exercises should point to paper references and question numbers instead of duplicating entire question text." />
      <div className="grid gap-4">
        {isLoading ? <LoadingState label="Loading question papers…" /> : null}
        {(dashboard?.questionPapers ?? []).map((paper) => (
          <div key={paper.id} className="panel p-5">
            <p className="text-lg font-semibold text-slate-950">{paper.title}</p>
            <p className="mt-2 text-sm text-slate-500">{paper.term} {paper.year} • {paper.region}</p>
          </div>
        ))}
        {loadError ? <div className="panel p-5 text-sm text-rose-700" role="alert">{loadError}</div> : null}
        {!isLoading && !loadError && !dashboard?.questionPapers?.length ? <div className="panel p-5 text-sm text-slate-500">No question papers have been uploaded yet.</div> : null}
      </div>
    </AppShell>
  );
};
