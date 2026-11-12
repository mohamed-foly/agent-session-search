import { Agent } from '../api';
import { ResumeArgsOverrides } from '../settings';

interface Props {
  agents: Agent[];
  overrides: ResumeArgsOverrides;
  onChange: (overrides: ResumeArgsOverrides) => void;
}

export default function SettingsPanel({ agents, overrides, onChange }: Props) {
  return (
    <section className="settings-panel">
      <h2>Resume command flags</h2>
      <p className="settings-hint">
        Extra arguments added to each agent's resume command — e.g.{' '}
        <code>--dangerously-skip-permissions --teammate-mode in-process</code>. Saved in this browser;
        defaults come from <code>*_RESUME_ARGS</code> in the server's <code>.env</code>.
      </p>

      {agents.map((agent) => {
        const overridden = Object.prototype.hasOwnProperty.call(overrides, agent.id);
        return (
          <div key={agent.id} className="settings-row">
            <label htmlFor={`resume-args-${agent.id}`}>{agent.label}</label>
            <input
              id={`resume-args-${agent.id}`}
              type="text"
              spellCheck={false}
              placeholder={agent.defaultResumeArgs || 'no extra flags'}
              value={overridden ? overrides[agent.id] : agent.defaultResumeArgs}
              onChange={(e) => onChange({ ...overrides, [agent.id]: e.target.value })}
            />
            <button
              className="copy-btn"
              disabled={!overridden}
              title={`Use the .env default${agent.defaultResumeArgs ? `: ${agent.defaultResumeArgs}` : ''}`}
              onClick={() => {
                const { [agent.id]: _removed, ...rest } = overrides;
                onChange(rest);
              }}
            >
              Reset
            </button>
          </div>
        );
      })}
    </section>
  );
}
