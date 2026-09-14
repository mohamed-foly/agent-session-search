import { Agent, SearchFilters } from '../api';

interface Props {
  agents: Agent[];
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
}

export default function FiltersBar({ agents, filters, onChange }: Props) {
  return (
    <div className="filters-bar">
      <select
        value={filters.agent ?? ''}
        onChange={(e) => onChange({ ...filters, agent: e.target.value || undefined })}
      >
        <option value="">All agents</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Filter by project / cwd..."
        value={filters.cwd ?? ''}
        onChange={(e) => onChange({ ...filters, cwd: e.target.value || undefined })}
      />

      <label>
        From
        <input
          type="date"
          value={filters.from ?? ''}
          onChange={(e) => onChange({ ...filters, from: e.target.value || undefined })}
        />
      </label>

      <label>
        To
        <input
          type="date"
          value={filters.to ?? ''}
          onChange={(e) => onChange({ ...filters, to: e.target.value || undefined })}
        />
      </label>
    </div>
  );
}
