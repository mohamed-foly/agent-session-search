import { useState } from 'react';
import checkIcon from '../assets/icons/check.svg';
import copyIcon from '../assets/icons/copy.svg';
import MaskIcon from './MaskIcon';

interface Props {
  text: string;
  /** Tooltip while idle (may be long; it wraps). */
  tip: string;
  /** Accessible name. */
  label: string;
}

/** Icon-only copy-to-clipboard button; the tooltip turns into "Copied!" for a moment. */
export default function CopyIconButton({ text, tip, label }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn has-tip"
      data-tip={copied ? 'Copied!' : tip}
      data-tip-wide=""
      data-tip-align="end"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be denied (insecure origin, permissions); nothing useful to show.
        }
      }}
    >
      <MaskIcon src={copied ? checkIcon : copyIcon} />
    </button>
  );
}
