import { useEffect, useState } from 'react';

export const PeerReviewForm = ({ submission, canReview, onSubmit }) => {
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setStatus('');
  }, [submission?.id]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    try {
      if (!files.length) throw new Error('Upload at least one marked image page.');
      await onSubmit(files);
      setStatus('Peer marking submitted successfully.');
      setFiles([]);
    } catch (error) {
      setStatus(error.message);
    }
  };

  if (!submission) {
    return <div className="panel p-5 text-sm text-slate-500">No peer review assignment yet.</div>;
  }

  const sourceImages = submission.images?.length ? submission.images : [{ url: submission.imageUrl }];
  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="panel space-y-3 overflow-hidden p-3">
        {sourceImages.map((image, index) => <img key={image.url || index} src={image.url} alt={`Classmate submission page ${index + 1}`} className="max-h-[700px] w-full rounded-2xl object-contain" />)}
      </div>
      <form onSubmit={handleSubmit} className="panel space-y-4 p-5">
        <div>
          <h3 className="text-xl font-semibold text-slate-950">Peer mark this submission</h3>
          <p className="mt-2 text-sm text-slate-500">Exercise: {submission.exerciseTitle}</p>
        </div>
        <label className="block">
          <span className="label">Upload your marked image pages</span>
          <input type="file" accept="image/*" multiple className="input" disabled={!canReview} onChange={(event) => setFiles([...event.target.files ?? []])} />
        </label>
        {files.length ? <p className="text-sm text-slate-500">{files.length} image page(s) selected.</p> : null}
        <button type="submit" className="btn-primary" disabled={!canReview || !files.length}>Submit peer marking</button>
        <p className="text-sm text-slate-500">{canReview ? 'You can review because your own submission is complete.' : 'Submit your own work first to unlock peer review.'}</p>
        {status ? <p className="text-sm text-slate-600">{status}</p> : null}
      </form>
    </div>
  );
};
