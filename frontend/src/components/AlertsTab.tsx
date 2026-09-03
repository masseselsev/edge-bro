import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from '../context/TranslationContext';

interface AlertsTabProps {
  currentUser?: any;
}

//: One entry per registered source (backend/core/alert_sources/SOURCES).
//: `thresholds` describes the extra numeric fields this source's config
//: carries beyond `enabled` -- smart/thermal have none.
const SOURCE_FIELDS: { key: string; labelKey: string; thresholds?: { key: string; labelKey: string }[] }[] = [
  { key: 'smart', labelKey: 'alertSourceSmart' },
  { key: 'thermal', labelKey: 'alertSourceThermal' },
  { key: 'stale_backup', labelKey: 'alertSourceStaleBackup', thresholds: [{ key: 'days', labelKey: 'alertThresholdDays' }] },
  { key: 'node_offline', labelKey: 'alertSourceNodeOffline', thresholds: [{ key: 'days', labelKey: 'alertThresholdDays' }] },
  {
    key: 'storage', labelKey: 'alertSourceStorage',
    thresholds: [
      { key: 'watch_percent', labelKey: 'alertThresholdWatchPercent' },
      { key: 'alert_percent', labelKey: 'alertThresholdAlertPercent' },
    ],
  },
];

interface AlertRow {
  id: number;
  module: string;
  node_hostname: string | null;
  severity: 'WATCH' | 'ALERT';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  title: string;
  first_seen: string;
  last_seen: string;
}

export default function AlertsTab({ currentUser }: AlertsTabProps) {
  const { t } = useTranslation();
  // The *entire* settings object -- POST /api/settings replaces every
  // field unconditionally, so saving only alert_config would silently
  // reset everything else this tab never touched. See settings.py's
  // update_settings.
  const [fullSettings, setFullSettings] = useState<any>(null);
  const [alertConfig, setAlertConfig] = useState<Record<string, any>>({});
  // GET /api/settings strips bootstrap_credentials[].password (it returns
  // CredentialSummary, loaded on every page view -- see schemas/settings.py);
  // POST /api/settings validates the body against CredentialSchema, which
  // requires password back, and always *replaces* bootstrap_credentials
  // wholesale (routers/settings.py: `settings.bootstrap_credentials = new_creds`,
  // defaulting to `[]` for anything not sent) -- there is no partial-update
  // path here, so a credential this component cannot vouch for cannot be
  // saved as `''` OR omitted; both wipe it in the DB. Passwords are fetched
  // separately (GET /api/settings/credentials, the same require_admin-gated
  // endpoint the credentials modal on the General tab uses) and merged back
  // in at save time -- never rendered, never edited by this tab. If that
  // fetch doesn't fully succeed, credentialsLoadError blocks Save entirely
  // rather than risk silently blanking real passwords.
  const [credentialPasswords, setCredentialPasswords] = useState<Record<string, string>>({});
  const [credentialsLoadError, setCredentialsLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const loadCredentialPasswords = useCallback(async (bootstrapCredentials: any[]) => {
    try {
      const res = await fetch('/api/settings/credentials');
      if (!res.ok) throw new Error(`GET /api/settings/credentials -> ${res.status}`);
      const creds = await res.json();
      const passwords: Record<string, string> = {};
      (Array.isArray(creds) ? creds : []).forEach((c: any) => { passwords[c.id] = c.password; });
      // Every credential this settings object references must have come back
      // with a password, or a save built from this map would silently blank
      // whichever ones didn't.
      const complete = (bootstrapCredentials || []).every((c: any) => typeof passwords[c.id] === 'string');
      if (!complete) throw new Error('credentials response missing an entry the settings object references');
      setCredentialPasswords(passwords);
      setCredentialsLoadError(false);
    } catch (e) {
      console.error('Failed to load bootstrap credential passwords for the Alerts tab:', e);
      setCredentialPasswords({});
      setCredentialsLoadError(true);
    }
  }, []);

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then(async (data) => {
        setFullSettings(data);
        setAlertConfig(data.alert_config || {});
        await loadCredentialPasswords(data.bootstrap_credentials || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [loadCredentialPasswords]);

  const sourceValue = (source: string, field: string, fallback: any) =>
    alertConfig[source]?.[field] ?? fallback;

  const setSourceField = (source: string, field: string, value: any) => {
    setAlertConfig((prev) => ({
      ...prev,
      [source]: { ...prev[source], [field]: value },
    }));
  };

  const handleSave = useCallback(async () => {
    if (!fullSettings) return;
    // Hard block: never POST a credential this component isn't sure of the
    // real password for. Belt-and-braces alongside the disabled Save button
    // below (which covers the same condition) -- see the comment on
    // credentialPasswords above for why a fallback to '' or omitting the
    // field from the payload are both unsafe here (the endpoint always
    // replaces bootstrap_credentials wholesale, defaulting missing entries
    // to deleted rather than "unchanged").
    const existingCredentials: any[] = fullSettings.bootstrap_credentials || [];
    const allPasswordsVerified = existingCredentials.every((c) => typeof credentialPasswords[c.id] === 'string');
    if (credentialsLoadError || !allPasswordsVerified) {
      setCredentialsLoadError(true);
      return;
    }
    const bootstrapCredentials = existingCredentials.map((c) => ({ ...c, password: credentialPasswords[c.id] }));
    setSaving(true);
    setSuccess(false);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fullSettings, bootstrap_credentials: bootstrapCredentials, alert_config: alertConfig }),
      });
      if (res.ok) {
        const data = await res.json();
        setFullSettings(data);
        setAlertConfig(data.alert_config || {});
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        console.error('Failed to save alert settings:', res.status, await res.text().catch(() => ''));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }, [fullSettings, alertConfig, credentialPasswords, credentialsLoadError]);

  const handleRetryCredentials = useCallback(() => {
    loadCredentialPasswords(fullSettings?.bootstrap_credentials || []);
  }, [fullSettings, loadCredentialPasswords]);

  // Alert history section -- consumes GET /api/alerts (all statuses) and
  // POST /api/alerts/{id}/acknowledge. NotificationBell.tsx covers the
  // OPEN-only quick view off the same endpoint; this is the full history
  // with status filtering, not a duplicate of the bell's own state.
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [ackingId, setAckingId] = useState<number | null>(null);

  const fetchAlerts = useCallback(() => {
    const qs = statusFilter ? `?status=${statusFilter}` : '';
    fetch(`/api/alerts${qs}`)
      .then((res) => (res.ok ? res.json() : []))
      .then(setAlerts)
      .catch(() => setAlerts([]));
  }, [statusFilter]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const handleAcknowledge = async (id: number) => {
    setAckingId(id);
    try {
      const res = await fetch(`/api/alerts/${id}/acknowledge`, { method: 'POST' });
      if (res.ok) fetchAlerts();
    } finally {
      setAckingId(null);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500 p-4">{t('loading') || 'Loading...'}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-zinc-100">{t('alertHistoryHeading')}</h3>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-300"
          >
            <option value="">{t('alertFilterAll')}</option>
            <option value="OPEN">{t('alertFilterOpen')}</option>
            <option value="ACKNOWLEDGED">{t('alertFilterAcknowledged')}</option>
            <option value="RESOLVED">{t('alertFilterResolved')}</option>
          </select>
        </div>
        {alerts.length === 0 ? (
          <p className="text-xs text-zinc-500 py-4 text-center">{t('alertHistoryEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-zinc-500 border-b border-zinc-800">
                  <th className="py-1.5 pr-3">{t('alertColSeverity')}</th>
                  <th className="py-1.5 pr-3">{t('alertColModule')}</th>
                  <th className="py-1.5 pr-3">{t('alertColNode')}</th>
                  <th className="py-1.5 pr-3">{t('alertColTitle')}</th>
                  <th className="py-1.5 pr-3">{t('alertColFirstSeen')}</th>
                  <th className="py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-b border-zinc-800/40 last:border-0">
                    <td className="py-1.5 pr-3">
                      <span className={a.severity === 'ALERT' ? 'text-rose-400 font-bold' : 'text-amber-400 font-bold'}>
                        {a.severity}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-zinc-400">{a.module}</td>
                    <td className="py-1.5 pr-3 text-zinc-400 font-mono">{a.node_hostname || '—'}</td>
                    <td className="py-1.5 pr-3 text-zinc-200">{a.title}</td>
                    <td className="py-1.5 pr-3 text-zinc-500">{new Date(a.first_seen).toLocaleString()}</td>
                    <td className="py-1.5">
                      {a.status === 'OPEN' && (
                        <button
                          type="button"
                          onClick={() => handleAcknowledge(a.id)}
                          disabled={ackingId === a.id}
                          className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-emerald-500/20 hover:text-emerald-400 text-zinc-400 text-[10px] font-semibold disabled:opacity-50"
                        >
                          {t('alertAcknowledge')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-bold text-zinc-100">{t('alertSourcesHeading')}</h3>
        {credentialsLoadError && (
          <div className="flex items-center justify-between gap-3 p-2.5 bg-red-950/40 border border-red-900/60 rounded-lg text-xs text-red-300">
            <span>{t('alertsCredentialsLoadError')}</span>
            <button
              type="button"
              onClick={handleRetryCredentials}
              className="px-2.5 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded-md font-semibold shrink-0"
            >
              {t('retryButton')}
            </button>
          </div>
        )}
        <div className="space-y-2">
          {SOURCE_FIELDS.map(({ key, labelKey, thresholds }) => {
            const enabled = sourceValue(key, 'enabled', true);
            return (
              <div key={key} className="flex items-center gap-4 py-2 border-b border-zinc-800/60 last:border-0">
                <label className="flex items-center gap-2 flex-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setSourceField(key, 'enabled', e.target.checked)}
                    className="rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                  />
                  <span className="text-xs font-semibold text-zinc-200">{t(labelKey)}</span>
                </label>
                {enabled && thresholds?.map(({ key: fKey, labelKey: fLabel }) => (
                  <div key={fKey} className="flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-500">{t(fLabel)}</span>
                    <input
                      type="number"
                      value={sourceValue(key, fKey, '')}
                      onChange={(e) => setSourceField(key, fKey, Number(e.target.value))}
                      className="w-16 px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-100"
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || credentialsLoadError}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50"
          >
            {saving ? t('saving') : t('saveSettings')}
          </button>
          {success && <span className="text-xs text-emerald-400 font-semibold">{t('settingsSavedSuccess') || 'Saved'}</span>}
        </div>
      </div>
    </div>
  );
}
