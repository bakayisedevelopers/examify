import { useState } from 'react';
import { UploadCloud } from 'lucide-react';

export const SubmissionUpload = ({ exerciseId, onSubmit }) => {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!file) {
      setMessage('Please choose an image before uploading.');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const result = await onSubmit({ file, exerciseId });
      setMessage(`Submission saved: ${result.submittedFileName}`);
      setFile(null);
      event.target.reset();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="panel space-y-4 p-5 w-full">
      <div>
        <h3 className="text-lg font-semibold text-slate-950">Upload Handwritten Work</h3>
        <p className="mt-2 text-sm text-slate-500">Submit a clear photo of your paper. JPG, PNG, or HEIC files are supported for answer uploads.</p>
      </div>
      <input type="file" accept="image/*" className="input" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button type="submit" disabled={loading} className="btn-primary gap-2 disabled:opacity-70">
        <UploadCloud className="h-4 w-4" />
        {loading ? 'Uploading…' : `Submit image`}
      </button>
      {message ? <p className="text-sm text-red">{message}</p> : null}
    </form>
  );
};
