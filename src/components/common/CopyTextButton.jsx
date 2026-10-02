import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export const CopyTextButton = ({ value, label = 'text', className = '' }) => {
  const [copied, setCopied] = useState(false);

  const copyValue = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <button type="button" className={`btn-secondary inline-flex h-10 w-10 items-center justify-center p-0 ${className}`} onClick={copyValue} disabled={!value} aria-label={`Copy ${label}`} title={copied ? 'Copied' : `Copy ${label}`}>
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
};
