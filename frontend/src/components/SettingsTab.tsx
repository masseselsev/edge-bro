import React, { useState, useEffect } from 'react';
import { Save, Settings as Gear, CheckCircle, Trash2, AlertTriangle } from 'lucide-react';
import { SearchableSelect, DropdownTextInput } from './SearchableSelect';
import type { Option } from './SearchableSelect';
import { useTranslation } from '../context/TranslationContext';
import type { Language } from '../i18n';
import AdminsTab from './AdminsTab';
import AuditLogsTab from './AuditLogsTab';
import SshKeysTab from './SshKeysTab';
import AlertsTab from './AlertsTab';
import { CredentialsModal } from './CredentialsModal';
import { InfoLabel } from './InfoLabel';
import RepositoryCapacityPanel from './RepositoryCapacityPanel';
import { api } from '../api';
import { kibToMbit, mbitToKib, parseMbitInput, formatMbit } from './rateLimit';

interface SettingsTabProps {
  onSettingsUpdated?: (settings: any) => void;
  currentUser?: any;
}

export default function SettingsTab({ onSettingsUpdated, currentUser }: SettingsTabProps) {
  const { t, setLanguage } = useTranslation();
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'admins' | 'audit' | 'kiosk_logs' | 'ssh_keys' | 'alerts'>('general');
  const [sshPort, setSshPort] = useState(12345);
  const [policyType, setPolicyType] = useState<'interval' | 'count' | 'timeframe'>('interval');
  const [policyKeepDaily, setPolicyKeepDaily] = useState(7);
  const [policyKeepWeekly, setPolicyKeepWeekly] = useState(4);
  const [policyKeepMonthly, setPolicyKeepMonthly] = useState(6);
  const [policyKeepLast, setPolicyKeepLast] = useState(5);
  const [policyWithinValue, setPolicyWithinValue] = useState(3);
  const [policyWithinUnit, setPolicyWithinUnit] = useState<'d' | 'w' | 'm' | 'y'>('m');
  const [globalExclusions, setGlobalExclusions] = useState<{ pattern: string, comment: string }[]>([]);
  const [newExclusionInput, setNewExclusionInput] = useState('');
  const [newExclusionComment, setNewExclusionComment] = useState('');
  const [orchestratorIp, setOrchestratorIp] = useState('');
  const [orchestratorBehindNat, setOrchestratorBehindNat] = useState(false);
  const [allowAdminKeyTerminalAccess, setAllowAdminKeyTerminalAccess] = useState(false);
  const [availableIps, setAvailableIps] = useState<string[]>([]);
  const [manualIps, setManualIps] = useState<string[]>([]);
  const [newIpInput, setNewIpInput] = useState('');
  const [language, setLanguageState] = useState<Language>('en');
  const [defaultCompression, setDefaultCompression] = useState('zstd:3');
  const [defaultCpuQuota, setDefaultCpuQuota] = useState<number | ''>('');
  const [defaultRateLimit, setDefaultRateLimit] = useState<string>('');
  const [hostDataPath, setHostDataPath] = useState<string | null>(null);
  const [maxKioskIsos, setMaxKioskIsos] = useState(5);
  const [serverNetCapacityMbps, setServerNetCapacityMbps] = useState<number | ''>(1000);
  // '' means unset — kept forever. See models.Settings.thermal_fit_retention_days.
  const [thermalFitRetentionDays, setThermalFitRetentionDays] = useState<number | ''>('');

  const [serverName, setServerName] = useState('orchestrator');
  const [bootstrapCredentials, setBootstrapCredentials] = useState<{ id: string, username: string, password: string, comment?: string }[]>([]);
  const [defaultCredentialsId, setDefaultCredentialsId] = useState('');
  const [isCredentialsModalOpen, setIsCredentialsModalOpen] = useState(false);
  const [credUsernameInput, setCredUsernameInput] = useState('');
  const [credPasswordInput, setCredPasswordInput] = useState('');
  
  const [useLocalTime, setUseLocalTime] = useState(true);
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
    } catch (e) {
      return 'Europe/Moscow';
    }
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [warnings, setWarnings] = useState<{ code: string; message: string }[]>([]);

  // Generate options
  const timezoneOptions: Option[] = React.useMemo(() => {
    let zones: string[] = [];
    try {
      zones = (Intl as any).supportedValuesOf('timeZone') || [];
    } catch (e) {
      zones = [
        'UTC', 'Europe/Moscow', 'Europe/London', 'Europe/Paris', 
        'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 
        'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Yekaterinburg'
      ];
    }
    return zones.map(tz => ({
      value: tz,
      label: tz
    }));
  }, []);

  const compressionOptions = React.useMemo(() => [
    { value: 'none', label: 'none' },
    { value: 'lz4', label: 'lz4' },
    { value: 'zstd:1', label: 'zstd:1' },
    { value: 'zstd:3', label: 'zstd:3' },
    { value: 'zstd:5', label: 'zstd:5' },
    { value: 'zstd:9', label: 'zstd:9' }
  ], []);

  const policyTypeOptions = React.useMemo(() => [
    { value: 'interval', label: t('policyInterval') },
    { value: 'count', label: t('policyCount') },
    { value: 'timeframe', label: t('policyTimeframe') }
  ], [t]);

  const unitOptions = React.useMemo(() => [
    { value: 'd', label: t('timeframeUnitDays') },
    { value: 'w', label: t('timeframeUnitWeeks') },
    { value: 'm', label: t('timeframeUnitMonths') },
    { value: 'y', label: t('timeframeUnitYears') }
  ], [t]);

  useEffect(() => {
    // Credentials come from a separate, narrower endpoint: GET /api/settings
    // no longer carries bootstrap_credentials[].password (see
    // schemas.SettingsResponse), because it's loaded on every page across the
    // app and a plaintext SSH password has no business riding along with the
    // timezone. This is the credentials-management screen, so it fetches the
    // real values explicitly.
    api.get<{ id: string; username: string; password: string; comment?: string }[]>('/api/settings/credentials')
      .then(creds => setBootstrapCredentials(creds || []))
      .catch(err => console.error(err));

    api.get<any>('/api/settings')
      .then(data => {
        setSshPort(data.borg_ssh_port);

        const rp = data.retention_policy;
        if (rp) {
          setPolicyType(rp.type || 'interval');
          setPolicyKeepDaily(rp.keep_daily ?? 7);
          setPolicyKeepWeekly(rp.keep_weekly ?? 4);
          setPolicyKeepMonthly(rp.keep_monthly ?? 6);
          setPolicyKeepLast(rp.keep_last ?? 5);
          setPolicyWithinValue(rp.within_value ?? 3);
          setPolicyWithinUnit(rp.within_unit || 'm');
        } else {
          setPolicyType('interval');
          setPolicyKeepDaily(data.keep_daily ?? 7);
          setPolicyKeepWeekly(data.keep_weekly ?? 4);
          setPolicyKeepMonthly(data.keep_monthly ?? 6);
        }

        setGlobalExclusions([...(data.global_exclusions || [])].sort((a, b) => a.pattern.localeCompare(b.pattern)));
        setOrchestratorIp(data.orchestrator_ip || '');
        setOrchestratorBehindNat(!!data.orchestrator_behind_nat);
        setAllowAdminKeyTerminalAccess(!!data.allow_admin_key_terminal_access);
        setAvailableIps(data.available_ips || []);
        setLanguageState(data.language || 'en');
        setDefaultCompression(data.default_compression || 'zstd:3');
        setDefaultCpuQuota(data.default_cpu_quota ?? '');
        setDefaultRateLimit(
          data.default_rate_limit != null ? formatMbit(kibToMbit(data.default_rate_limit)) : ''
        );
        if (data.borg_host_data_path) {
          setHostDataPath(data.borg_host_data_path);
        }
        setManualIps(data.server_ips || []);
        if (data.max_kiosk_isos !== undefined) {
          setMaxKioskIsos(data.max_kiosk_isos);
        }
        if (data.server_net_capacity_mbps !== undefined) {
          setServerNetCapacityMbps(data.server_net_capacity_mbps);
        }
        setThermalFitRetentionDays(data.thermal_fit_retention_days ?? '');

        if (data.server_name !== undefined) {
          setServerName(data.server_name || 'edge-bro');
        }
        // bootstrapCredentials is loaded above from /api/settings/credentials;
        // this response's copy is password-less and would clobber it.
        if (data.default_credentials_id !== undefined) {
          setDefaultCredentialsId(data.default_credentials_id || '');
        }
        
        const dbTz = data.timezone || 'Browser Local';
        let resolvedTz = 'Europe/Moscow';
        try {
          resolvedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
        } catch (e) {}

        if (dbTz === 'Browser Local') {
          setUseLocalTime(true);
          setTimezone(resolvedTz);
        } else {
          setUseLocalTime(false);
          setTimezone(dbTz);
        }
        
        api.get<any>('/api/health')
          .then(hdata => {
            if (hdata.warnings) {
              setWarnings(hdata.warnings);
            }
            setLoading(false);
          })
          .catch(() => {
            setLoading(false);
          });
      })
      .catch(e => {
        console.error(e);
        setLoading(false);
      });
  }, []);

  /**
   * The complete settings payload, from current form state.
   *
   * POST /api/settings replaces the whole row, so every field has to be
   * present on every save. This was written out twice — once here and once in
   * the credentials modal's onChange — and the two copies had already drifted:
   * a field added to one was silently reverted by the other the next time it
   * fired.
   */
  const buildSettingsPayload = (overrides: Record<string, any> = {}) => ({
    borg_ssh_port: sshPort,
    keep_daily: policyKeepDaily,
    keep_weekly: policyKeepWeekly,
    keep_monthly: policyKeepMonthly,
    global_exclusions: globalExclusions,
    orchestrator_ip: orchestratorIp,
    orchestrator_behind_nat: orchestratorBehindNat,
    allow_admin_key_terminal_access: allowAdminKeyTerminalAccess,
    // 'Browser Local' is stored as a literal so the server knows the
    // operator wants whatever the viewing browser says, not a fixed zone.
    timezone: useLocalTime ? 'Browser Local' : timezone,
    language: language,
    default_compression: defaultCompression,
    default_cpu_quota: defaultCpuQuota === '' ? null : Number(defaultCpuQuota),
    default_rate_limit: (() => {
      const parsed = parseMbitInput(defaultRateLimit);
      return parsed === null ? null : mbitToKib(parsed);
    })(),
    server_ips: manualIps,
    max_kiosk_isos: maxKioskIsos,
    server_name: serverName,
    server_net_capacity_mbps: serverNetCapacityMbps === '' ? 1000 : Number(serverNetCapacityMbps),
    thermal_fit_retention_days: thermalFitRetentionDays === '' ? null : Number(thermalFitRetentionDays),

    bootstrap_credentials: bootstrapCredentials,
    default_credentials_id: defaultCredentialsId,
    retention_policy: {
      type: policyType,
      keep_daily: policyKeepDaily,
      keep_weekly: policyKeepWeekly,
      keep_monthly: policyKeepMonthly,
      keep_last: policyKeepLast,
      within_value: policyWithinValue,
      within_unit: policyWithinUnit
    },
    ...overrides,
  });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSuccess(false);
    
    const serverNamePattern = /^[a-zA-Z0-9_-]+$/;
    if (!serverNamePattern.test(serverName)) {
      alert(t('serverNameError') || 'Server name must contain only letters, numbers, hyphens, and underscores, without spaces.');
      setSaving(false);
      return;
    }
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSettingsPayload()),
      });
      if (res.ok) {
        const data = await res.json();
        setSuccess(true);
        setAvailableIps(data.available_ips || []);
        setLanguage(data.language);
        // This save does not touch credentials, and the response's copy is
        // password-less — nothing to resync bootstrapCredentials from here.
        if (data.default_credentials_id !== undefined) {
          setDefaultCredentialsId(data.default_credentials_id || '');
        }
        if (onSettingsUpdated) {
          onSettingsUpdated(data);
        }
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-zinc-500 text-center py-8">{t('saving')}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-50 flex items-center gap-2">
            <Gear size={24} className="text-indigo-400" />
            {t('orchestratorSettings')}
          </h2>
          <p className="text-sm text-zinc-400 mt-1">{t('orchestratorSettingsSub')}</p>
        </div>
        {activeSubTab === 'general' && (
          <div className="flex items-center gap-3 shrink-0">
            {success && (
              <span className="text-emerald-400 text-xs flex items-center gap-1.5">
                <CheckCircle size={14} /> {t('settingsSuccess')}
              </span>
            )}
            <button
              type="submit"
              form="settings-form"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-sm tracking-wide shadow transition-colors disabled:opacity-50 shrink-0"
            >
              <Save size={16} /> {saving ? t('saving') : t('saveSettings')}
            </button>
          </div>
        )}
      </div>

      {(currentUser?.is_superadmin || currentUser?.is_admin_plus) && (
        <div className="flex border-b border-zinc-800 gap-4 text-xs font-bold pb-px mb-2">
          <button
            type="button"
            onClick={() => setActiveSubTab('general')}
            className={`pb-2 border-b-2 px-1 transition-all cursor-pointer outline-none ${
              activeSubTab === 'general'
                ? 'border-indigo-500 text-zinc-150'
                : 'border-transparent text-zinc-450 hover:text-zinc-300'
            }`}
          >
            {t('orchestratorSettings')}
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('admins')}
            className={`pb-2 border-b-2 px-1 transition-all cursor-pointer outline-none ${
              activeSubTab === 'admins'
                ? 'border-indigo-500 text-zinc-150'
                : 'border-transparent text-zinc-450 hover:text-zinc-300'
            }`}
          >
            {t('tabAdmins')}
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('audit')}
            className={`pb-2 border-b-2 px-1 transition-all cursor-pointer outline-none ${
              activeSubTab === 'audit'
                ? 'border-indigo-500 text-zinc-150'
                : 'border-transparent text-zinc-450 hover:text-zinc-300'
            }`}
          >
            {t('tabAuditLogs')}
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('ssh_keys')}
            className={`pb-2 border-b-2 px-1 transition-all cursor-pointer outline-none ${
              activeSubTab === 'ssh_keys'
                ? 'border-indigo-500 text-zinc-150'
                : 'border-transparent text-zinc-450 hover:text-zinc-300'
            }`}
          >
            {t('tabSshKeys')}
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('kiosk_logs')}
            className={`pb-2 border-b-2 px-1 transition-all cursor-pointer outline-none ${
              activeSubTab === 'kiosk_logs'
                ? 'border-indigo-500 text-zinc-150'
                : 'border-transparent text-zinc-450 hover:text-zinc-300'
            }`}
          >
            {t('tabKioskLogs') || 'Kiosk Logs'}
          </button>
          <button
            type="button"
            onClick={() => setActiveSubTab('alerts')}
            className={`pb-2 border-b-2 px-1 transition-all cursor-pointer outline-none ${
              activeSubTab === 'alerts'
                ? 'border-indigo-500 text-zinc-150'
                : 'border-transparent text-zinc-450 hover:text-zinc-300'
            }`}
          >
            {t('alertsTabLabel')}
          </button>
        </div>
      )}

      {activeSubTab === 'admins' && (currentUser?.is_superadmin || currentUser?.is_admin_plus) ? (
        <AdminsTab currentUser={currentUser} />
      ) : activeSubTab === 'audit' && (currentUser?.is_superadmin || currentUser?.is_admin_plus) ? (
        <AuditLogsTab timezone={timezone} type="admin" />
      ) : activeSubTab === 'ssh_keys' && (currentUser?.is_superadmin || currentUser?.is_admin_plus) ? (
        <SshKeysTab />
      ) : activeSubTab === 'kiosk_logs' && (currentUser?.is_superadmin || currentUser?.is_admin_plus) ? (
        <AuditLogsTab timezone={timezone} type="kiosk" />
      ) : activeSubTab === 'alerts' && (currentUser?.is_superadmin || currentUser?.is_admin_plus) ? (
        <AlertsTab currentUser={currentUser} />
      ) : (
        <form id="settings-form" onSubmit={handleSave} className="space-y-6">
          {warnings.length > 0 && (
            <div className="p-4 bg-red-950/40 border border-red-900/60 rounded-xl space-y-2 animate-fade-in">
              <div className="flex items-center gap-2 text-red-400 font-bold text-sm">
                <AlertTriangle size={18} />
                <span>{t('warningsCount')} ({warnings.length})</span>
              </div>
              <ul className="list-disc pl-5 text-xs text-red-300 space-y-1">
                {warnings.map((w, idx) => (
                  <li key={idx}>
                    {w.code === 'BORG_ON_ROOT' || w.code === 'ISO_CACHE_ON_ROOT'
                      ? t('storageRootWarning')
                      : w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* Left Column: General & Connection + Global Pruning */}
            <div className="space-y-6">
              {/* Connection & General Settings */}
              <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4 shadow-xl">
                <h3 className="text-sm font-bold text-zinc-50 border-b border-zinc-850 pb-2">
                  {t('generalConnection')}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
                  <div className="col-span-full">
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <label className="block text-xs font-semibold text-zinc-400">{t('serverNameLabel') || 'Server Name'}</label>
                    </div>
                    <input
                      type="text"
                      required
                      value={serverName}
                      onChange={(e) => setServerName(e.target.value)}
                      placeholder={t('serverNamePlaceholder') || 'e.g. main-server'}
                      className="w-full h-10 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <label className="block text-xs font-semibold text-zinc-400">{t('borgSshPort')}</label>
                    </div>
                    <input
                      type="number"
                      required
                      value={sshPort}
                      onChange={(e) => setSshPort(parseInt(e.target.value))}
                      className="w-full h-10 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <InfoLabel label={t('storageLocation')} hint={t('storageLocationHint')} className="block text-xs font-semibold text-zinc-400" />
                    </div>
                    <div className="w-full h-10 px-3 py-2 bg-zinc-950/60 border border-zinc-800 border-dashed rounded-lg flex items-center">
                      <p className="text-[11px] text-zinc-400 font-mono break-all truncate">
                        {t('storageLocationBackups')}: <span className="text-zinc-200">{hostDataPath || 'borg-data'}</span>
                      </p>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <InfoLabel label={t('compressionMode')} hint={t('compressionModeHint')} className="block text-xs font-semibold text-zinc-400" />
                    </div>
                    <SearchableSelect
                      options={compressionOptions}
                      value={defaultCompression}
                      onChange={setDefaultCompression}
                      placeholder={t('selectCompressionPlaceholder')}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <InfoLabel label={t('cpuQuota')} hint={t('cpuQuotaHint')} className="block text-xs font-semibold text-zinc-400" />
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={400}
                      value={defaultCpuQuota}
                      onChange={(e) => setDefaultCpuQuota(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full h-10 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none font-mono"
                      placeholder="e.g. 50"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <label className="block text-xs font-semibold text-zinc-400">{t('systemTimezone')}</label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          id="useLocalTime"
                          checked={useLocalTime}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setUseLocalTime(checked);
                            if (checked) {
                              try {
                                const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                                if (localTz) {
                                  setTimezone(localTz);
                                }
                              } catch (err) {}
                            }
                          }}
                          className="rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5 cursor-pointer"
                        />
                        <label htmlFor="useLocalTime" className="text-[10px] font-bold text-zinc-500 hover:text-zinc-400 transition-colors uppercase tracking-wider cursor-pointer select-none">
                          {t('useBrowserLocal')}
                        </label>
                      </div>
                    </div>
                    <SearchableSelect
                      options={timezoneOptions}
                      value={timezone}
                      onChange={setTimezone}
                      disabled={useLocalTime}
                      placeholder={t('selectTimezone')}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <InfoLabel
                        label={t('maxKioskIsosLabel') || 'Max Kiosk ISOs in Repository'}
                        hint={t('maxKioskIsosSub') || 'Maximum number of issued kiosk ISOs to keep in history before automatic pruning.'}
                        className="block text-xs font-semibold text-zinc-400"
                      />
                    </div>
                    <input
                      type="number"
                      min={1}
                      required
                      value={maxKioskIsos}
                      onChange={(e) => setMaxKioskIsos(parseInt(e.target.value) || 5)}
                      className="w-full h-10 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <InfoLabel
                        label={t('serverNetCapacityLabel') || 'Server Network Capacity (Mbps)'}
                        hint={t('serverNetCapacityHelp') || 'Used as the 100% capacity limit when rendering network load percentages in the header.'}
                        className="block text-xs font-semibold text-zinc-400"
                      />
                    </div>
                    <input
                      type="number"
                      min={1}
                      required
                      value={serverNetCapacityMbps}
                      onChange={(e) => {
                        const val = e.target.value;
                        setServerNetCapacityMbps(val === '' ? '' : parseInt(val, 10) || 0);
                      }}
                      className="w-full h-10 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between min-h-[20px] mb-1.5">
                      <InfoLabel label={t('defaultRateLimitLabel')} hint={t('defaultRateLimitHint')} className="block text-xs font-semibold text-zinc-400" />
                    </div>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={defaultRateLimit}
                      onChange={(e) => setDefaultRateLimit(e.target.value)}
                      placeholder={t('unlimitedPlaceholder')}
                      className="w-full h-10 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none font-mono"
                    />
                  </div>
                </div>

                {/* Directly under Storage Location, because it answers the one
                    question that panel raises and cannot: whether the backups
                    the schedule produces actually fit the repositories they
                    are routed to. */}
                <RepositoryCapacityPanel />

                <div className="mb-4 space-y-3 border border-zinc-800/80 p-4 rounded-xl bg-zinc-950/40">
                  <div>
                    <label className="block text-xs font-bold text-zinc-300 uppercase tracking-wider">
                      {t('networkAddressesLabel') || 'Orchestrator Network Addresses'}
                    </label>
                    <span className="text-[10px] text-zinc-500 block mt-0.5">
                      {t('networkAddressesSub') || 'Select the default IP to bake into the next kiosk. Auto-detected (A) and manually added (M) options.'}
                    </span>
                  </div>

                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {Array.from(new Set([...availableIps, ...manualIps, ...(orchestratorIp ? [orchestratorIp] : [])])).map((ip) => {
                      const isAuto = availableIps.includes(ip);
                      const isDefault = orchestratorIp === ip;
                      return (
                        <div key={ip} className="flex items-center justify-between p-2 bg-zinc-900/40 border border-zinc-800 rounded-lg hover:border-zinc-700/55 transition-all">
                          <div className="flex items-center gap-3">
                            <input
                              type="radio"
                              name="default_ip"
                              checked={isDefault}
                              onChange={() => setOrchestratorIp(ip)}
                              className="rounded-full border-zinc-700 bg-zinc-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer h-4 w-4"
                            />
                            <span className="text-sm font-semibold text-zinc-100 font-mono">{ip}</span>
                            {isAuto ? (
                              <span className="px-1.5 py-0.5 rounded text-[8px] font-extrabold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" title="Auto-detected interface">A</span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded text-[8px] font-extrabold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20" title="Manually added address">M</span>
                            )}
                            {isDefault && (
                              <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 uppercase tracking-wide">Default</span>
                            )}
                          </div>
                          {!isAuto && (
                            <button
                              type="button"
                              onClick={() => {
                                setManualIps(manualIps.filter((item) => item !== ip));
                                if (isDefault) setOrchestratorIp('');
                              }}
                              className="p-1 hover:bg-rose-500/15 text-rose-400 rounded-md transition-colors cursor-pointer"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex gap-2 border-t border-zinc-800/60 pt-3">
                    <input
                      type="text"
                      placeholder={t('addCustomIpPlaceholder') || 'e.g. 10.0.0.5 or domain.name'}
                      value={newIpInput}
                      onChange={(e) => setNewIpInput(e.target.value)}
                      className="flex-1 px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-xs focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const val = newIpInput.trim();
                        if (val && !manualIps.includes(val)) {
                          setManualIps([...manualIps, val]);
                          if (!orchestratorIp) setOrchestratorIp(val);
                        }
                        setNewIpInput('');
                      }}
                      className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg font-bold text-xs transition-colors cursor-pointer"
                    >
                      {t('addButton') || 'Add'}
                    </button>
                  </div>

                  <label className="flex items-start gap-2.5 pt-3 border-t border-zinc-800/60 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={orchestratorBehindNat}
                      onChange={(e) => setOrchestratorBehindNat(e.target.checked)}
                      className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer h-3.5 w-3.5 shrink-0"
                    />
                    <span>
                      <span className="text-xs font-semibold text-zinc-300 block">
                        {t('orchestratorBehindNatLabel') || 'Orchestrator is behind NAT'}
                      </span>
                      <span className="text-[10px] text-zinc-500 leading-relaxed block mt-0.5">
                        {t('orchestratorBehindNatHint') || "Nodes can't reach this server directly. Backups are tunneled through the orchestrator's own outbound SSH connection to each node instead. Adds encryption overhead on every backup — leave off unless nodes genuinely can't connect directly."}
                      </span>
                    </span>
                  </label>

                  {currentUser?.is_superadmin && (
                    <label className="flex items-start gap-2.5 pt-3 border-t border-zinc-800/60 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allowAdminKeyTerminalAccess}
                        onChange={(e) => setAllowAdminKeyTerminalAccess(e.target.checked)}
                        className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer h-3.5 w-3.5 shrink-0"
                      />
                      <span>
                        <span className="text-xs font-semibold text-zinc-300 block">
                          {t('allowAdminKeyTerminalAccessLabel')}
                        </span>
                        <span className="text-[10px] text-zinc-500 leading-relaxed block mt-0.5">
                          {t('allowAdminKeyTerminalAccessHint')}
                        </span>
                      </span>
                    </label>
                  )}
                </div>

                {/* Bootstrap Credentials management sub-card */}
                <div className="mb-4 space-y-3 border border-zinc-800/80 p-4 rounded-xl bg-zinc-950/40">
                  <div>
                    <label className="block text-xs font-bold text-zinc-300 uppercase tracking-wider">
                      {t('bootstrapCredentials')}
                    </label>
                    <span className="text-[10px] text-zinc-500 block mt-0.5">
                      {t('bootstrapCredentialsSub')}
                    </span>
                  </div>

                  <div className="flex items-center justify-between p-2.5 bg-zinc-900/40 border border-zinc-800 rounded-lg">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-zinc-400 font-semibold uppercase tracking-wider">{t('defaultCredentialsLabel')}</span>
                      {defaultCredentialsId ? (
                        (() => {
                          const activeCred = bootstrapCredentials.find(c => c.id === defaultCredentialsId);
                          return activeCred ? (
                            <span className="text-sm font-bold text-indigo-400 font-mono">{activeCred.username}</span>
                          ) : (
                            <span className="text-xs text-zinc-500 font-semibold">{t('manualInputSelect')}</span>
                          );
                        })()
                      ) : (
                        <span className="text-xs text-zinc-500 font-semibold">{t('manualInputSelect')}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsCredentialsModalOpen(true)}
                      className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-xs transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      <Gear size={13} />
                      {t('manageCredentialsBtn')}
                    </button>
                  </div>
                </div>

                {/* Advanced / rarely touched — its own hint already says
                    "recommended: leave empty", the same category as the two
                    sub-cards above it, not a routinely-tuned knob. */}
                <div className="mb-4 space-y-3 border border-zinc-800/80 p-4 rounded-xl bg-zinc-950/40">
                  <div>
                    <InfoLabel
                      label={t('thermalFitRetentionLabel')}
                      hint={t('thermalFitRetentionHelp')}
                      className="block text-xs font-bold text-zinc-300 uppercase tracking-wider"
                    />
                  </div>
                  <input
                    type="number"
                    min={1}
                    placeholder={t('unlimitedPlaceholder')}
                    value={thermalFitRetentionDays}
                    onChange={(e) => {
                      const val = e.target.value;
                      setThermalFitRetentionDays(val === '' ? '' : parseInt(val, 10) || 1);
                    }}
                    className="w-full max-w-xs h-10 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Right Column: Global File Exclusion Paths + Retention Policies
                (moved below the exclusions list so it reads as a follow-on
                section rather than competing with it side-by-side). */}
            <div className="space-y-6">
            <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4 shadow-xl">
              <div className="flex items-center justify-between border-b border-zinc-850 pb-2">
                <InfoLabel
                  label={t('globalExclusionsLabel')}
                  hint={t('globalExclusionsHint')}
                  className="text-sm font-bold text-zinc-50"
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const data = await api.get<{ global_exclusions: { pattern: string; comment: string }[] }>('/api/settings/global-exclusions/defaults');
                      setGlobalExclusions([...(data.global_exclusions || [])].sort((a, b) => a.pattern.localeCompare(b.pattern)));
                    } catch (err) {
                      console.error(err);
                    }
                  }}
                  className="px-2.5 py-1 text-[11px] font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors cursor-pointer"
                >
                  {t('resetExclusionsToDefaults')}
                </button>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {t('globalExclusionsDesc')}
              </p>

              <div className="flex flex-col gap-2 p-2 bg-zinc-950/60 border border-zinc-800 rounded-lg">
                {globalExclusions.map((ex) => (
                  <div key={ex.pattern} className="flex items-center justify-between gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-850 rounded-md text-xs">
                    <div className="flex items-center gap-2 truncate mr-2">
                      <span className="font-mono text-indigo-400 font-semibold truncate select-all">{ex.pattern}</span>
                      <span className="text-zinc-500 italic text-[11px] truncate">— {ex.comment}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setGlobalExclusions(globalExclusions.filter((item) => item.pattern !== ex.pattern))}
                      className="text-zinc-500 hover:text-rose-455 font-bold ml-1 transition-colors cursor-pointer text-sm shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {globalExclusions.length === 0 && (
                  <span className="text-zinc-650 text-xs italic p-1">{t('noExclusions')}</span>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-zinc-800/60 pt-3">
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    placeholder={t('exclusionPatternPlaceholder') || 'Pattern (e.g. /var/tmp/*)'}
                    value={newExclusionInput}
                    onChange={(e) => setNewExclusionInput(e.target.value)}
                    className="w-full px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-xs focus:border-indigo-500 focus:outline-none font-mono"
                  />
                  <input
                    type="text"
                    placeholder={t('exclusionCommentPlaceholder') || 'Comment (e.g. Temporary files)'}
                    value={newExclusionComment}
                    onChange={(e) => setNewExclusionComment(e.target.value)}
                    className="w-full px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-xs focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const pattern = newExclusionInput.trim();
                    const comment = newExclusionComment.trim() || 'Custom exclusion';
                    if (pattern && !globalExclusions.some(item => item.pattern === pattern)) {
                      setGlobalExclusions([...globalExclusions, { pattern, comment }].sort((a, b) => a.pattern.localeCompare(b.pattern)));
                    }
                    setNewExclusionInput('');
                    setNewExclusionComment('');
                  }}
                  className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold text-xs transition-colors cursor-pointer"
                >
                  {t('addExclusionButton')}
                </button>
              </div>
            </div>

            {/* Global Pruning (Retention Policies) */}
            <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4 shadow-xl">
              <div className="border-b border-zinc-850 pb-2">
                <InfoLabel
                  label={t('globalPruning')}
                  hint={t('globalPruningHint')}
                  className="text-sm font-bold text-zinc-50"
                />
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {t('globalPruningDesc') || 'Configure rules for automatic deletion of older snapshots in the archive.'}
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1.5">{t('retentionType')}</label>
                  <SearchableSelect
                    options={policyTypeOptions}
                    value={policyType}
                    onChange={setPolicyType}
                    placeholder={t('selectPolicyTypePlaceholder')}
                  />
                </div>

                {policyType === 'interval' && (
                  <div className="space-y-3 animate-fade-in">
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="flex items-center justify-center w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-300 text-[9px] font-bold shrink-0">1</span>
                          <InfoLabel label={t('keepDaily')} hint={t('keepDailyHint')} className="text-[10px] font-semibold text-zinc-400" />
                        </div>
                        <input
                          type="number"
                          required
                          min={0}
                          value={policyKeepDaily}
                          onChange={(e) => setPolicyKeepDaily(parseInt(e.target.value) || 0)}
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="flex items-center justify-center w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-300 text-[9px] font-bold shrink-0">2</span>
                          <InfoLabel label={t('keepWeekly')} hint={t('keepWeeklyHint')} className="text-[10px] font-semibold text-zinc-400" />
                        </div>
                        <input
                          type="number"
                          required
                          min={0}
                          value={policyKeepWeekly}
                          onChange={(e) => setPolicyKeepWeekly(parseInt(e.target.value) || 0)}
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="flex items-center justify-center w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-300 text-[9px] font-bold shrink-0">3</span>
                          <InfoLabel label={t('keepMonthly')} hint={t('keepMonthlyHint')} className="text-[10px] font-semibold text-zinc-400" />
                        </div>
                        <input
                          type="number"
                          required
                          min={0}
                          value={policyKeepMonthly}
                          onChange={(e) => setPolicyKeepMonthly(parseInt(e.target.value) || 0)}
                          className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {policyType === 'count' && (
                  <div className="animate-fade-in">
                    <label className="block text-xs font-semibold text-zinc-400 mb-1.5">{t('keepLastLabel')}</label>
                    <input
                      type="number"
                      required
                      min={1}
                      value={policyKeepLast}
                      onChange={(e) => setPolicyKeepLast(parseInt(e.target.value) || 1)}
                      className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                )}

                {policyType === 'timeframe' && (
                  <div className="grid grid-cols-3 gap-3 animate-fade-in">
                    <div className="col-span-2">
                      <label className="block text-xs font-semibold text-zinc-400 mb-1.5">{t('keepWithinLabel')}</label>
                      <input
                        type="number"
                        required
                        min={1}
                        value={policyWithinValue}
                        onChange={(e) => setPolicyWithinValue(parseInt(e.target.value) || 1)}
                        className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-zinc-400 mb-1.5">&nbsp;</label>
                      <SearchableSelect
                        options={unitOptions}
                        value={policyWithinUnit}
                        onChange={setPolicyWithinUnit}
                        placeholder={t('selectUnitPlaceholder')}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            </div>
          </div>

        </form>
      )}

      {isCredentialsModalOpen && (
        <CredentialsModal
          onClose={() => setIsCredentialsModalOpen(false)}
          credentials={bootstrapCredentials}
          defaultId={defaultCredentialsId}
          onChange={async (newCreds, newDefaultId) => {
            setBootstrapCredentials(newCreds);
            setDefaultCredentialsId(newDefaultId);
            try {
              const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildSettingsPayload({
                  bootstrap_credentials: newCreds,
                  default_credentials_id: newDefaultId,
                })),
              });
              if (res.ok) {
                const data = await res.json();
                // newCreds, set above, is already the accurate post-edit
                // value with passwords; the response's copy is password-less.
                if (data.default_credentials_id !== undefined) {
                  setDefaultCredentialsId(data.default_credentials_id || '');
                }
                if (onSettingsUpdated) {
                  onSettingsUpdated(data);
                }
              }
            } catch (e) {
              console.error(e);
            }
          }}
        />
      )}
    </div>
  );
}
