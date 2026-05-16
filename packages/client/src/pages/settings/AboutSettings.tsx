import { useCallback, useEffect, useState } from "react";
import { api, fetchJSON } from "../../api/client";
import { useOptionalRemoteConnection } from "../../contexts/RemoteConnectionContext";
import { useDeveloperMode } from "../../hooks/useDeveloperMode";
import { useOnboarding } from "../../hooks/useOnboarding";
import { usePwaInstall } from "../../hooks/usePwaInstall";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { activityBus } from "../../lib/activityBus";

export function AboutSettings() {
  const { t } = useI18n();
  const { canInstall, isInstalled, requiresManualInstall, install } =
    usePwaInstall();
  const {
    version: versionInfo,
    loading: versionLoading,
    error: versionError,
    refetchFresh: refetchVersionFresh,
  } = useVersion({ freshOnMount: true });
  const remoteConnection = useOptionalRemoteConnection();
  const { resetOnboarding } = useOnboarding();
  const { remoteLogCollectionEnabled, setRemoteLogCollectionEnabled } =
    useDeveloperMode();
  const isRelayConnection = !!remoteConnection?.currentRelayUsername;
  const hasResumeProtocolSupport =
    (versionInfo?.resumeProtocolVersion ?? 1) >= 2;
  const showRelayResumeUpdateWarning =
    isRelayConnection && !!versionInfo && !hasResumeProtocolSupport;

  // Server restart state
  const [restarting, setRestarting] = useState(false);
  const [activeWorkers, setActiveWorkers] = useState(0);

  // Fetch worker activity on mount
  useEffect(() => {
    fetchJSON<{ activeWorkers: number; hasActiveWork: boolean }>(
      "/status/workers",
    )
      .then((data) => setActiveWorkers(data.activeWorkers))
      .catch(() => {});
  }, []);

  // When activity bus reconnects after restart, clear restarting state
  useEffect(() => {
    if (!restarting) return;
    return activityBus.on("reconnect", () => {
      setRestarting(false);
    });
  }, [restarting]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await api.restartServer();
    } catch {
      // Expected - server drops connection during restart
    }
  }, []);

  return (
    <section className="settings-section">
      <h2>{t("aboutTitle")}</h2>
      <div className="settings-group">
        {/* iOS Safari does not expose a native install prompt, so show manual steps. */}
        {(canInstall || isInstalled || requiresManualInstall) && (
          <div className="settings-item">
            <div className="settings-item-info">
              <strong>{t("aboutInstallTitle")}</strong>
              <p>
                {isInstalled
                  ? t("aboutInstalledDescription")
                  : requiresManualInstall
                    ? t("aboutInstallManualDescription")
                    : t("aboutInstallDescription")}
              </p>
            </div>
            {isInstalled ? (
              <span className="settings-status-badge">
                {t("aboutInstalled")}
              </span>
            ) : requiresManualInstall ? (
              <span className="settings-status-badge">
                {t("aboutInstallManualBadge")}
              </span>
            ) : (
              <button
                type="button"
                className="settings-button"
                onClick={install}
              >
                {t("aboutInstall")}
              </button>
            )}
          </div>
        )}
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutVersionTitle")}</strong>
            <p>
              {t("aboutServerVersion")}{" "}
              {versionInfo ? (
                <>
                  v{versionInfo.current}
                  {versionInfo.updateAvailable && versionInfo.latest ? (
                    <span className="settings-update-available">
                      {" "}
                      {t("aboutVersionAvailable", {
                        version: versionInfo.latest,
                      })}
                    </span>
                  ) : versionInfo.latest ? (
                    <span className="settings-up-to-date">
                      {" "}
                      {t("aboutUpToDate")}
                    </span>
                  ) : null}
                </>
              ) : (
                t("loginLoading")
              )}
            </p>
            <p>
              {t("aboutClientVersion")} v{__APP_VERSION__}
            </p>
            {versionError && (
              <p className="settings-warning">{t("aboutUnableRefresh")}</p>
            )}
            {showRelayResumeUpdateWarning && (
              <p className="settings-warning">{t("aboutRelayResumeWarning")}</p>
            )}
            {versionInfo?.updateAvailable && (
              <p className="settings-update-hint">{t("aboutUpdateHint")}</p>
            )}
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={() => void refetchVersionFresh()}
            disabled={versionLoading}
          >
            {versionLoading ? t("aboutChecking") : t("aboutCheckUpdates")}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("developmentRestartTitle")}</strong>
            <p>{t("developmentRestartDescription")}</p>
            {activeWorkers > 0 && !restarting && (
              <p className="settings-warning">
                {t("developmentInterruptedWarning", {
                  count: activeWorkers,
                  suffix: activeWorkers !== 1 ? "s " : " ",
                })}
              </p>
            )}
          </div>
          <button
            type="button"
            className={`settings-button ${activeWorkers > 0 ? "settings-button-danger" : ""}`}
            onClick={handleRestart}
            disabled={restarting}
          >
            {restarting
              ? t("developmentRestarting")
              : activeWorkers > 0
                ? t("developmentRestartAnyway")
                : t("developmentRestart")}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutReportBugTitle")}</strong>
            <p>{t("aboutReportBugDescription")}</p>
          </div>
          <a
            href="https://github.com/kzahel/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-button"
          >
            {t("aboutReportBug")}
          </a>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutSetupWizardTitle")}</strong>
            <p>{t("aboutSetupWizardDescription")}</p>
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={resetOnboarding}
          >
            {t("aboutLaunchWizard")}
          </button>
        </div>
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>{t("aboutDiagnosticsTitle")}</strong>
            <p>{t("aboutDiagnosticsDescription")}</p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={remoteLogCollectionEnabled}
              onChange={(e) => setRemoteLogCollectionEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </section>
  );
}
