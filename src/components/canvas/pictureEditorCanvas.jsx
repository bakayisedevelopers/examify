import { useRef, useState } from 'react';
import { ReactSketchCanvas } from 'react-sketch-canvas';

export const MarkingCanvas = ({ imageUrl, onSave, saveLabel = 'Submit Grade' }) => {
  const canvasRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  
  // This function triggers when the student is done marking
  const handleExport = async () => {
    if (!canvasRef.current) return;
    setSaving(true);
    setError('');
    try {
      const dataUrl = await canvasRef.current.exportImage("png");
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const file = new File([blob], "graded-work.png", { type: "image/png" });
      await onSave(file);
    } catch (error) {
      console.error("Failed to export image", error);
      setError(error.message || 'Could not save the marked work.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, backgroundColor: 'rgba(0,0,0,0.8)', padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: '800px', height: '80vh', backgroundColor: '#fff', borderRadius: '12px', overflow: 'hidden' }}>
        <ReactSketchCanvas
          ref={canvasRef}
          width="100%"
          height="100%"
          strokeWidth={4}
          strokeColor="red"
          backgroundImage={imageUrl}
          preserveBackgroundImageAspectRatio="contain"
          exportWithBackgroundImage={true}
        />
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 1000 }}>
          <button 
            className="btn-primary rounded-lg px-6 py-2 font-bold shadow-lg disabled:opacity-60"
            onClick={handleExport} 
            disabled={saving}
          >
            {saving ? 'Saving...' : saveLabel}
          </button>
        </div>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p> : null}
    </div>
  );
};
