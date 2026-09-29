import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getRoleDashboardData } from '../../services/firestoreService';

export const TutorQuestionPapersPage = () => {
  const { profile, logout } = useAuth();
  const [dashboard, setDashboard] = useState(null);

  useEffect(() => {
    getRoleDashboardData('tutor').then(setDashboard);
  }, []);

  return (
    <AppShell title="Question papers" subtitle="Manage uploaded subject papers and reference metadata for exercise generation." role="tutor" user={profile} onLogout={logout}>
      <SectionHeader eyebrow="Repository" title="Available papers" description="Exercises should point to paper references and question numbers instead of duplicating entire question text." />
      <div className="grid gap-4">
        {(dashboard?.questionPapers ?? []).map((paper) => (
          <div key={paper.id} className="panel p-5">
            <p className="text-lg font-semibold text-slate-950">{paper.title}</p>
            <p className="mt-2 text-sm text-slate-500">{paper.term} {paper.year} • {paper.region}</p>
          </div>
        ))}
        {!dashboard?.questionPapers?.length ? <div className="panel p-5 text-sm text-slate-500">No question papers have been uploaded yet.</div> : null}
      </div>
    </AppShell>
  );
};
