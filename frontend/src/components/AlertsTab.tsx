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
  // requires password back. Re-posting fullSettings unmodified would 422
  // whenever any bootstrap credentials are configured, so their passwords are
  // fetched separately here (GET /api/settings/credentials, the same
  // require_admin-gated endpoint the credentials modal on the General tab
  // uses) and merged back in at save time -- never rendered, never edited.
  const [credentialPasswords, setCredentialPasswords] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/settings').then((res) => res.json()),
      fetch('/api/settings/credentials').then((res) => (res.ok ? res.json() : [])).catch(() => []),
    ])
      .then(([data, creds]) => {
        setFullSettings(data);
        setAlertConfig(data.alert_config || {});
        const passwords: Record<string, string> = {};
        (creds || []).forEach((c: any) => { passwords[c.id] = c.password; });
        setCredentialPasswords(passwords);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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
    setSaving(true);
    setSuccess(false);
    try {
      // Restore the passwords GET dropped so this validates against
      // CredentialSchema -- see the comment on credentialPasswords above.
      const bootstrapCredentials = (fullSettings.bootstrap_credentials || []).map((c: any) => ({
        ...c,
        password: credentialPasswords[c.id] ?? '',
      }));
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
  }, [fullSettings, alertConfig, credentialPasswords]);

  if (loading) {
    return <div className="text-xs text-zinc-500 p-4">{t('loading') || 'Loading...'}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-bold text-zinc-100">{t('alertSourcesHeading')}</h3>
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
            disabled={saving}
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
