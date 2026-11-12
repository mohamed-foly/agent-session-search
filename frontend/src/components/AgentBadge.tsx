import { agentIconUrl } from '../agentIcons';
import MaskIcon from './MaskIcon';

interface Props {
  agentId: string;
  /** Human-readable name shown in the tooltip and read by screen readers. */
  label: string;
  /** Where the tooltip opens; "below" for badges near the top edge of a container. */
  tipPos?: 'above' | 'below';
}

/** The agent's logo, with its name as a tooltip. */
export default function AgentBadge({ agentId, label, tipPos = 'above' }: Props) {
  const { url, isFallback } = agentIconUrl(agentId);
  return (
    <span className="agent-badge has-tip" data-tip={label} data-tip-pos={tipPos} role="img" aria-label={label}>
      {isFallback ? <MaskIcon src={url} className="agent-badge-fallback" /> : <img src={url} alt="" draggable={false} />}
    </span>
  );
}
