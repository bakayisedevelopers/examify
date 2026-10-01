import { useState } from 'react';
import { UploadCloud } from 'lucide-react';

export const SubmissionUpload = ({ exerciseId, onSubmit }) => {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!files.length) {
      setMessage('Please choose at least one image page before uploading.');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const result = await onSubmit({ files, exerciseId });
      setMessage(`${result.submittedImages?.length ?? files.length} page(s) submitted.`);
      setFiles([]);
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
      <input type="file" accept="image/*" multiple className="input" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
      {files.length ? <p className="text-sm text-slate-500">{files.length} image page(s) selected.</p> : null}
      <button type="submit" disabled={loading} className="btn-primary gap-2 disabled:opacity-70">
        <UploadCloud className="h-4 w-4" />
        {loading ? 'Uploading…' : `Submit ${files.length || ''} image page${files.length === 1 ? '' : 's'}`}
      </button>
      {message ? <p className="text-sm font-medium text-rose-400">{message}</p> : null}
    </form>
  );
};
