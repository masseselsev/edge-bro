import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Settings as Gear, ShieldAlert, CheckCircle, RefreshCw, AlertTriangle, Trash2, Search, Folder, FolderOpen, ChevronRight, ChevronDown, Cpu, Square, CheckSquare, ArrowUp, ArrowDown } from 'lucide-react';
import { AddNodeModal, ProvisionNodeModal, BackupCommentModal } from './NodeModals';
import { NodeRow } from './NodeRow';
import NodeDetailsModal from './NodeDetailsModal';
import TerminalModal from './TerminalModal';
import { useTranslation } from '../context/TranslationContext';
import { api } from '../api';
import type { Node } from '../types';

// Actions has no entry: it's the one column left without a specified width
// in the <colgroup> (see the JSX below), so it auto-fills whatever space
// the other, fixed-width columns don't use instead of leaving a gap.
const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  hostname: 260, ip_address: 150, os_version: 170,
  disk_type: 150, status: 170, last_backup: 150,
};
const MIN_COLUMN_WIDTH = 80;

interface BackupGroup {
  id: number;
  name: string;
  upload_rate_limit?: number | null;
}

interface FleetTabProps {
  onViewLogs: (taskId: string, title: string) => void;
  timezone?: string;
  currentUser?: any;
}

export default function FleetTab({ onViewLogs, timezone, currentUser }: FleetTabProps) {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [groups, setGroups] = useState<BackupGroup[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Pagination States
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [totalPages, setTotalPages] = useState(1);
  const [totalNodes, setTotalNodes] = useState(0);
  
  // Modals state
  const [showAddModal, setShowAddModal] = useState(false);
  const [showProvisionModal, setShowProvisionModal] = useState<Node | null>(null);
  const [showBackupModal, setShowBackupModal] = useState<Node | null>(null);
  const [selectedNodeDetails, setSelectedNodeDetails] = useState<number | null>(null);
  const [terminalNode, setTerminalNode] = useState<Node | null>(null);

  // Search & Grouping State
  const [searchQuery, setSearchQuery] = useState('');
  const [grouping, setGrouping] = useState<'flat' | 'prefix' | 'subnet'>('flat');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Sorting State
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Per-operator column widths, persisted server-side in the same
  // preferences blob the monitoring graphs already use.
  //
  // null means "not decided yet" — rather than falling back to guessed
  // pixel defaults (which drift out of sync with real content the moment
  // anything in a cell changes, as happened here once the SMART percentage
  // and the group/rate-limit badge made the old guesses too narrow), a
  // brand-new user gets one natural, auto-layout render first. Once that
  // has painted with real row content, its measured widths become the
  // starting point — locked in and saved, so every load after that (and
  // every manual drag) is stable. The backend's GET only omits
  // fleet_column_widths for a user who has never had it saved, which is
  // what tells us to do this at all instead of just loading a saved value.
  const [columnWidths, setColumnWidths] = useState<Record<string, number> | null>(null);
  const saveWidthsTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMeasuredRef = React.useRef(false);
  // The preferences GET and the nodes list GET are two independent
  // requests that can resolve in either order. The measurement effect must
  // not fire until this one has settled — otherwise, on the (common) case
  // where the nodes list happens to resolve first, it could measure and
  // overwrite a saved preference that just hadn't arrived yet. A state
  // (not a ref) on purpose: the measurement effect needs to re-run once
  // this flips, and only a state change triggers that.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const tableRef = React.useRef<HTMLTableElement | null>(null);

  useEffect(() => {
    api.get<{ preferences: { fleet_column_widths?: Record<string, number> } }>('/api/monitoring/preferences')
      .then(data => {
        const saved = data?.preferences?.fleet_column_widths;
        if (saved && Object.keys(saved).length > 0) {
          hasMeasuredRef.current = true; // a real saved value exists — never auto-measure over it
          setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS, ...saved });
        }
      })
      .catch(() => {})
      .finally(() => setPrefsLoaded(true));
  }, []);

  const scheduleColumnWidthsSave = (widths: Record<string, number>) => {
    if (saveWidthsTimer.current) clearTimeout(saveWidthsTimer.current);
    saveWidthsTimer.current = setTimeout(() => {
      api.post('/api/monitoring/preferences', { preferences: { fleet_column_widths: widths } }).catch(() => {});
    }, 500);
  };

  // Runs once: after the first page of real rows has painted with no saved
  // preference to load, measure the natural (table-layout: auto) width
  // each header settled on and lock those in as the starting columnWidths —
  // then save them, so this is a one-time event per operator, not a
  // recurring layout shift.
  useEffect(() => {
    if (hasMeasuredRef.current || loading || !prefsLoaded) return;
    hasMeasuredRef.current = true;
    requestAnimationFrame(() => {
      const measured: Record<string, number> = {};
      tableRef.current?.querySelectorAll('thead th[data-col-key]').forEach((el) => {
        const key = el.getAttribute('data-col-key');
        if (key) measured[key] = Math.max(MIN_COLUMN_WIDTH, Math.round(el.getBoundingClientRect().width));
      });
      const resolved = { ...DEFAULT_COLUMN_WIDTHS, ...measured };
      setColumnWidths(resolved);
      scheduleColumnWidthsSave(resolved);
    });
  }, [loading, nodes, prefsLoaded]);

  const startColumnResize = (key: string, startX: number, startWidth: number) => {
    const onMove = (e: PointerEvent) => {
      const next = Math.max(MIN_COLUMN_WIDTH, startWidth + (e.clientX - startX));
      setColumnWidths(prev => (prev ? { ...prev, [key]: next } : prev));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setColumnWidths(current => {
        if (current) scheduleColumnWidthsSave(current);
        return current;
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const ColumnResizeHandle = ({ columnKey }: { columnKey: string }) => (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        if (columnWidths) startColumnResize(columnKey, e.clientX, columnWidths[columnKey]);
      }}
      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-indigo-500/40"
    />
  );

  const handleSort = (key: string) => {
    setPage(1);
    let apiSortKey = key;
    if (key === 'group') {
      apiSortKey = 'group_id';
    }
    if (sortKey === apiSortKey) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(apiSortKey);
      setSortOrder('asc');
    }
  };

  const renderSortIcon = (key: string) => {
    let apiSortKey = key;
    if (key === 'group') {
      apiSortKey = 'group_id';
    }
    if (sortKey !== apiSortKey) return null;
    return sortOrder === 'asc' ? (
      <ArrowUp size={12} className="inline ml-1 text-indigo-400" />
    ) : (
      <ArrowDown size={12} className="inline ml-1 text-indigo-400" />
    );
  };

  // Submitting States
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [provSubmitting, setProvSubmitting] = useState(false);
  const [provError, setProvError] = useState('');

  // Bulk Delete State
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Record<number, boolean>>({});

  // Typing is debounced before it reaches the network. `searchQuery` is a
  // dependency of the fetch effect below, so without this every keystroke tore
  // down the poll and issued a fresh /api/nodes — an endpoint that does real
  // work per request.
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);

  const fetchNodes = useCallback(async () => {
    try {
      const qParams = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sort_by: sortKey || 'hostname',
        sort_order: sortOrder
      });
      if (debouncedSearch) {
        qParams.append('q', debouncedSearch);
      }
      
      const [nRes, gRes] = await Promise.all([
        fetch(`/api/nodes?${qParams.toString()}`),
        fetch('/api/groups')
      ]);
      if (nRes.ok) {
        const data = await nRes.json();
        setNodes(data.nodes || []);
        setTotalNodes(data.total || 0);
        setTotalPages(data.pages || 1);
      }
      if (gRes.ok) {
        const gData = await gRes.json();
        setGroups(gData);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [page, limit, sortKey, sortOrder, debouncedSearch]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // fetchNodes is memoised on exactly the query inputs this effect used to
  // list, so depending on it is both correct and equivalent — and it cannot
  // drift out of step with the callback the way a duplicated list can.
  useEffect(() => {
    fetchNodes();
    const interval = setInterval(fetchNodes, 5000);
    return () => clearInterval(interval);
  }, [fetchNodes]);

  const handleResponse = async (res: Response) => {
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return res.json();
    }
    const text = await res.text();
    throw new Error(text || `Server returned status ${res.status}`);
  };

  const handleAddNode = async (payload: any) => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await handleResponse(res);
      if (!res.ok) throw new Error(data.detail || 'Failed to add node');

      setShowAddModal(false);
      fetchNodes();
      
      if (data.task_id) {
        onViewLogs(data.task_id, `Bootstrapping nodes`);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleProvisionNode = async (payload: any) => {
    if (!showProvisionModal) return;
    setProvSubmitting(true);
    setProvError('');
    try {
      const res = await fetch(`/api/nodes/${showProvisionModal.id}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await handleResponse(res);
      if (!res.ok) throw new Error(data.detail || 'Failed to trigger provision');

      setShowProvisionModal(null);
      fetchNodes();
      
      if (data.task_id) {
        onViewLogs(data.task_id, `Provisioning ${showProvisionModal.hostname}`);
      }
    } catch (e: any) {
      setProvError(e.message);
    } finally {
      setProvSubmitting(false);
    }
  };

  const handleInstantProvision = useCallback(async (node: Node) => {
    try {
      // default_credentials_id comes off the general settings load, which no
      // longer carries passwords; the credential itself — with its password —
      // is fetched separately, only now that a provisioning request is
      // actually about to be submitted. See GET /api/settings/credentials.
      const [sRes, credsRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/settings/credentials'),
      ]);
      if (!sRes.ok) throw new Error('Failed to fetch settings');
      const data = await sRes.json();
      const creds = credsRes.ok ? await credsRes.json() : [];
      const defaultId = data.default_credentials_id;
      let defaultCred = defaultId ? creds.find((c: any) => c.id === defaultId) : null;
      if (!defaultCred && creds.length > 0) {
        defaultCred = creds[0];
      }
      if (defaultCred) {
        setProvSubmitting(true);
        setProvError('');
        const res = await fetch(`/api/nodes/${node.id}/provision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bootstrap_user: defaultCred.username,
            bootstrap_password: defaultCred.password,
            force_orchestrator_proxy: false
          })
        });
        const respData = await res.json();
        if (!res.ok) throw new Error(respData.detail || 'Failed to trigger provision');
        fetchNodes();
        if (respData.task_id) {
          onViewLogs(respData.task_id, `Provisioning ${node.hostname}`);
        }
      } else {
        setShowProvisionModal(node);
      }
    } catch (e: any) {
      alert(e.message || 'Failed to trigger provisioning');
    } finally {
      setProvSubmitting(false);
    }
  }, [fetchNodes, onViewLogs]);

  // Every provisioning trigger in the fleet table -- a node that has never
  // been provisioned as much as one that already has -- now asks this same
  // question first, instead of some statuses silently assuming the fleet's
  // default credentials apply and others always demanding a fresh login.
  // "No" opens the same manual form either way.
  const handleProvisionClick = useCallback((node: Node) => {
    const useDefault = window.confirm(
      t('useDefaultCredentialsConfirm').replace('{hostname}', node.hostname)
    );
    if (useDefault) {
      handleInstantProvision(node);
    } else {
      setShowProvisionModal(node);
    }
  }, [t, handleInstantProvision]);

  const runPrepare = useCallback(async (nodeId: number, name: string) => {
    try {
      const res = await fetch(`/api/nodes/${nodeId}/prepare`, { method: 'POST' });
      const data = await handleResponse(res);
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to trigger prepare disk task.');
      }
      if (data.task_id) {
        onViewLogs(data.task_id, `Preparing Node ${name}`);
      } else {
        throw new Error('Server did not return a task ID.');
      }
    } catch (e: any) {
      console.error(e);
      alert(`Error: ${e.message}`);
    }
  }, []);

  const stopBackup = async () => {
    if (!showBackupModal) return;
    const node = showBackupModal;
    setShowBackupModal(null);
    try {
      const res = await fetch(`/api/nodes/${node.id}/backup/stop`, { method: 'POST' });
      const data = await handleResponse(res);
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to stop the backup.');
      }
      fetchNodes();
    } catch (e: any) {
      console.error(e);
      alert(`Error: ${e.message}`);
    }
  };

  const runBackup = async (comment: string) => {
    if (!showBackupModal) return;
    const node = showBackupModal;
    setShowBackupModal(null);
    try {
      const res = await fetch(`/api/nodes/${node.id}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment })
      });
      const data = await handleResponse(res);
      if (!res.ok) {
        throw new Error(data.detail || 'Failed to trigger backup task.');
      }
      if (data.task_id) {
        onViewLogs(data.task_id, `Backing up Node ${node.hostname}`);
      } else {
        throw new Error('Server did not return a task ID.');
      }
    } catch (e: any) {
      console.error(e);
      alert(`Error: ${e.message}`);
    }
  };

  const handleBulkDelete = async () => {
    const idsToDelete = Object.keys(selectedNodeIds)
      .map(Number)
      .filter(id => selectedNodeIds[id]);
    
    if (idsToDelete.length === 0) return;

    if (!window.confirm(t('bulkDeleteConfirm', { count: idsToDelete.length }))) {
      return;
    }

    setLoading(true);
    try {
      await Promise.all(idsToDelete.map(async (id) => {
        const res = await fetch(`/api/nodes/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || `Failed to delete node ${id}`);
        }
      }));
      
      setSelectedNodeIds({});
      setBulkDeleteMode(false);
      fetchNodes();
    } catch (e: any) {
      alert(`Error during bulk deletion: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteNode = useCallback(async (nodeId: number, name: string) => {
    if (!window.confirm(t('deleteNodeConfirm'))) {
      return;
    }
    try {
      const res = await fetch(`/api/nodes/${nodeId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'Failed to delete node');
      }
      fetchNodes();
    } catch (e: any) {
      alert(e.message);
    }
  }, [t, fetchNodes]);

  const handleSaveSshLogin = useCallback(async (nodeId: number, hostname: string, login: string) => {
    try {
      await api.post(`/api/nodes/${nodeId}/ssh-login`, { ssh_login: login });
      fetchNodes();
    } catch (e: any) {
      alert(e.message || `Failed to save the SSH login for '${hostname}'`);
    }
  }, [fetchNodes]);

  // Every callback below is stable across renders so that React.memo on
  // NodeRow can actually skip work. A closure rebuilt each render looks like a
  // changed prop, and the memo silently does nothing.
  const handleSelectNode = useCallback((nodeId: number, checked: boolean) => {
    setSelectedNodeIds(prev => ({ ...prev, [nodeId]: checked }));
  }, []);

  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedGroups(prev => ({ ...prev, [groupKey]: !prev[groupKey] }));
  }, []);

  const handleShowDetails = useCallback((nodeId: number) => setSelectedNodeDetails(nodeId), []);

  const handleOpenTerminal = useCallback((node: Node) => setTerminalNode(node), []);

  const handleShowBackup = useCallback((node: Node) => {
    // A backup already in flight has a log to watch; otherwise ask for a
    // comment and start one.
    if (node.is_backup_running && node.backup_task_id) {
      onViewLogs(node.backup_task_id, `Backing up ${node.hostname}`);
    } else {
      setShowBackupModal(node);
    }
  }, [onViewLogs]);

  const groupsById = useMemo(
    () => new Map(groups.map(g => [g.id, g])),
    [groups],
  );

  const renderNodeRow = (node: Node) => {
    const group = node.group_id === null ? null : groupsById.get(node.group_id) ?? null;
    return (
      <NodeRow
        key={node.id}
        node={node}
        bulkDeleteMode={bulkDeleteMode}
        isSelected={!!selectedNodeIds[node.id]}
        onSelectNode={handleSelectNode}
        onRunPrepare={runPrepare}
        onProvisionClick={handleProvisionClick}
        onShowBackup={handleShowBackup}
        onDeleteNode={handleDeleteNode}
        onShowDetails={handleShowDetails}
        onSaveSshLogin={handleSaveSshLogin}
        onOpenTerminal={handleOpenTerminal}
        currentUser={currentUser}
        groupName={group ? group.name : null}
        groupRateLimit={group ? group.upload_rate_limit : null}
        timezone={timezone}
      />
    );
  };

  const renderGroupedContent = () => {
    if (grouping === 'flat') {
      return nodes.map(node => renderNodeRow(node));
    }

    if (grouping === 'prefix') {
      const groups: Record<string, Node[]> = {};
      nodes.forEach(node => {
        const match = node.hostname.match(/^([^0-9.-]+)/);
        const prefix = match ? match[1] : 'Other';
        if (!groups[prefix]) groups[prefix] = [];
        groups[prefix].push(node);
      });

      return Object.keys(groups).sort().map(prefix => {
        const isExpanded = !!expandedGroups[prefix];
        const groupNodes = groups[prefix];
        return (
          <React.Fragment key={prefix}>
            <tr className="bg-zinc-900/60 cursor-pointer hover:bg-zinc-800/20 transition-colors border-y border-zinc-800" onClick={() => toggleGroup(prefix)}>
              <td colSpan={bulkDeleteMode ? 8 : 7} className="px-6 py-3 font-semibold text-zinc-200 select-none">
                <div className="flex items-center gap-2">
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  {isExpanded ? <FolderOpen size={16} className="text-indigo-400" /> : <Folder size={16} className="text-indigo-400" />}
                  <span>{prefix} ({groupNodes.length})</span>
                </div>
              </td>
            </tr>
            {isExpanded && groupNodes.map(node => renderNodeRow(node))}
          </React.Fragment>
        );
      });
    }

    if (grouping === 'subnet') {
      const rootTree: any = {};
      nodes.forEach(node => {
        const parts = node.ip_address.split('.');
        if (parts.length !== 4) return;
        const o1 = parts[0] + '.x.x.x';
        const o2 = parts[0] + '.' + parts[1] + '.x.x';
        const o3 = parts[0] + '.' + parts[1] + '.' + parts[2] + '.x';

        if (!rootTree[o1]) rootTree[o1] = {};
        if (!rootTree[o1][o2]) rootTree[o1][o2] = {};
        if (!rootTree[o1][o2][o3]) rootTree[o1][o2][o3] = [];
        rootTree[o1][o2][o3].push(node);
      });

      const rows: React.ReactNode[] = [];
      Object.keys(rootTree).sort().forEach(o1 => {
        const isO1Expanded = !!expandedGroups[o1];
        rows.push(
          <tr key={o1} className="bg-zinc-900/80 cursor-pointer hover:bg-zinc-800/20 transition-colors border-y border-zinc-800" onClick={() => toggleGroup(o1)}>
            <td colSpan={bulkDeleteMode ? 8 : 7} className="px-6 py-2.5 font-bold text-zinc-100 select-none">
              <div className="flex items-center gap-2">
                {isO1Expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Folder size={14} className="text-zinc-400" />
                <span>Subnet: {o1}</span>
              </div>
            </td>
          </tr>
        );

        if (isO1Expanded) {
          const o2Tree = rootTree[o1];
          Object.keys(o2Tree).sort().forEach(o2 => {
            const o2Key = `${o1}/${o2}`;
            const isO2Expanded = !!expandedGroups[o2Key];
            rows.push(
              <tr key={o2Key} className="bg-zinc-900/40 cursor-pointer hover:bg-zinc-800/10 transition-colors border-y border-zinc-800/50" onClick={() => toggleGroup(o2Key)}>
                <td colSpan={bulkDeleteMode ? 8 : 7} className="px-6 py-2.5 font-semibold text-zinc-300 select-none" style={{ paddingLeft: '36px' }}>
                  <div className="flex items-center gap-2">
                    {isO2Expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Folder size={14} className="text-zinc-500" />
                    <span>Subnet: {o2}</span>
                  </div>
                </td>
              </tr>
            );

            if (isO2Expanded) {
              const o3Tree = o2Tree[o2];
              Object.keys(o3Tree).sort().forEach(o3 => {
                const o3Key = `${o2Key}/${o3}`;
                const isO3Expanded = !!expandedGroups[o3Key];
                const subnetNodes = o3Tree[o3];
                rows.push(
                  <tr key={o3Key} className="bg-zinc-900/20 cursor-pointer hover:bg-zinc-800/5 transition-colors border-y border-zinc-800/20" onClick={() => toggleGroup(o3Key)}>
                    <td colSpan={bulkDeleteMode ? 8 : 7} className="px-6 py-2 font-medium text-zinc-400 select-none" style={{ paddingLeft: '54px' }}>
                      <div className="flex items-center gap-2">
                        {isO3Expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <FolderOpen size={14} className="text-indigo-400/80" />
                        <span>Subnet: {o3} ({subnetNodes.length})</span>
                      </div>
                    </td>
                  </tr>
                );

                if (isO3Expanded) {
                  subnetNodes.forEach((node: Node) => {
                    rows.push(renderNodeRow(node));
                  });
                }
              });
            }
          });
        }
      });

      return rows;
    }

    return null;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-50">{t('nodeListTitle')}</h2>
          <p className="text-sm text-zinc-400">{t('nodeListSub')}</p>
        </div>
        <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end">
          <button
            onClick={() => {
              setBulkDeleteMode(!bulkDeleteMode);
              setSelectedNodeIds({});
            }}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg font-semibold border transition-colors self-stretch sm:self-auto justify-center text-xs ${
              bulkDeleteMode
                ? 'bg-rose-600/20 border-rose-500/40 text-rose-400 hover:bg-rose-600/30'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
            }`}
            title={t('bulkDelete')}
          >
            {bulkDeleteMode ? <CheckSquare size={16} /> : <Square size={16} />}
            <Trash2 size={16} />
          </button>
          
          {bulkDeleteMode && Object.values(selectedNodeIds).filter(Boolean).length > 0 && (
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1.5 px-3 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-semibold text-xs transition-colors self-stretch sm:self-auto justify-center"
            >
              <Trash2 size={16} /> {t('deleteSelected')} ({Object.values(selectedNodeIds).filter(Boolean).length})
            </button>
          )}

          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold text-xs transition-colors self-stretch sm:self-auto justify-center"
          >
            <Plus size={16} /> {t('addNode')}
          </button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 bg-zinc-900/40 p-4 rounded-xl border border-zinc-800">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="w-full pl-9 pr-4 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2 border-l border-zinc-800 pl-0 md:pl-4">
          <span className="text-xs text-zinc-400 font-medium whitespace-nowrap">{t('levelLabel')}:</span>
          <div className="inline-flex rounded-lg border border-zinc-800 p-0.5 bg-zinc-950">
            {(['flat', 'prefix', 'subnet'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setGrouping(mode)}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors capitalize ${grouping === mode ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white'}`}
              >
                {mode === 'flat' ? t('flatView') : mode === 'prefix' ? t('prefixGrouping') : t('subnetGrouping')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50 backdrop-blur-md">
        <table
          ref={tableRef}
          className={`${columnWidths ? 'table-fixed' : ''} w-full divide-y divide-zinc-800 text-left text-sm text-zinc-300`}
        >
          {columnWidths && (
            <colgroup>
              {bulkDeleteMode && <col style={{ width: 40 }} />}
              <col style={{ width: columnWidths.hostname }} />
              <col style={{ width: columnWidths.ip_address }} />
              <col style={{ width: columnWidths.os_version }} />
              <col style={{ width: columnWidths.disk_type }} />
              <col style={{ width: columnWidths.status }} />
              <col style={{ width: columnWidths.last_backup }} />
              {/* No explicit width: with table-fixed, this is the one column
                  without a specified width, so it alone absorbs whatever
                  space the other (fixed-width) columns don't use — the last
                  column fills the row rather than leaving a gap. */}
              <col />
            </colgroup>
          )}
          <thead className="bg-zinc-950/60 text-[11px] font-bold uppercase tracking-wider text-zinc-400 border-b border-zinc-800">
            <tr className="divide-x divide-zinc-800/70">
              {bulkDeleteMode && (
                <th className="px-3.5 py-3 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={nodes.length > 0 && nodes.every(n => selectedNodeIds[n.id])}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      const newSelection: Record<number, boolean> = {};
                      if (checked) {
                        nodes.forEach(n => { newSelection[n.id] = true; });
                      }
                      setSelectedNodeIds(newSelection);
                    }}
                    className="rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500 h-4 w-4 cursor-pointer"
                  />
                </th>
              )}
              <th data-col-key="hostname" className="relative px-3.5 py-3 text-center select-none whitespace-nowrap">
                <div className="flex items-center justify-center gap-2 text-zinc-400">
                  <span
                    className={`cursor-pointer transition-colors hover:text-white ${sortKey === 'hostname' ? 'text-white font-bold' : ''}`}
                    onClick={() => handleSort('hostname')}
                  >
                    {t('hostnameLabel') || 'Hostname'}
                    {renderSortIcon('hostname')}
                  </span>
                  <span>/</span>
                  <span
                    className={`cursor-pointer transition-colors hover:text-white ${sortKey === 'group' ? 'text-white font-bold' : ''}`}
                    onClick={() => handleSort('group')}
                  >
                    {t('groupLabel') || 'Group'}
                    {renderSortIcon('group')}
                  </span>
                </div>
                <ColumnResizeHandle columnKey="hostname" />
              </th>
              <th data-col-key="ip_address" className="relative px-3.5 py-3 text-center cursor-pointer hover:bg-zinc-800/60 hover:text-white transition-colors select-none whitespace-nowrap" onClick={() => handleSort('ip_address')}>
                <div className="flex items-center justify-center gap-1">
                  {t('fleetIpPortLabel')}
                  {renderSortIcon('ip_address')}
                </div>
                <ColumnResizeHandle columnKey="ip_address" />
              </th>
              <th data-col-key="os_version" className="relative px-3.5 py-3 text-center cursor-pointer hover:bg-zinc-800/60 hover:text-white transition-colors select-none whitespace-nowrap" onClick={() => handleSort('os_version')}>
                <div className="flex items-center justify-center gap-1">
                  {t('osVersion') || 'OS Version'}
                  {renderSortIcon('os_version')}
                </div>
                <ColumnResizeHandle columnKey="os_version" />
              </th>
              <th data-col-key="disk_type" className="relative px-3.5 py-3 text-center cursor-pointer hover:bg-zinc-800/60 hover:text-white transition-colors select-none whitespace-nowrap" onClick={() => handleSort('disk_type')}>
                <div className="flex items-center justify-center gap-1">
                  {t('diskInterface') || 'Disk & Interface'}
                  {renderSortIcon('disk_type')}
                </div>
                <ColumnResizeHandle columnKey="disk_type" />
              </th>
              <th data-col-key="status" className="relative px-3.5 py-3 text-center cursor-pointer hover:bg-zinc-800/60 hover:text-white transition-colors select-none whitespace-nowrap" onClick={() => handleSort('status')}>
                <div className="flex items-center justify-center gap-1">
                  {t('statusAction') || 'Status / Action'}
                  {renderSortIcon('status')}
                </div>
                <ColumnResizeHandle columnKey="status" />
              </th>
              <th data-col-key="last_backup" className="relative px-3.5 py-3 text-center cursor-pointer hover:bg-zinc-800/60 hover:text-white transition-colors select-none whitespace-nowrap" onClick={() => handleSort('last_backup')}>
                <div className="flex items-center justify-center gap-1">
                  {t('lastBackup') || 'Last Backup'}
                  {renderSortIcon('last_backup')}
                </div>
                <ColumnResizeHandle columnKey="last_backup" />
              </th>
              <th className="px-3.5 py-3 text-center select-none whitespace-nowrap">
                {t('actions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {loading ? (
              <tr>
                <td colSpan={bulkDeleteMode ? 8 : 7} className="px-6 py-8 text-center text-zinc-500">{t('loadingFleetData') || 'Loading fleet data...'}</td>
              </tr>
            ) : nodes.length === 0 ? (
              <tr>
                <td colSpan={bulkDeleteMode ? 8 : 7} className="px-6 py-8 text-center text-zinc-500">{t('noNodesMatchFilter') || 'No nodes match your filter.'}</td>
              </tr>
            ) : (
              renderGroupedContent()
            )}
          </tbody>
        </table>
        {/* Pagination Footer */}
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 px-6 py-4 border-t border-zinc-800 bg-zinc-900/20 text-xs font-semibold text-zinc-400">
          <div>
            {t('showingLabel')} <span className="text-zinc-200">{totalNodes === 0 ? 0 : (page - 1) * limit + 1}</span>{" "}
            {t('toLabel')}{" "}
            <span className="text-zinc-200">{Math.min(page * limit, totalNodes)}</span>{" "}
            {t('ofLabel')}{" "}
            <span className="text-zinc-200">{totalNodes}</span>{" "}
            {t('nodesLabel')}
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span>{t('rowsPerPage')}:</span>
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500 cursor-pointer"
              >
                {[10, 25, 50, 100].map(val => (
                  <option key={val} value={val}>{val}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(prev => Math.max(1, prev - 1))}
                disabled={page === 1}
                className="px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded hover:border-zinc-700 text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {t('prev')}
              </button>
              <span className="px-3 text-zinc-300">
                {t('pageLabel')} {page} {t('ofLabel')} {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage(prev => Math.min(totalPages, prev + 1))}
                disabled={page === totalPages}
                className="px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded hover:border-zinc-700 text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {t('next')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showAddModal && <AddNodeModal onClose={() => setShowAddModal(false)} onSubmit={handleAddNode} submitting={submitting} error={error} />}
      {showProvisionModal && <ProvisionNodeModal node={showProvisionModal} onClose={() => setShowProvisionModal(null)} onSubmit={handleProvisionNode} submitting={provSubmitting} error={provError} />}
      {showBackupModal && <BackupCommentModal node={showBackupModal} onClose={() => setShowBackupModal(null)} onSubmit={runBackup} onStop={stopBackup} />}
      {terminalNode && <TerminalModal node={terminalNode} onClose={() => setTerminalNode(null)} />}
      {selectedNodeDetails !== null && (
        <NodeDetailsModal
          nodeId={selectedNodeDetails}
          onClose={() => setSelectedNodeDetails(null)}
          onRefreshList={fetchNodes}
        />
      )}
    </div>
  );
}
