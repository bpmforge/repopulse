import { createFileRoute } from '@tanstack/react-router';
import { docsUrl } from '../../lib/docs.js';
import { WidgetFrame, frameState, PageHeader } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { CiTokenExpiryNotice } from '../../widgets/admin/CiTokenExpiry.js';

// Setup checklist (W11-02, E1.2).
//
// For the operator who has the stack running and needs to know which step is
// still outstanding. It reports whether something is SET, never what it is set
// to — a setup screen that echoes secrets back is a credential leak wearing a
// helpful face.
//
// Every row links to the documentation for that step, because "forge
// connection: missing" without a next action is a status light, not help.

export const Route = createFileRoute('/setup/')({ component: SetupChecklist });

interface SetupCheck {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'unknown';
  detail: string;
  docs: string;
}

interface SetupStatus {
  ready: boolean;
  checks: SetupCheck[];
}

interface ConfigVariable {
  name: string;
  scope: string;
  required: boolean;
  purpose: string;
  if_wrong: string;
  default: string | null;
  secret: boolean;
  set: boolean;
}

const STATUS_MARK: Record<SetupCheck['status'], string> = {
  ok: '✓',
  missing: '!',
  // Not a failure: "no webhook has arrived yet" is a fact about history, not
  // about configuration, and rendering it as a fault would send operators
  // hunting for a problem that may not exist.
  unknown: '?',
};

/** Exported for the unit test, which renders it without a router. */
export function SetupChecklistForTest() {
  return <SetupChecklist />;
}

function SetupChecklist() {
  const status = useApiQuery<SetupStatus>({ endpoint: '/setup/status' });
  const config = useApiQuery<{ variables: ConfigVariable[] }>({ endpoint: '/setup/config' });

  const checks = status.data?.checks ?? [];
  const variables = config.data?.variables ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="setup">
      <PageHeader
        title="Setup"
        description="Which install steps are done and which configuration is set — never the values."
      />

      <WidgetFrame
        title="Checklist"
        state={frameState({
          isLoading: status.isLoading,
          isError: status.isError,
          isEmpty: checks.length === 0,
        })}
        {...(status.error ? { errorMessage: status.error.message } : {})}
        emptyMessage="No setup checks could be run."
        testId="setup-checklist"
      >
        <ul className="flex flex-col gap-3 text-sm">
          {checks.map((check) => (
            <li key={check.id} className="flex flex-col gap-0.5" data-testid={`setup-${check.id}`}>
              <div className="flex items-center gap-2">
                <span
                  aria-label={
                    check.status === 'ok'
                      ? 'done'
                      : check.status === 'missing'
                        ? 'not done'
                        : 'not known yet'
                  }
                  data-testid={`setup-${check.id}-status`}
                >
                  {STATUS_MARK[check.status]}
                </span>
                <span className="font-medium">{check.label}</span>
              </div>
              <span className="text-xs text-fg-muted">{check.detail}</span>
              {/* W16-24: this was plain text. A checklist that tells a stuck
                  operator to "See docs/INSTALL.md#connect-your-forge" and gives
                  them nothing to click is a dead end — and on a container
                  install there is no repository checkout to open it from at
                  all. */}
              <a
                href={docsUrl(check.docs)}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-fg-muted underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={`setup-doc-${check.id ?? check.docs}`}
              >
                See {check.docs}
              </a>
            </li>
          ))}
        </ul>
      </WidgetFrame>

      {/* W20-15 (UX_TODO X-19): a token about to expire is a setup step due. */}
      <CiTokenExpiryNotice />

      <WidgetFrame
        title="Configuration"
        state={frameState({
          isLoading: config.isLoading,
          isError: config.isError,
          isEmpty: variables.length === 0,
        })}
        {...(config.error ? { errorMessage: config.error.message } : {})}
        emptyMessage="No configuration reference available."
        testId="setup-config"
      >
        <p className="mb-2 text-xs text-fg-muted">
          Whether each variable is set — never its value. Full reference, including what breaks when
          one is wrong, is in docs/CONFIG.md.
        </p>
        {/* Focusable and labelled: a scrollable region that cannot be reached
            by keyboard is an axe violation and, more to the point, a table a
            keyboard user cannot read the right-hand side of. */}
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Configuration variables"
        >
          <table className="table-plain w-full text-left text-xs">
            <thead className="text-fg-muted">
              <tr>
                <th scope="col" className="py-1">
                  Variable
                </th>
                <th scope="col" className="py-1">
                  Required
                </th>
                <th scope="col" className="py-1">
                  Set
                </th>
                <th scope="col" className="py-1">
                  Purpose
                </th>
              </tr>
            </thead>
            <tbody>
              {variables.map((variable) => (
                <tr key={variable.name} className="border-t border-border">
                  <th scope="row" className="py-1 font-mono font-normal">
                    {variable.name}
                    {variable.secret ? <span title="secret — never shown"> 🔒</span> : null}
                  </th>
                  <td className="py-1">{variable.required ? 'yes' : 'no'}</td>
                  <td className="py-1" data-testid={`config-${variable.name}-set`}>
                    {variable.set ? 'yes' : variable.required ? 'NO' : 'no (default)'}
                  </td>
                  <td className="py-1 text-fg-muted">{variable.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>
    </div>
  );
}
