import React from 'react';
import { Cpu, CheckCircle, AlertTriangle, Settings as Gear, ShieldAlert, Trash2 } from 'lucide-react';
import { formatDate } from './dateUtils';
import { kibToMbit, formatMbit, formatLiveSpeed, formatOsVersion } from './rateLimit';
import { scoreTextColour } from './NodeHealthBadges';
import { useTranslation } from '../context/TranslationContext';
import type { Node } from '../types';

interface NodeRowProps {
  node: Node;
  bulkDeleteMode: boolean;
  /** Just this row's state. Passing the whole selection map would change
   *  identity on every click and defeat the memo below. */
  isSelected: boolean;
  onSelectNode: (nodeId: number, checked: boolean) => void;
  onRunPrepare: (nodeId: number, hostname: string) => void;
  /** Every provisioning trigger in this row -- ready, needing a fix, never
   *  bootstrapped, or offline -- routes through here. It asks whether to use
   *  the fleet's default credentials before doing anything, rather than some
   *  statuses assuming yes and others always demanding a fresh login. */
  onProvisionClick: (node: Node) => void;
  onShowBackup: (node: Node) => void;
  onDeleteNode: (nodeId: number, hostname: string) => void;
  /** Takes the id so FleetTab can hold one stable callback for every row. */
  onShowDetails: (nodeId: number) => void;
  /** Persists the login typed the first time this node's terminal is
   *  opened, so later clicks reuse it without asking again. */
  onSaveSshLogin: (nodeId: number, hostname: string, login: string) => void;
  /** Opens the web terminal modal for this node. */
  onOpenTerminal: (node: Node) => void;
  /** A superadmin's terminal session always connects as root over the
   *  orchestrator's own key (routers/terminal.py's `use_key` check) — the
   *  node's stored ssh_login is never read for them, so prompting for one
   *  first is a pointless gate that only a superadmin can hit, since they're
   *  the only role this row can identify client-side. */
  currentUser?: any;
  groupName: string | null;
  groupRateLimit?: number | null;
  timezone?: string;
}

function NodeRowComponent({
  node,
  bulkDeleteMode,
  isSelected,
  onSelectNode,
  onRunPrepare,
  onProvisionClick,
  onShowBackup,
  onDeleteNode,
  onShowDetails,
  onSaveSshLogin,
  onOpenTerminal,
  currentUser,
  groupName,
  groupRateLimit,
  timezone,
}: NodeRowProps) {
  const { t } = useTranslation();
  const [timeLeft, setTimeLeft] = React.useState<number>(0);
  const liveSpeed = node.is_backup_running ? formatLiveSpeed(node) : null;

  // One judgement, shown twice: as the mark on the Backup button and as the
  // colour of the Last Backup cell.
  //
  // Deliberately not conditioned on an archive existing. A node that missed
  // its window and has never backed up is the worst case there is, and
  // colouring only nodes that have an archive would leave exactly that case
  // silent — it has no mark to carry the warning.
  //
  // missed_window outranks "no schedule": the scheduler only sets it for a
  // grouped, unpaused node, but only a successful backup clears it, so
  // pausing a node that missed its window leaves the flag standing. That is a
  // recorded fact and greying it out would hide it.
  const backupState = node.missed_window
    ? { tone: 'text-amber-400', label: t('backupMissedWindow') }
    : (!node.group_id || node.backup_paused)
      ? { tone: 'text-zinc-500', label: t('backupNoSchedule') }
      : node.last_backup
        ? { tone: 'text-emerald-400', label: t('backupOnSchedule') }
        : { tone: 'text-zinc-500', label: t('backupNotDueYet') };

  React.useEffect(() => {
    if (node.status !== 'OFFLINE' || !node.next_retry_at) {
      setTimeLeft(0);
      return;
    }

    const calculateTimeLeft = () => {
      const diff = new Date(node.next_retry_at!).getTime() - Date.now();
      return Math.max(0, Math.ceil(diff / 1000));
    };

    setTimeLeft(calculateTimeLeft());

    const timer = setInterval(() => {
      const remaining = calculateTimeLeft();
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [node.status, node.next_retry_at]);

  const formatTime = (seconds: number) => {
    if (seconds <= 0) return '';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const getIpColorClass = () => {
    if (node.last_ping_status === true) {
      return "text-emerald-400 font-medium";
    }
    if (node.last_available_at) {
      return "text-rose-400 font-medium";
    }
    return "text-amber-500 font-medium"; // Never online / orange
  };

  const getIpTooltip = () => {
    const statusLine = node.last_ping_status === true
      ? (t('nodeOnline') || 'Online')
      : node.last_available_at
        ? (t('nodeOfflineLastSeen') || 'Offline (Last seen: {time})').replace('{time}', formatDate(node.last_available_at, timezone))
        : (t('nodeNeverOnline') || 'Never online');
    return `${statusLine}\n${t('sshQuickConnectHint')}`;
  };

  // Ctrl/Cmd-click only: a plain click on IP:PORT text should not risk
  // opening a terminal by accident. First use for a node prompts for the
  // login and persists it via onSaveSshLogin; every click after that reuses
  // the saved value straight away. Editing an already-saved login happens in
  // the node details modal, not by re-prompting here. The login itself is
  // only ever read by the backend (from the node's own saved value, by node
  // id) — it does not need to reach onOpenTerminal at all.
  const handleIpPortClick = (e: React.MouseEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    // A superadmin's session always connects as root over the orchestrator's
    // own key (routers/terminal.py's `use_key` check) -- the backend never
    // reads ssh_login for them, so asking for one here first would gate a
    // superadmin's terminal behind a value their own connection ignores.
    if (currentUser?.is_superadmin || node.ssh_login) {
      onOpenTerminal(node);
      return;
    }
    const entered = window.prompt(t('sshLoginPrompt'))?.trim();
    if (!entered) return;
    onSaveSshLogin(node.id, node.hostname, entered);
    onOpenTerminal(node);
  };

  const effectiveLimitStr = (() => {
    if (node.upload_rate_limit != null && node.upload_rate_limit > 0) {
      return `${formatMbit(kibToMbit(node.upload_rate_limit))} Mbit/s`;
    }
    if (groupRateLimit != null && groupRateLimit > 0) {
      return `${formatMbit(kibToMbit(groupRateLimit))} Mbit/s`;
    }
    return t('rateLimitUnlimited') || 'unlimited';
  })();
  
  const backupBadgeColors: Record<string, { bg: string; border: string }> = {
    'text-emerald-400': { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
    'text-amber-400': { bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
    'text-zinc-500': { bg: 'bg-zinc-500/10', border: 'border-zinc-500/20' },
  };

  const renderStatusButton = () => {
    const statusMap: Record<string, { bg: string, text: string, border: string, label: string, icon: React.ReactNode, title: string, onClick: () => void }> = {
      READY: {
        bg: "bg-emerald-500/10 hover:bg-emerald-500/20", text: "text-emerald-400", border: "border-emerald-500/20",
        label: t('readyOk'), icon: <CheckCircle size={14} />, title: t('pressToProvision') || "Press to provision",
        onClick: () => onProvisionClick(node)
      },
      RESTORED: {
        bg: "bg-indigo-500/10 hover:bg-indigo-500/20", text: "text-indigo-400", border: "border-indigo-500/30",
        label: "RESTORED", icon: <CheckCircle size={14} />, title: t('needsLicenseUpdate') || "Needs License Update",
        onClick: () => onShowDetails(node.id)
      },
      NEEDS_FIX: {
        bg: "bg-amber-500/10 hover:bg-amber-500/20", text: "text-amber-400", border: "border-amber-500/20",
        label: t('needsFixPrepare'), icon: <AlertTriangle size={14} />, title: t('pressToProvision') || "Press to provision",
        onClick: () => onProvisionClick(node)
      },
      NEEDS_BOOTSTRAP: {
        bg: "bg-zinc-500/10 hover:bg-zinc-500/20", text: "text-zinc-400", border: "border-zinc-500/20",
        label: t('statusProvision'), icon: <Gear size={14} />, title: t('provisionNodeTooltip'),
        onClick: () => onProvisionClick(node)
      },
      OFFLINE: {
        bg: "bg-rose-500/10 hover:bg-rose-500/20", text: "text-rose-400", border: "border-rose-500/20",
        label: timeLeft > 0 ? t('provisionTimeLeft').replace('{time}', formatTime(timeLeft)) : t('statusProvision'),
        icon: <ShieldAlert size={14} />,
        title: timeLeft > 0 ? t('autoRetryIn').replace('{time}', formatTime(timeLeft)) : t('provisionOfflineNode'),
        onClick: () => onProvisionClick(node)
      }
    };
    const config = statusMap[node.status] || statusMap.OFFLINE;
    return (
      <button
        onClick={config.onClick}
        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${config.bg} ${config.text} ${config.border} ${node.status === 'RESTORED' ? 'shadow-[0_0_8px_rgba(99,102,241,0.5)]' : ''}`}
        title={config.title}
      >
        {config.icon} {config.label}
      </button>
    );
  };

  return (
    <tr className="hover:bg-zinc-800/30 transition-colors">
      {bulkDeleteMode && (
        <td className="px-3.5 py-2.5 w-10 text-center">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => onSelectNode(node.id, e.target.checked)}
            className="rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500 h-4 w-4 cursor-pointer"
          />
        </td>
      )}
      <td className="px-3.5 py-2.5 font-semibold text-zinc-50 flex items-center gap-2">
        <Cpu size={14} className="text-zinc-500 shrink-0" />
        {/* overflow-hidden: the column's own width never changes (it's a
            fixed pixel value, measured once and persisted). The "Group: X •
            rate limit" line (whitespace-nowrap, no truncate of its own)
            would otherwise render past this box and visually spill into the
            next column instead of the column itself ever moving. Node rows
            no longer indent by nesting depth — that's what used to make the
            first column appear to slide right as subnet groups expanded;
            the fold/unfold tree above already conveys the hierarchy. */}
        <div className="flex flex-col min-w-0 overflow-hidden">
          {/* The note rides on the hostname's existing tooltip, which is
              already there so a truncated name can be read in full. The
              dotted underline is the only hint a note exists at all —
              without it nobody would think to hover. */}
          <span
            className={`truncate ${node.notes ? 'decoration-dotted decoration-zinc-600 underline underline-offset-4' : ''}`}
            title={node.notes ? `${node.hostname}\n\n${node.notes}` : node.hostname}
          >
            {node.hostname}
          </span>
          <div className="text-[11px] text-zinc-400 flex items-center gap-1.5 font-normal leading-none mt-1 whitespace-nowrap">
            <span className="text-indigo-400/90 font-semibold">
              {t('groupLabel') || 'Group'}: {groupName || '—'}
            </span>
            <span className="text-zinc-600">•</span>
            <span className="text-zinc-400 font-mono text-[10px] bg-zinc-800/80 px-1.5 py-0.5 rounded border border-zinc-700/50">
              {effectiveLimitStr}
            </span>
          </div>
          {/* A missed window used to get its own badge here too. The amber
              mark on the Backup button carries it now — two indicators of one
              fact were working against the row's legibility. */}
          {node.backup_paused && (
            <div className="flex gap-1 mt-1">
              <span className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded text-[9px] font-bold">
                {t('paused')}
              </span>
            </div>
          )}
        </div>
      </td>
      <td
        className="px-3.5 py-2.5 text-zinc-400 whitespace-nowrap text-xs cursor-pointer"
        title={getIpTooltip()}
        onClick={handleIpPortClick}
      >
        <span className={getIpColorClass()}>
          {node.ip_address}
        </span>
        :{node.ssh_port}
      </td>
      <td className="px-3.5 py-2.5 whitespace-nowrap">
        <div className="flex flex-col leading-tight">
          <span className="text-zinc-300 font-medium text-xs">{formatOsVersion(node.os_version) || t('unknown')}</span>
          <span className="text-zinc-500 text-[11px] mt-0.5">{node.os_arch || t('unknown').toUpperCase()}</span>
        </div>
      </td>
      <td className="px-3.5 py-2.5 whitespace-nowrap">
        <div className="flex flex-col leading-tight">
          <span className="text-zinc-300 font-medium text-xs">
            {t('diskLabel')}: {node.disk_type ? node.disk_type.split(' ')[0] : 'UNKNOWN'}
            {' '}
            {/* smart_percent_used is wear consumed (0 = new, 100 = end of
                rated life — see core/smart.py's own conversion of SATA's
                native "remaining" attribute into this same "used" convention).
                Flipped here to remaining life, coloured on the same
                green-to-red scale the SMART badge's own score already uses
                (NodeHealthBadges.scoreTextColour), so a glance at the fleet
                and a glance at one node's health card read consistently. */}
            {node.smart_percent_used != null && (() => {
              const remaining = Math.max(0, 100 - node.smart_percent_used);
              return <span style={{ color: scoreTextColour(remaining) }}>{remaining}%</span>;
            })()}
          </span>
          <span className="text-zinc-500 text-[11px] mt-0.5">{t('netLabel')}: {node.network_iface || t('unknown').toUpperCase()}</span>
        </div>
      </td>
      <td className="px-3.5 py-2.5 whitespace-nowrap">
        <div className="flex flex-col gap-1 items-start">
          {renderStatusButton()}
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border whitespace-nowrap ${backupBadgeColors[backupState.tone].bg} ${backupState.tone} ${backupBadgeColors[backupState.tone].border}`}
            title={backupState.label}
          >
            {node.last_backup && <CheckCircle size={12} />}
            {backupState.label}
          </span>
        </div>
      </td>
      <td className={`px-3.5 py-2.5 text-xs whitespace-nowrap ${backupState.tone}`} title={backupState.label}>
        {node.last_backup ? formatDate(node.last_backup, timezone) : t('never')}
      </td>
      <td className="px-3.5 py-2 text-right whitespace-nowrap">
        <div className="inline-flex flex-col items-end gap-1.5 w-full">
          {/* Top row: Node Details */}
          <button
            onClick={() => onShowDetails(node.id)}
            className="w-full text-center px-2 py-1 text-xs font-semibold bg-zinc-800 hover:bg-zinc-750 text-zinc-200 border border-zinc-700/80 rounded hover:text-indigo-400 hover:border-zinc-600 transition-colors cursor-pointer"
          >
            {t('nodeDetails')}
          </button>
          {/* Bottom row: Backup + Delete */}
          <div className="flex items-center gap-1.5 w-full">
            <button
              onClick={() => onShowBackup(node)}
              disabled={node.status !== 'READY' && !node.is_backup_running}
              title={liveSpeed ? t('currentSpeedLabel') : backupState.label}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs font-semibold rounded border transition-colors ${
                node.is_backup_running
                  ? 'text-indigo-300 border-indigo-500 bg-indigo-500/10 hover:bg-indigo-500/20 cursor-pointer font-bold animate-pulse'
                  : 'bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border-indigo-500/20 disabled:opacity-30 cursor-pointer'
              }`}
            >
              {/* The checkmark now lives on the Status/Action badge instead —
                  two indicators of the same fact were competing for
                  attention here. A measured rate, not a share of the whole:
                  borg does not report how much is left, so there is no
                  honest percentage to draw. The pulse carries "still going"
                  instead. */}
              <span className="truncate">
                {node.is_backup_running
                  ? (liveSpeed || '…')
                  : t('backupAction')}
              </span>
            </button>
            <button
              onClick={() => onDeleteNode(node.id, node.hostname)}
              className="p-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded border border-rose-500/20 transition-colors cursor-pointer shrink-0"
              title={t('deleteNodeTooltip')}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * Memoised because FleetTab re-renders every five seconds and a fleet is
 * thousands of rows.
 *
 * The poll returns the same data almost every time, so without this each tick
 * rebuilds and re-reconciles the entire table for nothing. For the memo to
 * hold, every prop has to be stable across renders that changed nothing —
 * which is why this component takes `isSelected` rather than the selection
 * map, and an `onShowDetails` that takes an id rather than a closure baked per
 * row. Reintroducing either would leave React.memo in place and doing nothing,
 * which is worse than not having it: it reads as solved.
 */
export const NodeRow = React.memo(NodeRowComponent);

