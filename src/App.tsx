import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Barcode,
  Check,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Database,
  Download,
  FileArchive,
  FileDown,
  FileSpreadsheet,
  FolderOpen,
  History,
  Keyboard,
  ListChecks,
  MapPin,
  PackageCheck,
  Pause,
  Play,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createCampaignWithItems,
  db,
  getCampaignSnapshot,
  recordScan,
  undoLastScan,
} from "./db";
import {
  campaignToCsv,
  createBackup,
  downloadTextFile,
  parseBackup,
  restoreBackup,
  scansToCsv,
} from "./lib/exports";
import { parseDelimitedRecall, parseRecallFile } from "./lib/importers";
import type {
  Campaign,
  CampaignSnapshot,
  CampaignStatus,
  ImportResult,
  RecordedScanResult,
  ScanOutcome,
} from "./types";

type Screen =
  | { name: "library" }
  | { name: "scanner"; campaignId: string }
  | { name: "report"; campaignId: string };

type Toast = { id: string; message: string; error?: boolean };

const DEFAULT_LOCATION = "Philadelphia, PA";
const LAST_SCREEN_KEY = "recall-router:last-screen";
const LOCK_TTL_MS = 12_000;
const TAB_ID = crypto.randomUUID();

const statusOrder: CampaignStatus[] = [
  "active",
  "paused",
  "completed",
  "archived",
  "draft",
];

function loadLastScreen(): Screen {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_SCREEN_KEY) || "null") as Partial<Screen> | null;
    if (
      value &&
      (value.name === "scanner" || value.name === "report") &&
      "campaignId" in value &&
      typeof value.campaignId === "string"
    ) {
      return { name: value.name, campaignId: value.campaignId };
    }
  } catch {
    // A damaged navigation hint must never block access to the library.
  }
  return { name: "library" };
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function safeFilename(value: string) {
  return value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "recall";
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pushToast = useCallback((message: string, error = false) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, error }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4_500);
  }, []);
  return { toasts, pushToast };
}

function useCampaignLock(campaignId: string | undefined) {
  const [lockedByAnotherTab, setLockedByAnotherTab] = useState(false);

  useEffect(() => {
    if (!campaignId) return undefined;
    const key = `recall-router:lock:${campaignId}`;

    const readLock = () => {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || "null") as
          | { owner: string; at: number }
          | null;
        return parsed;
      } catch {
        return null;
      }
    };

    const claim = () => {
      const existing = readLock();
      const isActiveOther =
        existing && existing.owner !== TAB_ID && Date.now() - existing.at < LOCK_TTL_MS;
      setLockedByAnotherTab(Boolean(isActiveOther));
      if (!isActiveOther) {
        localStorage.setItem(key, JSON.stringify({ owner: TAB_ID, at: Date.now() }));
      }
    };

    const release = () => {
      const existing = readLock();
      if (existing?.owner === TAB_ID) localStorage.removeItem(key);
    };

    claim();
    const interval = window.setInterval(claim, 3_000);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) claim();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", release);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [campaignId]);

  return lockedByAnotherTab;
}

function Topbar({
  onHome,
  location = DEFAULT_LOCATION,
  saved = true,
  soundOn,
  onToggleSound,
}: {
  onHome: () => void;
  location?: string;
  saved?: boolean;
  soundOn?: boolean;
  onToggleSound?: () => void;
}) {
  return (
    <header className="topbar no-print">
      <button className="brand-button" onClick={onHome} aria-label="Open recall library">
        <span className="brand-mark" aria-hidden="true">RR</span>
        <span className="brand-label">Recall Router</span>
      </button>
      <div className="top-context">
        <div className="location-block">
          <MapPin size={20} aria-hidden="true" />
          <div className="context-copy">
            <strong>{location}</strong>
            <span>Optical retail workspace</span>
          </div>
        </div>
        <div className="save-block">
          <span className={`save-dot ${saved ? "" : "warning"}`} aria-hidden="true" />
          <div className="context-copy">
            <strong>{saved ? "Saved locally" : "Save needs attention"}</strong>
            <span>{saved ? "Every accepted scan is stored" : "Do not close this page"}</span>
          </div>
        </div>
      </div>
      <div className="top-actions">
        {onToggleSound ? (
          <button
            className="icon-button"
            onClick={onToggleSound}
            aria-label={soundOn ? "Mute scan sounds" : "Turn on scan sounds"}
            title={soundOn ? "Mute scan sounds" : "Turn on scan sounds"}
          >
            {soundOn ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
        ) : null}
        <button
          className="ghost-button"
          onClick={() => window.alert("Quick start: choose one recall, keep the barcode field ready, scan continuously, set every green KEEP frame aside, leave red frames in place, and rescan every amber result. Download a full backup before moving to another computer.")}
        >
          <CircleHelp size={19} /> <span>Help</span>
        </button>
        <button className="icon-button" aria-label="Settings" title="Settings coming after the first release">
          <Settings size={20} />
        </button>
      </div>
    </header>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div className={`toast ${toast.error ? "error" : ""}`} key={toast.id}>
          {toast.error ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

function CampaignTable({
  snapshots,
  status,
  onOpen,
  onReport,
  onArchive,
}: {
  snapshots: CampaignSnapshot[];
  status: CampaignStatus;
  onOpen: (id: string) => void;
  onReport: (id: string) => void;
  onArchive: (campaign: Campaign) => void;
}) {
  if (!snapshots.length) return null;
  const label = status === "draft" ? "Draft" : `${status[0].toUpperCase()}${status.slice(1)}`;
  return (
    <section className="campaign-section" aria-labelledby={`section-${status}`}>
      <h2 className={`section-label ${status}`} id={`section-${status}`}>
        {label} <span className="subtle">({snapshots.length})</span>
      </h2>
      <div className="campaign-table-wrap">
        <table className="campaign-table">
          <thead>
            <tr>
              <th>Brand</th>
              <th>Recall / reference</th>
              <th>Location</th>
              <th>Source</th>
              <th>Found / left</th>
              <th>Last activity</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {snapshots.map(({ campaign, summary }) => (
              <tr key={campaign.id}>
                <td>{campaign.brand}</td>
                <td className="campaign-title">
                  <strong>{campaign.name}</strong>
                  <span>{campaign.recallReference || "No reference number"}</span>
                </td>
                <td>{campaign.locationName}</td>
                <td>{campaign.sourceFileName || "Included list"}</td>
                <td className="count-pair">
                  <strong>{summary.foundItems}</strong> / {summary.remainingItems}
                </td>
                <td>{formatDate(campaign.updatedAt)}</td>
                <td>
                  <div className="row-actions">
                    {status === "archived" || status === "completed" ? (
                      <button className="small-button" onClick={() => onReport(campaign.id)}>
                        View report
                      </button>
                    ) : (
                      <button className="small-button" onClick={() => onOpen(campaign.id)}>
                        {status === "draft" ? "Open" : "Resume"}
                      </button>
                    )}
                    {status !== "archived" ? (
                      <button
                        className="icon-button"
                        onClick={() => onArchive(campaign)}
                        aria-label={`Archive ${campaign.name}`}
                        title="Archive"
                      >
                        <Archive size={18} />
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LibraryView({
  snapshots,
  onStartNew,
  onOpen,
  onReport,
  onArchive,
  onBackup,
  onRestore,
}: {
  snapshots: CampaignSnapshot[];
  onStartNew: () => void;
  onOpen: (id: string) => void;
  onReport: (id: string) => void;
  onArchive: (campaign: Campaign) => void;
  onBackup: () => void;
  onRestore: (file: File) => void;
}) {
  const restoreInput = useRef<HTMLInputElement>(null);
  const grouped = useMemo(
    () =>
      statusOrder.map((status) => ({
        status,
        rows: snapshots
          .filter((snapshot) => snapshot.campaign.status === status)
          .sort((a, b) => b.campaign.updatedAt.localeCompare(a.campaign.updatedAt)),
      })),
    [snapshots],
  );

  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Local recall operations</p>
          <h1>Recall Library</h1>
        </div>
        <div className="library-toolbar">
          <button className="secondary-button" onClick={onBackup}>
            <FileArchive size={19} /> Backup
          </button>
          <button className="primary-button" onClick={onStartNew}>
            <Plus size={20} /> Start new recall
          </button>
        </div>
      </div>

      {snapshots.length ? (
        <div className="campaign-groups">
          {grouped.map(({ status, rows }) => (
            <CampaignTable
              key={status}
              snapshots={rows}
              status={status}
              onOpen={onOpen}
              onReport={onReport}
              onArchive={onArchive}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <FolderOpen size={38} />
          <h2>No recall lists yet</h2>
          <p>Upload a CSV, TSV, XLSX, or XLS file to start scanning.</p>
          <button className="primary-button" onClick={onStartNew}>
            <Plus size={20} /> Start first recall
          </button>
        </div>
      )}

      <footer className="library-footer">
        <span>Private by default · saved only on this device · no patient data</span>
        <div className="footer-actions">
          <input
            ref={restoreInput}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onRestore(file);
              event.target.value = "";
            }}
          />
          <button className="ghost-button" onClick={() => restoreInput.current?.click()}>
            <RotateCcw size={18} /> Restore backup
          </button>
          <a className="ghost-button" href={`${import.meta.env.BASE_URL}recall-list-template.csv`} download>
            <Download size={18} /> Download list template
          </a>
        </div>
      </footer>
    </main>
  );
}

type NewRecallForm = {
  brand: string;
  name: string;
  recallReference: string;
  locationName: string;
};

function NewRecallDrawer({
  onClose,
  onCreated,
  pushToast,
}: {
  onClose: () => void;
  onCreated: (campaignId: string) => void;
  pushToast: (message: string, error?: boolean) => void;
}) {
  const [form, setForm] = useState<NewRecallForm>({
    brand: "",
    name: "",
    recallReference: "",
    locationName: DEFAULT_LOCATION,
  });
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [pasteValue, setPasteValue] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const parseFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      pushToast("That file is larger than the 25 MB safety limit.", true);
      return;
    }
    setParsing(true);
    try {
      const parsed = await parseRecallFile(file);
      setResult(parsed);
      if (!form.brand && parsed.rows[0]?.brand) {
        setForm((current) => ({ ...current, brand: parsed.rows[0].brand || "" }));
      }
      pushToast(`${parsed.rows.length} recall rows are ready to review.`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "That file could not be read.", true);
    } finally {
      setParsing(false);
    }
  };

  const parsePaste = () => {
    try {
      const parsed = parseDelimitedRecall(pasteValue, {}, "pasted-recall-list.csv");
      setResult(parsed);
      if (!form.brand && parsed.rows[0]?.brand) {
        setForm((current) => ({ ...current, brand: parsed.rows[0].brand || "" }));
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Those pasted rows could not be read.", true);
    }
  };

  const createRecall = async () => {
    if (!form.brand.trim() || !form.name.trim() || !form.locationName.trim()) {
      pushToast("Brand, recall name, and location are required.", true);
      return;
    }
    if (!result?.rows.length) {
      pushToast("Add a recall list with at least one valid barcode.", true);
      return;
    }
    setCreating(true);
    try {
      const created = await createCampaignWithItems(
        {
          ...form,
          brand: form.brand.trim(),
          name: form.name.trim(),
          recallReference: form.recallReference.trim() || undefined,
          locationName: form.locationName.trim(),
          status: "active",
          sourceFileName: result.sourceName,
          sourceFileType: result.sourceType,
          startedAt: new Date().toISOString(),
        },
        result.rows,
      );
      pushToast(`${created.name} is ready to scan.`);
      onCreated(created.id);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "The recall could not be created.", true);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <aside className="drawer" aria-label="New recall setup">
        <div className="drawer-header">
          <div>
            <p className="eyebrow">Reusable list intake</p>
            <h2>New Recall</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close new recall setup">
            <X size={22} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="field-grid">
            <div className="field">
              <label htmlFor="new-brand">Brand *</label>
              <input
                id="new-brand"
                value={form.brand}
                onChange={(event) => setForm({ ...form, brand: event.target.value })}
                placeholder="Example Optical, Ray-Ban, Oakley…"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="new-reference">Reference number</label>
              <input
                id="new-reference"
                value={form.recallReference}
                onChange={(event) => setForm({ ...form, recallReference: event.target.value })}
                placeholder="RA#, notice, or ticket"
              />
            </div>
            <div className="field full">
              <label htmlFor="new-name">Recall name *</label>
              <input
                id="new-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Example: July 2026 frame recall"
              />
            </div>
            <div className="field full">
              <label htmlFor="new-location">Retail location *</label>
              <input
                id="new-location"
                value={form.locationName}
                onChange={(event) => setForm({ ...form, locationName: event.target.value })}
              />
            </div>
          </div>

          <div className="input-tabs" role="tablist" aria-label="Recall list input method">
            <button
              className={`input-tab ${mode === "file" ? "active" : ""}`}
              onClick={() => setMode("file")}
              role="tab"
              aria-selected={mode === "file"}
            >
              Upload list
            </button>
            <button
              className={`input-tab ${mode === "paste" ? "active" : ""}`}
              onClick={() => setMode("paste")}
              role="tab"
              aria-selected={mode === "paste"}
            >
              Paste rows
            </button>
          </div>

          {mode === "file" ? (
            <>
              <input
                ref={fileInput}
                className="sr-only"
                type="file"
                accept=".csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values"
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const file = event.target.files?.[0];
                  if (file) void parseFile(file);
                  event.target.value = "";
                }}
              />
              <div
                className={`drop-zone ${dragging ? "dragging" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => fileInput.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") fileInput.current?.click();
                }}
                onDragOver={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault();
                  setDragging(false);
                  const file = event.dataTransfer.files?.[0];
                  if (file) void parseFile(file);
                }}
              >
                <FileSpreadsheet size={34} aria-hidden="true" />
                <strong>{parsing ? "Reading recall list…" : "Drop a recall list here"}</strong>
                <span>or click to choose a file</span>
                <small>CSV, TSV, XLSX, or XLS · up to 25 MB</small>
              </div>
              <a className="ghost-button" href={`${import.meta.env.BASE_URL}recall-list-template.csv`} download>
                <Download size={18} /> Download a clean template
              </a>
            </>
          ) : (
            <div className="field">
              <label htmlFor="paste-rows">Paste a header row and recall items</label>
              <textarea
                id="paste-rows"
                value={pasteValue}
                onChange={(event) => setPasteValue(event.target.value)}
                placeholder={"UPC,Brand,Model,Color,Quantity\n036000291452,Example Optical,A100,Black,1"}
              />
              <button className="secondary-button" onClick={parsePaste} disabled={!pasteValue.trim()}>
                <ListChecks size={18} /> Review pasted rows
              </button>
            </div>
          )}

          {result ? (
            <>
              <div className="mapping-card">
                <h3>Import preview · {result.rows.length} valid items</h3>
                <div className="preview-scroll">
                  <table className="preview-table">
                    <thead>
                      <tr><th>Barcode</th><th>Description</th><th>Qty</th></tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 8).map((row, index) => (
                        <tr key={`${row.barcode}-${index}`}>
                          <td>{row.barcode}</td>
                          <td>{row.description || row.model || "—"}</td>
                          <td>{row.quantity || 1}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {result.rejected.length ? (
                <div className="notice warning">
                  <AlertTriangle size={19} />
                  <span>
                    {result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} cannot be imported. The valid rows above will be used; review the source before continuing.
                  </span>
                </div>
              ) : (
                <div className="notice success">
                  <ShieldCheck size={19} />
                  <span>All rows have a usable barcode. You will confirm the active recall before scanning.</span>
                </div>
              )}
              {result.warnings.map((warning) => (
                <div className="notice warning" key={warning}>
                  <AlertTriangle size={19} /> <span>{warning}</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
        <div className="drawer-actions">
          <button className="secondary-button" onClick={onClose}>Cancel</button>
          <button
            className="primary-button"
            onClick={() => void createRecall()}
            disabled={creating || !result?.rows.length}
          >
            <Play size={19} /> {creating ? "Creating…" : `Start scanning${result ? ` ${result.rows.length} items` : ""}`}
          </button>
        </div>
      </aside>
    </div>
  );
}

function playFeedback(outcome: ScanOutcome, enabled: boolean) {
  if (!enabled) return;
  try {
    const AudioContextCtor = window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.frequency.value = outcome === "match" ? 760 : outcome === "miss" ? 220 : 430;
    oscillator.type = outcome === "invalid" ? "triangle" : "sine";
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.09, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.14);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.15);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Text and color remain the source of truth when audio is unavailable.
  }
}

function ResultPanel({ result }: { result: RecordedScanResult | null }) {
  const outcome = result?.scan.outcome;
  const state = !result ? "ready" : outcome === "match" ? "match" : outcome === "miss" ? "miss" : "invalid";
  const isRepeat = Boolean(result?.alreadyMatched);
  const copy = !result
    ? {
        kicker: "Scanner ready",
        title: "READY TO SCAN",
        detail: "Scan a frame barcode to check this recall.",
      }
    : outcome === "match"
      ? {
          kicker: isRepeat ? "Additional recalled piece" : "Recall match found",
          title: "KEEP — RECALL",
          detail: isRepeat
            ? "Set this frame aside too. Matching physical pieces always stay green."
            : "Set this frame aside and continue scanning.",
        }
      : outcome === "miss"
        ? {
            kicker: "Valid barcode, not on this recall",
            title: "LEAVE",
            detail: "This frame is not included in the selected recall list.",
          }
        : {
            kicker: "No safe decision was made",
            title: "SCAN AGAIN",
            detail: "The barcode was incomplete, unreadable, or invalid. Try this frame again.",
          };
  const Icon = state === "match" ? Check : state === "miss" ? X : state === "invalid" ? RotateCcw : Barcode;

  return (
    <section className={`result-panel ${state}`} aria-live="assertive" aria-atomic="true">
      <div className="result-inner">
        <div className="result-icon"><Icon size={48} strokeWidth={2.6} /></div>
        <p className="result-kicker">{copy.kicker}</p>
        <h2 className="result-title">{copy.title}</h2>
        <p className="result-detail">{copy.detail}</p>
        {result ? (
          <div className="result-meta">
            {result.item ? <span><strong>Frame:</strong> {result.item.description}</span> : null}
            <span><strong>Barcode:</strong> {result.scan.barcode || result.scan.rawValue}</span>
          </div>
        ) : null}
        <p className="result-note">
          {state === "match" ? "Every matching physical frame should be set aside." : "The selected recall list is the only match source."}
        </p>
      </div>
    </section>
  );
}

function MetricCard({
  icon,
  label,
  value,
  unit,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  unit: string;
  tone?: string;
}) {
  return (
    <div className={`metric-card ${tone || ""}`}>
      <div className="metric-icon">{icon}</div>
      <div className="metric-copy">
        <span>{label}</span>
        <strong>{value.toLocaleString()}</strong>
        <small>{unit}</small>
      </div>
    </div>
  );
}

function ScannerView({
  snapshot,
  onBack,
  onReport,
  onRefresh,
  pushToast,
}: {
  snapshot: CampaignSnapshot;
  onBack: () => void;
  onReport: () => void;
  onRefresh: () => Promise<CampaignSnapshot | null>;
  pushToast: (message: string, error?: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const [lastResult, setLastResult] = useState<RecordedScanResult | null>(null);
  const [working, setWorking] = useState(false);
  const [search, setSearch] = useState("");
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem("recall-router:sound") !== "off");
  const [saveFailed, setSaveFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoTimer = useRef<number | undefined>(undefined);
  const locked = useCampaignLock(snapshot.campaign.id);

  useEffect(() => {
    inputRef.current?.focus();
  }, [snapshot.campaign.id]);

  useEffect(() => () => window.clearTimeout(autoTimer.current), []);

  const submitScan = useCallback(async (value = input) => {
    const raw = value.trim();
    window.clearTimeout(autoTimer.current);
    if (!raw || working || locked) {
      inputRef.current?.focus();
      return;
    }
    setWorking(true);
    try {
      const result = await recordScan(snapshot.campaign.id, raw);
      setLastResult(result);
      setInput("");
      setSaveFailed(false);
      playFeedback(result.scan.outcome, soundOn);
      await onRefresh();
    } catch (error) {
      setSaveFailed(true);
      pushToast(
        error instanceof Error ? `Scan was not saved: ${error.message}` : "Scan was not saved. Do not close this page.",
        true,
      );
    } finally {
      setWorking(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [input, locked, onRefresh, pushToast, snapshot.campaign.id, soundOn, working]);

  const scheduleAutoSubmit = (value: string) => {
    window.clearTimeout(autoTimer.current);
    const compact = value.replace(/[\s-]/g, "");
    if (compact.length < 8) return;
    autoTimer.current = window.setTimeout(() => void submitScan(value), 160);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      void submitScan();
    }
    if (event.key === "Escape") {
      setInput("");
      setLastResult(null);
    }
  };

  const handleUndo = async () => {
    try {
      const undone = await undoLastScan(snapshot.campaign.id);
      if (!undone) {
        pushToast("There is no scan to undo.", true);
        return;
      }
      setLastResult(null);
      await onRefresh();
      pushToast("Last scan undone. The list and counters were restored.");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "The last scan could not be undone.", true);
    } finally {
      inputRef.current?.focus();
    }
  };

  const updateStatus = async (status: CampaignStatus) => {
    const now = new Date().toISOString();
    const patch: Partial<Campaign> = { status, updatedAt: now };
    if (status === "paused") patch.pausedAt = now;
    if (status === "completed") patch.completedAt = now;
    if (status === "archived") patch.archivedAt = now;
    if (status === "active") patch.startedAt = snapshot.campaign.startedAt || now;
    await db.campaigns.update(snapshot.campaign.id, patch);
    await onRefresh();
    pushToast(`Recall marked ${status}.`);
    if (status === "archived") onBack();
  };

  const filteredItems = snapshot.items.filter((item) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [item.barcode, item.description, item.model, item.color]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(needle));
  });

  const recentScans = snapshot.scans
    .filter((scan) => !scan.undoneAt)
    .slice()
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))
    .slice(0, 25);
  const uniqueSeen = snapshot.items.filter((item) => item.quantityFound > 0).length;

  return (
    <>
      <Topbar
        onHome={onBack}
        location={snapshot.campaign.locationName}
        saved={!saveFailed}
        soundOn={soundOn}
        onToggleSound={() => {
          const next = !soundOn;
          setSoundOn(next);
          localStorage.setItem("recall-router:sound", next ? "on" : "off");
          inputRef.current?.focus();
        }}
      />
      <main className="scanner-page">
        {locked ? (
          <div className="notice danger lock-banner" role="alert">
            <AlertTriangle size={20} />
            <span>This recall is already open in another tab. Scanning is paused here to protect progress.</span>
          </div>
        ) : null}
        {snapshot.campaign.status === "paused" ? (
          <div className="notice warning lock-banner" role="status">
            <Pause size={20} />
            <span>This recall is paused. Choose Resume before scanning more frames.</span>
          </div>
        ) : null}
        <div className="scanner-context">
          <div>
            <p className="eyebrow">Selected recall · {snapshot.campaign.status}</p>
            <h1>{snapshot.campaign.brand} · {snapshot.campaign.name}</h1>
            <p>
              {snapshot.campaign.recallReference || "No reference"} · {snapshot.campaign.sourceFileName || "Included recall list"} · {snapshot.campaign.locationName}
            </p>
          </div>
          <div className="library-toolbar no-print">
            <button className="secondary-button" onClick={onBack}><ArrowLeft size={18} /> Library</button>
            <button className="secondary-button" onClick={onReport}><Printer size={18} /> Report / PDF</button>
            {snapshot.campaign.status === "paused" ? (
              <button className="primary-button" onClick={() => void updateStatus("active")}><Play size={18} /> Resume</button>
            ) : (
              <button className="secondary-button" onClick={() => void updateStatus("paused")}><Pause size={18} /> Pause</button>
            )}
            {snapshot.summary.remainingItems === 0 && snapshot.campaign.status !== "completed" ? (
              <button className="primary-button" onClick={() => void updateStatus("completed")}><PackageCheck size={18} /> Complete</button>
            ) : null}
          </div>
        </div>

        <div className="metric-grid" aria-label="Recall progress summary">
          <MetricCard icon={<Barcode size={25} />} label="Total scanned" value={snapshot.summary.totalScans} unit="accepted scan events" />
          <MetricCard icon={<PackageCheck size={25} />} label="Recall pieces found" value={snapshot.summary.matchScans} unit="physical frames" tone="recall" />
          <MetricCard icon={<ListChecks size={25} />} label="Unique recalled UPCs found" value={uniqueSeen} unit={`of ${snapshot.summary.totalItems} UPCs`} tone="recall" />
          <MetricCard icon={<Search size={25} />} label="UPCs still not seen" value={snapshot.summary.totalItems - uniqueSeen} unit="recall-list UPCs" tone="remaining" />
        </div>

        <div className="scanner-layout">
          <div className="scan-workspace">
            <ResultPanel result={lastResult} />
            <form
              className="scan-entry"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void submitScan();
              }}
            >
              <label className="scan-label" htmlFor="barcode-input">
                <Keyboard size={26} />
                <span><strong>SCAN BARCODE</strong><span>Ready for USB scanner</span></span>
              </label>
              <input
                ref={inputRef}
                id="barcode-input"
                className="scan-input"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  scheduleAutoSubmit(event.target.value);
                }}
                onKeyDown={handleKeyDown}
                placeholder={locked ? "Open tab is scanning" : "Scan UPC, EAN, or GTIN…"}
                autoComplete="off"
                inputMode="numeric"
                disabled={locked || working || snapshot.campaign.status !== "active"}
                aria-describedby="scan-help"
                autoFocus
              />
              <button className="primary-button scan-submit" type="submit" disabled={!input.trim() || working || locked}>
                Check
              </button>
            </form>
            <div className="scan-helper-row" id="scan-help">
              <span><strong>Keep scanning:</strong> Enter, Tab, and suffixless scanner input are supported.</span>
              <span>Invalid or partial barcodes always show SCAN AGAIN.</span>
            </div>

            <section className="history-panel">
              <div className="history-heading">
                <h2><History size={19} /> Scan history</h2>
                <button className="secondary-button" onClick={() => void handleUndo()} disabled={!recentScans.length}>
                  <RotateCcw size={18} /> Undo last scan
                </button>
              </div>
              <div className="history-scroll">
                {recentScans.length ? (
                  <table className="history-table">
                    <thead><tr><th>Time</th><th>Barcode</th><th>Result</th><th>Frame</th></tr></thead>
                    <tbody>
                      {recentScans.map((scan) => (
                        <tr key={scan.id}>
                          <td>{formatDate(scan.scannedAt)}</td>
                          <td>{scan.barcode || scan.rawValue}</td>
                          <td>
                            <span className={`result-badge ${scan.outcome}`}>
                              {scan.outcome === "match" ? <CheckCircle2 size={15} /> : scan.outcome === "miss" ? <XCircle size={15} /> : scan.outcome === "legacy" ? <Database size={15} /> : <RotateCcw size={15} />}
                              {scan.outcome === "match" ? (scan.isRepeatMatch ? "KEEP · extra" : "KEEP") : scan.outcome === "miss" ? "LEAVE" : scan.outcome === "legacy" ? "IMPORTED SUMMARY" : "SCAN AGAIN"}
                            </span>
                          </td>
                          <td>{scan.itemDescription || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div className="empty-state">No scans yet. The first result will appear here.</div>}
              </div>
            </section>
          </div>

          <aside className="remaining-panel" aria-label="Recall list progress">
            <div className="panel-heading">
              <h2><ListChecks size={19} /> Recall list</h2>
              <span className="remaining-summary">{snapshot.summary.remainingItems} left</span>
            </div>
            <div className="search-box">
              <Search size={18} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search UPC or frame"
                aria-label="Search recall list"
              />
            </div>
            <div className="remaining-list">
              {filteredItems.map((item) => {
                const found = item.quantityFound >= item.quantityRequired;
                return (
                  <div className={`remaining-row ${found ? "found" : ""}`} key={item.id}>
                    <span className="item-state">{found ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}</span>
                    <span className="item-copy">
                      <span className="item-upc">{item.barcode}</span>
                      <span className="item-name">{item.description}</span>
                    </span>
                    <span className="item-count">{item.quantityFound}/{item.quantityRequired}</span>
                  </div>
                );
              })}
            </div>
            <div className="remaining-footer no-print">
              <button className="secondary-button" onClick={onReport}><Printer size={18} /> Save / print report</button>
              <button
                className="ghost-button"
                onClick={() => {
                  const csv = campaignToCsv({
                    ...snapshot,
                    items: snapshot.items.filter((item) => item.quantityFound < item.quantityRequired),
                  });
                  downloadTextFile(`${safeFilename(snapshot.campaign.name)}-remaining.csv`, csv, "text/csv;charset=utf-8");
                }}
              >
                <FileDown size={18} /> Export remaining CSV
              </button>
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}

function ReportView({ snapshot, onBack }: { snapshot: CampaignSnapshot; onBack: () => void }) {
  const matches = snapshot.scans.filter((scan) => scan.outcome === "match" && !scan.undoneAt);
  const remaining = snapshot.items.filter((item) => item.quantityFound < item.quantityRequired);
  return (
    <>
      <Topbar onHome={onBack} location={snapshot.campaign.locationName} />
      <main className="report-page">
        <div className="page-heading no-print">
          <button className="secondary-button" onClick={onBack}><ArrowLeft size={18} /> Back</button>
          <div className="library-toolbar">
            <button
              className="secondary-button"
              onClick={() => void (async () => {
                const allScans = await db.scans.where("campaignId").equals(snapshot.campaign.id).toArray();
                allScans.sort((left, right) => left.scannedAt.localeCompare(right.scannedAt));
                const csv = scansToCsv(allScans);
                downloadTextFile(`${safeFilename(snapshot.campaign.name)}-scan-log.csv`, csv, "text/csv;charset=utf-8");
              })()}
            >
              <FileDown size={18} /> Scan log CSV
            </button>
            <button className="primary-button" onClick={() => window.print()}><Printer size={18} /> Save as PDF / print</button>
          </div>
        </div>
        <article className="report-sheet">
          <header className="report-header">
            <div>
              <p className="eyebrow">Optical frame recall report</p>
              <h1>{snapshot.campaign.brand} · {snapshot.campaign.name}</h1>
              <span>{snapshot.campaign.recallReference || "No reference number"}</span>
            </div>
            <div className="context-copy">
              <strong>{snapshot.campaign.locationName}</strong>
              <span>Generated {formatDate(new Date().toISOString())}</span>
              <span>Source: {snapshot.campaign.sourceFileName || "Included list"}</span>
            </div>
          </header>
          <div className="report-meta">
            <div className="report-stat"><span>Total scans</span><strong>{snapshot.summary.totalScans}</strong></div>
            <div className="report-stat"><span>Recall pieces</span><strong>{snapshot.summary.matchScans}</strong></div>
            <div className="report-stat"><span>Unique found</span><strong>{snapshot.summary.foundItems}</strong></div>
            <div className="report-stat"><span>Items left</span><strong>{snapshot.summary.remainingItems}</strong></div>
          </div>
          <section className="report-section">
            <h2>Recall list status</h2>
            <div className="campaign-table-wrap">
              <table className="campaign-table">
                <thead><tr><th>Barcode</th><th>Frame</th><th>Found / required</th><th>Status</th></tr></thead>
                <tbody>
                  {snapshot.items.map((item) => {
                    const found = item.quantityFound >= item.quantityRequired;
                    return (
                      <tr key={item.id}>
                        <td>{item.barcode}</td>
                        <td>{item.description}</td>
                        <td>{item.quantityFound} / {item.quantityRequired}</td>
                        <td><span className={`status-badge ${found ? "completed" : "paused"}`}>{found ? "Located" : "Remaining"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section className="report-section">
            <h2>Scan summary</h2>
            <p>
              {matches.length} recalled physical frame{matches.length === 1 ? "" : "s"} scanned; {remaining.length} recall list item{remaining.length === 1 ? "" : "s"} still not satisfied; {snapshot.summary.missScans} leave scan{snapshot.summary.missScans === 1 ? "" : "s"}; {snapshot.summary.invalidScans} rescan exception{snapshot.summary.invalidScans === 1 ? "" : "s"}.
            </p>
          </section>
        </article>
      </main>
    </>
  );
}

function ConfirmDialog({
  campaign,
  onCancel,
  onConfirm,
}: {
  campaign: Campaign;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="archive-title">
        <div className="dialog-header">
          <h2 id="archive-title">Archive this recall?</h2>
          <button className="icon-button" onClick={onCancel} aria-label="Cancel"><X size={20} /></button>
        </div>
        <div className="dialog-body">
          <p><strong>{campaign.brand} · {campaign.name}</strong> will move to the archive and become read-only.</p>
          <p className="subtle">Its source list, scan log, progress, and reports stay available. Create a backup if this device will be replaced.</p>
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onCancel}>Keep active</button>
          <button className="danger-button" onClick={onConfirm}><Archive size={18} /> Archive recall</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(loadLastScreen);
  const [snapshots, setSnapshots] = useState<CampaignSnapshot[]>([]);
  const [activeSnapshot, setActiveSnapshot] = useState<CampaignSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [newRecallOpen, setNewRecallOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Campaign | null>(null);
  const { toasts, pushToast } = useToasts();

  const refreshAll = useCallback(async () => {
    const campaigns = await db.campaigns.toArray();
    const loaded = (await Promise.all(campaigns.map((campaign) => getCampaignSnapshot(campaign.id))))
      .filter((snapshot): snapshot is CampaignSnapshot => Boolean(snapshot));
    setSnapshots(loaded);
    return loaded;
  }, []);

  const refreshCampaign = useCallback(async () => {
    if (screen.name === "library") return null;
    const snapshot = await getCampaignSnapshot(screen.campaignId);
    setActiveSnapshot(snapshot);
    if (snapshot) {
      setSnapshots((current) => [snapshot, ...current.filter((row) => row.campaign.id !== snapshot.campaign.id)]);
    }
    return snapshot;
  }, [screen]);

  useEffect(() => {
    if (screen.name === "library") localStorage.removeItem(LAST_SCREEN_KEY);
    else localStorage.setItem(LAST_SCREEN_KEY, JSON.stringify(screen));
  }, [screen]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await refreshAll();
      } catch (error) {
        pushToast(error instanceof Error ? error.message : "Recall Router could not open its local database.", true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [pushToast, refreshAll]);

  useEffect(() => {
    if (screen.name === "library") {
      setActiveSnapshot(null);
      void refreshAll();
      return;
    }
    void refreshCampaign();
  }, [refreshAll, refreshCampaign, screen]);

  const openScanner = (campaignId: string) => setScreen({ name: "scanner", campaignId });
  const openReport = (campaignId: string) => setScreen({ name: "report", campaignId });

  const handleArchive = async () => {
    if (!archiveTarget) return;
    const now = new Date().toISOString();
    await db.campaigns.update(archiveTarget.id, { status: "archived", archivedAt: now, updatedAt: now });
    setArchiveTarget(null);
    await refreshAll();
    pushToast("Recall archived with its progress and scan history intact.");
  };

  const handleBackup = async () => {
    try {
      const backup = await createBackup();
      downloadTextFile(
        `recall-router-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(backup, null, 2),
        "application/json",
      );
      pushToast("Full local backup downloaded.");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Backup could not be created.", true);
    }
  };

  const handleRestore = async (file: File) => {
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("That backup is larger than the 50 MB restore safety limit.");
      const text = await file.text();
      const backup = parseBackup(text);
      const existing = await db.campaigns.bulkGet(backup.campaigns.map((campaign) => campaign.id));
      const conflictCount = existing.filter(Boolean).length;
      const generated = formatDate(backup.generatedAt);
      const warning = conflictCount
        ? ` ${conflictCount} campaign${conflictCount === 1 ? "" : "s"} already on this device will be replaced with the backup version.`
        : " Existing campaigns with different IDs will remain.";
      const confirmed = window.confirm(
        `Restore backup from ${generated}? It contains ${backup.campaigns.length} campaign${backup.campaigns.length === 1 ? "" : "s"} and ${backup.scans.length} scan record${backup.scans.length === 1 ? "" : "s"}.${warning}`,
      );
      if (!confirmed) {
        pushToast("Restore canceled. Current local progress was not changed.");
        return;
      }
      const safetyBackup = await createBackup();
      downloadTextFile(
        `recall-router-before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        JSON.stringify(safetyBackup, null, 2),
        "application/json",
      );
      await restoreBackup(backup);
      await refreshAll();
      pushToast("Backup restored. Campaigns and scan history are available.");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "This backup could not be restored.", true);
    }
  };

  if (loading) {
    return (
      <div className="app-shell">
        <Topbar onHome={() => setScreen({ name: "library" })} />
        <main className="page"><div className="empty-state"><Database size={38} /><h2>Opening local recall library…</h2><p>Your saved work stays on this device.</p></div></main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {screen.name === "library" ? (
        <>
          <Topbar onHome={() => setScreen({ name: "library" })} />
          <LibraryView
            snapshots={snapshots}
            onStartNew={() => setNewRecallOpen(true)}
            onOpen={openScanner}
            onReport={openReport}
            onArchive={setArchiveTarget}
            onBackup={() => void handleBackup()}
            onRestore={(file) => void handleRestore(file)}
          />
        </>
      ) : activeSnapshot && screen.name === "scanner" ? (
        <ScannerView
          snapshot={activeSnapshot}
          onBack={() => setScreen({ name: "library" })}
          onReport={() => openReport(activeSnapshot.campaign.id)}
          onRefresh={refreshCampaign}
          pushToast={pushToast}
        />
      ) : activeSnapshot && screen.name === "report" ? (
        <ReportView
          snapshot={activeSnapshot}
          onBack={() => {
            if (activeSnapshot.campaign.status === "archived" || activeSnapshot.campaign.status === "completed") {
              setScreen({ name: "library" });
            } else {
              openScanner(activeSnapshot.campaign.id);
            }
          }}
        />
      ) : (
        <><Topbar onHome={() => setScreen({ name: "library" })} /><main className="page"><div className="empty-state">Loading recall…</div></main></>
      )}

      {newRecallOpen ? (
        <NewRecallDrawer
          onClose={() => setNewRecallOpen(false)}
          onCreated={(campaignId) => {
            setNewRecallOpen(false);
            void refreshAll();
            openScanner(campaignId);
          }}
          pushToast={pushToast}
        />
      ) : null}
      {archiveTarget ? (
        <ConfirmDialog campaign={archiveTarget} onCancel={() => setArchiveTarget(null)} onConfirm={() => void handleArchive()} />
      ) : null}
      <Toasts toasts={toasts} />
    </div>
  );
}
