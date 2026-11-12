import { useState } from 'react';

import { providerName } from '../office/agentActivity.js';
import {
  clearFilter,
  isFilterActive,
  isProjectShown,
  isProviderShown,
  projectOfLabel,
  toggleProject,
  toggleProvider,
  useAgentFilterVersion,
} from '../office/agentFilter.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';

interface AgentFilterProps {
  /** Labels (directoryName) of the agents currently in the office. */
  labels: Array<string | undefined>;
  /** How many agents the filter currently leaves out. */
  filteredCount: number;
  mobile: boolean;
  /** In the bottom toolbar's row (opens upward), instead of floating over the office. */
  inToolbar?: boolean;
  /** Extra classes for the button (the toolbar's row height). */
  buttonClassName?: string;
}

/** Per-browser provider/project filter: changes what this viewer sees only. */
export function AgentFilter({
  labels,
  filteredCount,
  mobile,
  inToolbar = false,
  buttonClassName = '',
}: AgentFilterProps) {
  useAgentFilterVersion();
  const [open, setOpen] = useState(false);
  const providers = [...new Set(labels.map((l) => providerName(l)))].sort();
  const projects = [...new Set(labels.map((l) => projectOfLabel(l)))].sort((a, b) =>
    a.localeCompare(b),
  );
  const active = isFilterActive();

  return (
    <div
      className={
        inToolbar
          ? 'relative pointer-events-auto'
          : `absolute z-10 flex flex-col items-start gap-4 ${
              mobile ? 'mobile-safe-top right-8 items-end' : 'top-8 left-56'
            }`
      }
    >
      <Button
        variant={active ? 'active' : 'default'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        size={inToolbar ? 'lg' : 'sm'}
        icon={inToolbar ? 'search' : undefined}
        className={`${inToolbar ? 'press-juice' : 'border-border! shadow-pixel'} ${buttonClassName}`}
        title="Show only some projects or providers (this browser only)"
      >
        {active ? `Filter · ${filteredCount} hidden` : 'Filter'}
      </Button>
      {open && (
        <div
          className={`pixel-panel flex flex-col gap-6 p-10 min-w-180 max-h-[60vh] overflow-y-auto text-sm ${
            inToolbar ? 'absolute bottom-full left-0 mb-4' : ''
          }`}
        >
          <span className="text-text-muted">Providers</span>
          {providers.map((p) => (
            <Checkbox
              key={p}
              label={p}
              checked={isProviderShown(p)}
              onChange={() => toggleProvider(p)}
            />
          ))}
          <span className="text-text-muted pt-4">Projects</span>
          {projects.map((p) => (
            <Checkbox
              key={p}
              label={p}
              checked={isProjectShown(p)}
              onChange={() => toggleProject(p)}
            />
          ))}
          {active && (
            <Button size="sm" variant="ghost" onClick={clearFilter}>
              Show all
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
