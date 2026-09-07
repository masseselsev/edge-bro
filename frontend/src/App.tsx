import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import TaskLogsModal from './components/TaskLogsModal';
import NetworkSettingsModal from './components/NetworkSettingsModal';
import { TranslationProvider, useTranslation } from './context/TranslationContext';
import Login from './components/Login';
import ProfileModal from './components/ProfileModal';
import IpPromptModal from './components/IpPromptModal';
import WatchdogModal from './components/WatchdogModal';
import MainFooter from './components/MainFooter';
import KioskFooter from './components/KioskFooter';
import AppHeader, { type Bandwidth } from './components/AppHeader';
import BootOverlay from './components/BootOverlay';
import KioskPairingModal from './components/KioskPairingModal';
import KioskReviewModal from './components/KioskReviewModal';
import PendingKioskBanner from './components/PendingKioskBanner';
import { usePolledResource } from './hooks/usePolledResource';
import { useKioskPairing, type KioskVersionPayload } from './hooks/useKioskPairing';
import { usePendingKiosks } from './hooks/usePendingKiosks';
import { restoreActiveTab, type Tab } from './tabs';
import { Loader2 } from 'lucide-react';
import { api, installApiErrorHandling } from './api';

// One chunk per tab. The whole app was 886KB in a single file, so a kiosk on a
// slow link downloaded the fleet manager, the scheduler and the settings
// screen before it could show the one tab it is allowed to open. Only the tab
// being viewed is fetched now, and switching tabs fetches the next.
//
// Static imports for these would defeat the split: one eager import anywhere
// pulls the module back into the main chunk.
import FleetTab from './components/FleetTab';
import FlasherTab from './components/FlasherTab';
import HistoryTab from './components/HistoryTab';
import LogsTab from './components/LogsTab';
import SettingsTab from './components/SettingsTab';
import ClientIsoTab from './components/ClientIsoTab';
import ScheduleTab from './components/ScheduleTab';

const IP_PROMPT_DISMISSED_KEY = 'edge_bro_ip_prompt_dismissed';

function AppContent() {
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<Tab>(() => restoreActiveTab(localStorage.getItem('activeTab')));
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('theme');
    return (saved === 'light' || saved === 'dark') ? saved : 'dark';
  });

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // What kind of installation this is, and whether we may talk to it.
  const [isKiosk, setIsKiosk] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Boot gating. The overlay lifts once all three have answered, successfully
  // or not — a failed fetch must not leave the operator staring at a spinner.
  const [appReady, setAppReady] = useState(false);
  const [versionLoaded, setVersionLoaded] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [networkLoaded, setNetworkLoaded] = useState(false);

  const [settings, setSettings] = useState<any>(null);
  const [orchestratorIp, setOrchestratorIp] = useState('');
  const [availableIps, setAvailableIps] = useState<string[]>([]);
  const [showIpPromptModal, setShowIpPromptModal] = useState(false);
  const [savingIp, setSavingIp] = useState(false);

  const [logTaskId, setLogTaskId] = useState<string | null>(null);
  const [logTaskTitle, setLogTaskTitle] = useState('');

  const [showNetworkModal, setShowNetworkModal] = useState(false);
  const [userDismissedNetworkModal, setUserDismissedNetworkModal] = useState(false);
  const [restoreMode, setRestoreMode] = useState<'offline' | 'online'>('offline');

  const [showWatchdogModal, setShowWatchdogModal] = useState(false);
  const [hasShownWatchdogModal, setHasShownWatchdogModal] = useState(false);
  const [watchdogActionLoading, setWatchdogActionLoading] = useState(false);

  const pairing = useKioskPairing(isKiosk);
  const pendingKiosks = usePendingKiosks(!!isAuthenticated && !isKiosk);

  // A 401 from any API call means the session is gone, whichever panel
  // happened to notice first. Without this an expired session showed empty
  // panels rather than the login screen — see src/api.ts.
  useEffect(() => {
    installApiErrorHandling(() => {
      setIsAuthenticated(false);
      setCurrentUser(null);
    });
  }, []);

  // --- Polling ---------------------------------------------------------

  const { data: bandwidth } = usePolledResource<Bandwidth>('/api/network/bandwidth', 3000, {
    enabled: isKiosk || !!isAuthenticated,
    onError: (err) => console.error('Failed to fetch bandwidth:', err),
  });

  const { data: healthWarnings } = usePolledResource<{ code: string; message: string }[]>('/api/health', 10000, {
    transform: (data) => data?.warnings || [],
    onError: (err) => console.error('Failed to fetch health warnings:', err),
  });

  const {
    data: networkStatus,
    refresh: refreshNetworkStatus,
  } = usePolledResource<any>('/api/network/status', 7000, {
    enabled: isKiosk,
    // The boot sequence already fetched this; re-requesting on mount would add
    // a round trip to the slowest moment of kiosk startup.
    immediate: false,
    onError: (err) => console.error('Failed to fetch network status:', err),
  });

  const { data: watchdogStatus, refresh: refreshWatchdog } = usePolledResource<any>('/api/kiosk/watchdog/status', 4000, {
    enabled: isKiosk,
    onData: (data) => {
      // Raised once per session. A watchdog that is armed and not yet frozen
      // will reboot the machine mid-restore, so it is worth interrupting for —
      // but only the first time, or it becomes impossible to dismiss.
      if (data?.detected && !data.frozen && !hasShownWatchdogModal) {
        setShowWatchdogModal(true);
        setHasShownWatchdogModal(true);
      }
    },
    onError: (err) => console.error('Failed to fetch watchdog status:', err),
  });

  // Polled for its reachability rather than its contents: on a kiosk this is
  // the difference between "no network" and "network fine, server down".
  const { reachable: orchestratorReachable } = usePolledResource('/api/nodes', 15000, {
    enabled: isKiosk && appReady,
  });

  // --- Boot ------------------------------------------------------------

  // The kiosk boot sequence pre-fetches network status, and the 7s poll above
  // owns the value from then on. This holds the boot reading until the first
  // poll lands, so the header is not blank for seven seconds at startup.
  const [bootNetworkStatus, setBootNetworkStatus] = useState<any>(null);
  const effectiveNetworkStatus = networkStatus ?? bootNetworkStatus;

  const loadSettingsAndNodes = useCallback(() => {
    api.get<any>('/api/settings')
      .then(sett => {
        setSettings(sett);
        setOrchestratorIp(sett.orchestrator_ip || '');
        setAvailableIps(sett.available_ips || []);

        return api.get<any>('/api/nodes')
          .then(nodes => {
            const nodesList = Array.isArray(nodes) ? nodes : (nodes.nodes || []);
            // An empty fleet on a fresh install almost always means the
            // orchestrator's own address was never set, so offer that first.
            if (nodesList.length === 0 && !localStorage.getItem(IP_PROMPT_DISMISSED_KEY)) {
              setShowIpPromptModal(true);
            }
          })
          .catch(err => console.error(err))
          .finally(() => setSettingsLoaded(true));
      })
      .catch(err => {
        console.error(err);
        setSettingsLoaded(true);
      });
  }, []);

  useEffect(() => {
    let retryCount = 0;

    const fetchVersion = () => {
      api.get<KioskVersionPayload & { version?: string; is_kiosk?: boolean }>('/api/version')
        .then(data => {
          if (data?.version) setAppVersion(data.version);

          if (data?.is_kiosk) {
            // A kiosk authenticates by the token baked into its image; there is
            // no login screen and no user.
            setIsKiosk(true);
            setIsAuthenticated(true);
            setActiveTab('flasher');
            pairing.hydrate(data);

            api.get<any>('/api/network/status')
              .then(setBootNetworkStatus)
              .catch(err => console.error('Failed to pre-fetch network status:', err))
              .finally(() => {
                setNetworkLoaded(true);
                setVersionLoaded(true);
              });
            loadSettingsAndNodes();
            return;
          }

          api.get<any>('/api/auth/me')
            .then(user => {
              setCurrentUser(user);
              setIsAuthenticated(true);
              setNetworkLoaded(true);
              setVersionLoaded(true);
              loadSettingsAndNodes();
            })
            .catch(() => {
              setIsAuthenticated(false);
              setNetworkLoaded(true);
              setVersionLoaded(true);
              setSettingsLoaded(true); // Don't block with loading screen if not authenticated
            });
        })
        .catch(err => {
          // /api/version is the first request the app makes, and on a kiosk it
          // races the backend's own startup. Retry rather than render a broken
          // shell; give up after 15s and let the UI come up degraded.
          console.error('Error fetching version:', err);
          if (retryCount < 5) {
            retryCount++;
            setTimeout(fetchVersion, 3000);
          } else {
            setNetworkLoaded(true);
            setVersionLoaded(true);
            setSettingsLoaded(true);
          }
        });
    };
    fetchVersion();
    // Runs once. pairing.hydrate and loadSettingsAndNodes are stable callbacks;
    // re-running the boot sequence on any later change would restart the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (versionLoaded && settingsLoaded && networkLoaded) {
      // Small delay to let the UI render before removing the overlay
      const timer = setTimeout(() => setAppReady(true), 300);
      return () => clearTimeout(timer);
    }
  }, [versionLoaded, settingsLoaded, networkLoaded]);

  // Auto-show network modal when kiosk has no connection (after boot, once per session)
  useEffect(() => {
    if (!isKiosk || !appReady || effectiveNetworkStatus === null) return;

    const isConnected = !!(effectiveNetworkStatus?.wired?.connected || effectiveNetworkStatus?.wifi?.connected);

    if (!isConnected && !userDismissedNetworkModal) {
      setShowNetworkModal(true);
    }
  }, [effectiveNetworkStatus, appReady, isKiosk, userDismissedNetworkModal]);

  // --- Actions ---------------------------------------------------------

  const handleLoginSuccess = (user: any) => {
    setCurrentUser(user);
    setIsAuthenticated(true);
    setSettingsLoaded(false);
    loadSettingsAndNodes();
  };

  const handleLogout = async () => {
    try {
      await api.post('/api/auth/logout');
    } catch (err) {
      console.error(err);
    } finally {
      // Reloaded rather than reset in place: clearing every panel's cached
      // fleet data by hand is exactly the kind of thing that gets missed.
      window.location.reload();
    }
  };

  const handleExitKiosk = async () => {
    if (window.confirm(t('exitKioskConfirm'))) {
      try {
        await api.post('/api/kiosk/exit');
      } catch (err) {
        console.error("Failed to trigger kiosk exit:", err);
      }
    }
  };

  const handleToggleMode = async () => {
    const nextMode = restoreMode === 'offline' ? 'online' : 'offline';
    try {
      await api.post('/api/kiosk/mode', { mode: nextMode });
      setRestoreMode(nextMode);
      // The mode decides which backend services the kiosk runs, so the whole
      // app is reloaded against the new configuration.
      window.location.reload();
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (!isKiosk) return;
    api.get<{ mode?: 'offline' | 'online' }>('/api/kiosk/mode')
      .then(data => {
        if (data?.mode) setRestoreMode(data.mode);
      })
      .catch(err => console.error('Failed to read kiosk mode:', err));
  }, [isKiosk]);

  const setWatchdog = async (action: 'freeze' | 'unfreeze') => {
    setWatchdogActionLoading(true);
    try {
      await api.post(`/api/kiosk/watchdog/${action}`);
      // Read back immediately: the next scheduled poll is up to 4s away and the
      // button the operator just pressed has to visibly do something.
      await refreshWatchdog();
      if (action === 'freeze') setShowWatchdogModal(false);
    } catch (err: any) {
      alert(err.message || "Error communication with watchdog controller");
    } finally {
      setWatchdogActionLoading(false);
    }
  };

  const handleSaveIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSavingIp(true);
    try {
      const updated = await api.post<any>('/api/settings', { ...settings, orchestrator_ip: orchestratorIp });
      setSettings(updated);
      localStorage.setItem(IP_PROMPT_DISMISSED_KEY, '1');
      setShowIpPromptModal(false);
    } catch (err: any) {
      console.error('Failed to save orchestrator IP:', err);
      alert(err.message || 'Failed to save orchestrator IP');
    } finally {
      setSavingIp(false);
    }
  };

  const handleViewLogs = (taskId: string, title: string) => {
    setLogTaskId(taskId);
    setLogTaskTitle(title);
  };

  // --- Render ----------------------------------------------------------

  const timezone = settings?.timezone || 'Browser Local';

  // A switch rather than a lookup table, because each tab takes a different
  // set of props — a map would need a union type per entry and would obscure
  // rather than remove the branching. The *navigation* is data-driven; see
  // src/tabs.ts.
  const renderTabContent = () => {
    switch (activeTab) {
      case 'flasher':
        return <FlasherTab onViewLogs={handleViewLogs} timezone={timezone} restoreMode={restoreMode} isKiosk={isKiosk} kioskStatus={pairing.status} />;
      case 'clientiso':
        return <ClientIsoTab onViewLogs={handleViewLogs} />;
      case 'history':
        return <HistoryTab onViewLogs={handleViewLogs} timezone={timezone} isKiosk={isKiosk} />;
      case 'logs':
        return <LogsTab onViewLogs={handleViewLogs} timezone={timezone} isKiosk={isKiosk} />;
      case 'settings':
        return <SettingsTab onSettingsUpdated={setSettings} currentUser={currentUser} />;
      case 'schedule':
        return <ScheduleTab />;
      case 'fleet':
      default:
        return <FleetTab onViewLogs={handleViewLogs} timezone={timezone} currentUser={currentUser} />;
    }
  };

  if (isAuthenticated === false && !isKiosk) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className={`min-h-full flex flex-col font-sans ${isKiosk ? 'select-none' : ''}`}>
      {!appReady && <BootOverlay />}

      <AppHeader
        appVersion={appVersion}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        theme={theme}
        onToggleTheme={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
        isKiosk={isKiosk}
        isAuthenticated={isAuthenticated}
        currentUser={currentUser}
        onLogout={handleLogout}
        onOpenProfile={() => setShowProfileModal(true)}
        timezone={timezone}
        bandwidth={bandwidth}
        restoreMode={restoreMode}
        onToggleRestoreMode={handleToggleMode}
        onOpenPairing={pairing.openModal}
        onOpenNetwork={() => setShowNetworkModal(true)}
        onExitKiosk={handleExitKiosk}
        networkStatus={effectiveNetworkStatus}
        orchestratorReachable={orchestratorReachable}
      />

      {!isKiosk && pendingKiosks.pending.length > 0 && (
        <PendingKioskBanner
          pending={pendingKiosks.pending}
          onReview={(kiosk) => {
            setActiveTab('clientiso');
            pendingKiosks.setActiveReview(kiosk);
          }}
        />
      )}

      <main className={`flex-1 max-w-7xl w-full mx-auto px-6 py-6 ${isKiosk ? (restoreMode === 'online' && pairing.status !== 'APPROVED' ? 'pb-28' : 'pb-20') : 'pb-20'}`}>
        {renderTabContent()}
      </main>

      {!isKiosk && (
        <MainFooter
          appVersion={appVersion}
          healthWarnings={healthWarnings || []}
          setActiveTab={setActiveTab}
        />
      )}

      {isKiosk && (
        <KioskFooter
          restoreMode={restoreMode}
          kioskStatus={pairing.status}
          activationMsg={pairing.activationMsg}
          activationError={pairing.activationError}
          handleRequestActivation={pairing.requestActivation}
          requestingActivation={pairing.requestingActivation}
          onOpenPairing={pairing.openModal}
          kioskOrchestratorIp={pairing.orchestratorIp}
          kioskId={pairing.kioskId}
          connectionKeyphrase={pairing.connectionKeyphrase}
          watchdogStatus={watchdogStatus}
          watchdogActionLoading={watchdogActionLoading}
          handleUnfreezeWatchdog={() => setWatchdog('unfreeze')}
          handleFreezeWatchdog={() => setWatchdog('freeze')}
          healthWarnings={healthWarnings || []}
        />
      )}

      {showWatchdogModal && (
        <WatchdogModal
          onClose={() => setShowWatchdogModal(false)}
          onFreeze={() => setWatchdog('freeze')}
          watchdogStatus={watchdogStatus}
          watchdogActionLoading={watchdogActionLoading}
        />
      )}

      {showNetworkModal && (
        <NetworkSettingsModal
          onClose={() => {
            setShowNetworkModal(false);
            setUserDismissedNetworkModal(true);
            void refreshNetworkStatus();
          }}
          initialStatus={effectiveNetworkStatus}
          showNoNetworkWarning={isKiosk && !(effectiveNetworkStatus?.wired?.connected || effectiveNetworkStatus?.wifi?.connected)}
        />
      )}

      {showProfileModal && currentUser && (
        <ProfileModal
          currentUser={currentUser}
          onClose={() => setShowProfileModal(false)}
          onUpdateSuccess={(updated) => setCurrentUser(updated)}
        />
      )}

      {pendingKiosks.activeReview && (
        <KioskReviewModal
          kiosk={pendingKiosks.activeReview}
          onApprove={pendingKiosks.approve}
          onReject={pendingKiosks.reject}
          onClose={() => pendingKiosks.setActiveReview(null)}
        />
      )}

      {pairing.showModal && <KioskPairingModal pairing={pairing} />}

      {/* Active task console log stream overlay modal */}
      {logTaskId && (
        <TaskLogsModal
          taskId={logTaskId}
          title={logTaskTitle}
          timezone={timezone}
          onClose={() => setLogTaskId(null)}
          bandwidth={bandwidth}
        />
      )}

      {showIpPromptModal && (
        <IpPromptModal
          onClose={() => {
            localStorage.setItem(IP_PROMPT_DISMISSED_KEY, '1');
            setShowIpPromptModal(false);
          }}
          onSubmit={handleSaveIp}
          orchestratorIp={orchestratorIp}
          setOrchestratorIp={setOrchestratorIp}
          availableIps={availableIps}
          savingIp={savingIp}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <TranslationProvider>
      <AppContent />
    </TranslationProvider>
  );
}
