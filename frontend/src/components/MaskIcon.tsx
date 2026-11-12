import { CSSProperties } from 'react';

/**
 * A single-colour SVG icon that takes the surrounding text colour (so it works in
 * light and dark themes). Drawn with a CSS mask from an asset URL: no inline SVG
 * markup and no extra dependency.
 */
export default function MaskIcon({ src, className = '' }: { src: string; className?: string }) {
  return <span className={`mask-icon ${className}`} style={{ '--icon-src': `url("${src}")` } as CSSProperties} aria-hidden="true" />;
}
