import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FilePlus2,
  ListFilter,
  PencilLine,
  Plus,
  Save,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import {
  addCampaignItem,
  mergeCampaignItems,
  previewCampaignItemMerge,
  updateCampaignItem,
} from "../db";
import type {
  CampaignItemMergePreview,
  CampaignSnapshot,
  RecallItem,
} from "../types";
import { RecallIntake, type RecallIntakeValue } from "./RecallIntake";

type ManagerTab = "import" | "manual" | "existing";

interface CampaignItemManagerDrawerProps {
  snapshot: CampaignSnapshot;
  onClose: () => void;
  onUpdated: () => Promise<void>;
  pushToast: (message: string, error?: boolean) => void;
}

interface ManualItemDraft {
  barcode: string;
  description: string;
  brand: string;
  model: string;
  style: string;
  color: string;
  sku: string;
  notes: string;
  quantity: string;
}

interface EditItemDraft {
  description: string;
  brand: string;
  model: string;
  style: string;
  color: string;
  sku: string;
  notes: string;
  quantityRequired: string;
}

const emptyIntake: RecallIntakeValue = {
  result: null,
  ready: false,
  assisted: false,
};

function initialManualDraft(brand: string): ManualItemDraft {
  return {
    barcode: "",
    description: "",
    brand,
    model: "",
    style: "",
    color: "",
    sku: "",
    notes: "",
    quantity: "1",
  };
}

function editDraftFor(item: RecallItem): EditItemDraft {
  return {
    description: item.description,
    brand: item.brand ?? "",
    model: item.model ?? "",
    style: item.style ?? "",
    color: item.color ?? "",
    sku: item.sku ?? "",
    notes: item.notes ?? "",
    quantityRequired: String(item.quantityRequired),
  };
}

function wholeQuantity(value: string): number {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    throw new Error("Quantity must be a whole number between 1 and 1,000,000.");
  }
  return quantity;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "That change could not be saved.";
}

export function CampaignItemManagerDrawer({
  snapshot,
  onClose,
  onUpdated,
  pushToast,
}: CampaignItemManagerDrawerProps) {
  const [tab, setTab] = useState<ManagerTab>("import");
  const [campaignUpdatedAt, setCampaignUpdatedAt] = useState(snapshot.campaign.updatedAt);
  const [intake, setIntake] = useState<RecallIntakeValue>(emptyIntake);
  const [intakeKey, setIntakeKey] = useState(0);
  const [mergePreview, setMergePreview] = useState<CampaignItemMergePreview | null>(null);
  const [manual, setManual] = useState<ManualItemDraft>(() => initialManualDraft(snapshot.campaign.brand));
  const [search, setSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState<RecallItem | null>(null);
  const [editDraft, setEditDraft] = useState<EditItemDraft | null>(null);
  const [working, setWorking] = useState(false);

  const isPaused = snapshot.campaign.status === "paused";

  useEffect(() => {
    setCampaignUpdatedAt(snapshot.campaign.updatedAt);
  }, [snapshot.campaign.updatedAt]);

  useEffect(() => {
    if (!selectedItem) return;
    const refreshed = snapshot.items.find((item) => item.id === selectedItem.id);
    if (refreshed && refreshed.updatedAt > selectedItem.updatedAt) {
      setSelectedItem(refreshed);
      setEditDraft(editDraftFor(refreshed));
    }
  }, [selectedItem, snapshot.items]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return snapshot.items;
    return snapshot.items.filter((item) => [
      item.barcode,
      item.description,
      item.brand,
      item.model,
      item.style,
      item.color,
      item.sku,
    ].some((value) => value?.toLowerCase().includes(query)));
  }, [search, snapshot.items]);

  const resetIntake = () => {
    setIntake(emptyIntake);
    setMergePreview(null);
    setIntakeKey((current) => current + 1);
  };

  const handleIntakeChange = (value: RecallIntakeValue) => {
    setIntake(value);
    setMergePreview(null);
  };

  const reviewMerge = async () => {
    if (!isPaused || !intake.ready || !intake.result) return;
    setWorking(true);
    try {
      const preview = await previewCampaignItemMerge(snapshot.campaign.id, intake.result.rows);
      if (preview.campaignUpdatedAt !== campaignUpdatedAt) {
        await onUpdated();
        throw new Error("This recall changed while the list was open. The latest version is loaded; review the rows again.");
      }
      setMergePreview(preview);
    } catch (error) {
      pushToast(messageFor(error), true);
    } finally {
      setWorking(false);
    }
  };

  const confirmMerge = async () => {
    if (!isPaused || !intake.result || !mergePreview || !mergePreview.additions.length) return;
    setWorking(true);
    try {
      const result = await mergeCampaignItems(
        snapshot.campaign.id,
        intake.result.rows,
        { expectedCampaignUpdatedAt: mergePreview.campaignUpdatedAt },
      );
      setCampaignUpdatedAt(result.campaign.updatedAt);
      await onUpdated();
      pushToast(
        `${result.addedItems.length} new recall row${result.addedItems.length === 1 ? " was" : "s were"} added. ${result.skippedExistingItems.length} existing duplicate${result.skippedExistingItems.length === 1 ? " was" : "s were"} skipped.`,
      );
      resetIntake();
    } catch (error) {
      await onUpdated();
      setMergePreview(null);
      pushToast(messageFor(error), true);
    } finally {
      setWorking(false);
    }
  };

  const addManual = async (event: FormEvent) => {
    event.preventDefault();
    if (!isPaused) return;
    setWorking(true);
    try {
      if (!manual.description.trim()) throw new Error("Frame description is required.");
      const item = await addCampaignItem(
        snapshot.campaign.id,
        {
          barcode: manual.barcode,
          description: manual.description,
          brand: manual.brand || undefined,
          model: manual.model || undefined,
          style: manual.style || undefined,
          color: manual.color || undefined,
          sku: manual.sku || undefined,
          notes: manual.notes || undefined,
          quantity: wholeQuantity(manual.quantity),
        },
        { expectedCampaignUpdatedAt: campaignUpdatedAt },
      );
      setCampaignUpdatedAt(item.updatedAt);
      setManual(initialManualDraft(snapshot.campaign.brand));
      await onUpdated();
      pushToast(`${item.barcode} was added to this recall. Existing scan progress was preserved.`);
    } catch (error) {
      await onUpdated();
      pushToast(messageFor(error), true);
    } finally {
      setWorking(false);
    }
  };

  const chooseItem = (item: RecallItem) => {
    setSelectedItem(item);
    setEditDraft(editDraftFor(item));
  };

  const saveExisting = async (event: FormEvent) => {
    event.preventDefault();
    if (!isPaused || !selectedItem || !editDraft) return;
    setWorking(true);
    try {
      const updated = await updateCampaignItem(
        snapshot.campaign.id,
        selectedItem.id,
        {
          description: editDraft.description,
          brand: editDraft.brand || null,
          model: editDraft.model || null,
          style: editDraft.style || null,
          color: editDraft.color || null,
          sku: editDraft.sku || null,
          notes: editDraft.notes || null,
          quantityRequired: wholeQuantity(editDraft.quantityRequired),
        },
        {
          expectedCampaignUpdatedAt: campaignUpdatedAt,
          expectedItemUpdatedAt: selectedItem.updatedAt,
        },
      );
      setCampaignUpdatedAt((current) => current > updated.updatedAt ? current : updated.updatedAt);
      setSelectedItem(updated);
      setEditDraft(editDraftFor(updated));
      await onUpdated();
      pushToast(`${updated.barcode} was updated. Its scan history and quantity found were preserved.`);
    } catch (error) {
      await onUpdated();
      pushToast(messageFor(error), true);
    } finally {
      setWorking(false);
    }
  };

  return (
    <aside
      className="drawer campaign-item-manager"
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-item-manager-title"
    >
      <div className="drawer-header campaign-item-manager-header">
        <div>
          <p className="eyebrow">Paused recall list</p>
          <h2 id="campaign-item-manager-title">Manage recalled frames</h2>
          <p>{snapshot.campaign.brand} · {snapshot.campaign.name}</p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close recall list manager" disabled={working}>
          <X size={20} />
        </button>
      </div>

      <div className="drawer-body campaign-item-manager-body">
        {!isPaused ? (
          <div className="notice warning" role="alert">
            <AlertTriangle size={20} />
            <span><strong>Pause scanning before changing this list.</strong> Close this panel, pause the recall, then reopen it.</span>
          </div>
        ) : (
          <div className="notice success campaign-item-manager-safety">
            <ShieldCheck size={20} />
            <span><strong>Progress-safe editing is on.</strong> Existing scans and quantities found stay intact; UPCs already on this recall are skipped.</span>
          </div>
        )}

        <div className="input-tabs campaign-item-manager-tabs" role="tablist" aria-label="Recall list changes">
          <button className={`input-tab ${tab === "import" ? "active" : ""}`} onClick={() => setTab("import")} role="tab" aria-selected={tab === "import"}>
            <FilePlus2 size={17} /> Add a list
          </button>
          <button className={`input-tab ${tab === "manual" ? "active" : ""}`} onClick={() => setTab("manual")} role="tab" aria-selected={tab === "manual"}>
            <Plus size={17} /> Add one frame
          </button>
          <button className={`input-tab ${tab === "existing" ? "active" : ""}`} onClick={() => setTab("existing")} role="tab" aria-selected={tab === "existing"}>
            <PencilLine size={17} /> Edit existing
          </button>
        </div>

        {tab === "import" ? (
          <section className="campaign-item-manager-section" role="tabpanel">
            <div className="campaign-item-manager-section-heading">
              <div>
                <h3>Add rows from a file, PDF, photo, or pasted list</h3>
                <p>Review the source, then see exactly what will be added before anything changes.</p>
              </div>
            </div>
            <RecallIntake
              key={intakeKey}
              onChange={handleIntakeChange}
              pushToast={pushToast}
            />

            {mergePreview ? (
              <div className="campaign-merge-confirm" aria-live="polite">
                <div className="campaign-merge-summary">
                  <div><strong>{mergePreview.additions.length}</strong><span>new UPCs to add</span></div>
                  <div><strong>{mergePreview.existing.length}</strong><span>existing UPCs skipped</span></div>
                  <div><strong>{snapshot.summary.totalScans}</strong><span>scan records preserved</span></div>
                </div>
                {mergePreview.additions.some((row) => row.priorMissCount > 0) ? (
                  <div className="notice warning">
                    <AlertTriangle size={19} />
                    <span>Some new UPCs were scanned earlier as “leave.” Those historical scans remain unchanged; scan the physical frames again after resuming.</span>
                  </div>
                ) : null}
                <div className="notice success">
                  <CheckCircle2 size={19} />
                  <span>No existing frame rows, scan records, or found counts will be deleted or reset.</span>
                </div>
                <div className="campaign-merge-actions">
                  <button className="secondary-button" onClick={() => setMergePreview(null)} disabled={working}>Review rows again</button>
                  <button className="primary-button" onClick={() => void confirmMerge()} disabled={working || !mergePreview.additions.length || !isPaused}>
                    <Database size={18} />
                    {mergePreview.additions.length
                      ? `Confirm · add ${mergePreview.additions.length} new row${mergePreview.additions.length === 1 ? "" : "s"}`
                      : "No new rows to add"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="campaign-item-manager-actions">
                <button className="primary-button" onClick={() => void reviewMerge()} disabled={working || !intake.ready || !isPaused}>
                  <ListFilter size={18} /> Compare with the current list
                </button>
                <p>Duplicates are identified and skipped before confirmation.</p>
              </div>
            )}
          </section>
        ) : null}

        {tab === "manual" ? (
          <section className="campaign-item-manager-section" role="tabpanel">
            <div className="campaign-item-manager-section-heading">
              <div>
                <h3>Add one missing frame</h3>
                <p>The barcode is checked before saving. An existing UPC will be safely rejected as a duplicate.</p>
              </div>
            </div>
            <form className="campaign-item-form" onSubmit={(event) => void addManual(event)}>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="manual-frame-barcode">UPC / GTIN *</label>
                  <input id="manual-frame-barcode" value={manual.barcode} onChange={(event) => setManual({ ...manual, barcode: event.target.value })} inputMode="numeric" autoComplete="off" required />
                </div>
                <div className="field">
                  <label htmlFor="manual-frame-quantity">Required quantity *</label>
                  <input id="manual-frame-quantity" type="number" min="1" max="1000000" step="1" value={manual.quantity} onChange={(event) => setManual({ ...manual, quantity: event.target.value })} required />
                </div>
                <div className="field full">
                  <label htmlFor="manual-frame-description">Frame description *</label>
                  <input id="manual-frame-description" value={manual.description} onChange={(event) => setManual({ ...manual, description: event.target.value })} required />
                </div>
                <div className="field"><label htmlFor="manual-frame-brand">Brand</label><input id="manual-frame-brand" value={manual.brand} onChange={(event) => setManual({ ...manual, brand: event.target.value })} /></div>
                <div className="field"><label htmlFor="manual-frame-model">Model</label><input id="manual-frame-model" value={manual.model} onChange={(event) => setManual({ ...manual, model: event.target.value })} /></div>
                <div className="field"><label htmlFor="manual-frame-style">Style</label><input id="manual-frame-style" value={manual.style} onChange={(event) => setManual({ ...manual, style: event.target.value })} /></div>
                <div className="field"><label htmlFor="manual-frame-color">Color</label><input id="manual-frame-color" value={manual.color} onChange={(event) => setManual({ ...manual, color: event.target.value })} /></div>
                <div className="field"><label htmlFor="manual-frame-sku">SKU</label><input id="manual-frame-sku" value={manual.sku} onChange={(event) => setManual({ ...manual, sku: event.target.value })} /></div>
                <div className="field full"><label htmlFor="manual-frame-notes">Notes</label><textarea id="manual-frame-notes" value={manual.notes} onChange={(event) => setManual({ ...manual, notes: event.target.value })} /></div>
              </div>
              <div className="campaign-item-manager-actions">
                <button className="primary-button" type="submit" disabled={working || !isPaused}>
                  <Plus size={18} /> Add frame to recall
                </button>
                <p>Existing scans and progress will not be changed.</p>
              </div>
            </form>
          </section>
        ) : null}

        {tab === "existing" ? (
          <section className="campaign-item-manager-section" role="tabpanel">
            <div className="campaign-item-manager-section-heading">
              <div>
                <h3>Edit existing frame details</h3>
                <p>Descriptions and required quantities can be corrected without rewriting scan history.</p>
              </div>
              <span className="campaign-item-count">{snapshot.items.length} UPCs</span>
            </div>
            <div className="campaign-item-search">
              <Search size={18} aria-hidden="true" />
              <label className="sr-only" htmlFor="campaign-item-search">Search recall items</label>
              <input id="campaign-item-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search UPC, model, or description" />
            </div>

            <div className="campaign-existing-layout">
              <div className="campaign-existing-list" aria-label="Recall items">
                {filteredItems.length ? filteredItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`campaign-existing-row ${selectedItem?.id === item.id ? "selected" : ""}`}
                    onClick={() => chooseItem(item)}
                    aria-pressed={selectedItem?.id === item.id}
                  >
                    <span><strong>{item.barcode}</strong><small>{item.description}</small></span>
                    <span className={item.quantityFound >= item.quantityRequired ? "complete" : ""}>{item.quantityFound} / {item.quantityRequired} found</span>
                  </button>
                )) : <p className="campaign-existing-empty">No recalled frames match that search.</p>}
              </div>

              {selectedItem && editDraft ? (
                <form className="campaign-item-form campaign-existing-editor" onSubmit={(event) => void saveExisting(event)}>
                  <div className="campaign-existing-editor-heading">
                    <div><span>Editing UPC</span><strong>{selectedItem.barcode}</strong></div>
                    <span>{selectedItem.quantityFound} found · scan history locked</span>
                  </div>
                  <div className="field-grid">
                    <div className="field full"><label htmlFor="edit-frame-description">Frame description *</label><input id="edit-frame-description" value={editDraft.description} onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })} required /></div>
                    <div className="field"><label htmlFor="edit-frame-quantity">Required quantity *</label><input id="edit-frame-quantity" type="number" min="1" max="1000000" step="1" value={editDraft.quantityRequired} onChange={(event) => setEditDraft({ ...editDraft, quantityRequired: event.target.value })} required /></div>
                    <div className="field"><label htmlFor="edit-frame-brand">Brand</label><input id="edit-frame-brand" value={editDraft.brand} onChange={(event) => setEditDraft({ ...editDraft, brand: event.target.value })} /></div>
                    <div className="field"><label htmlFor="edit-frame-model">Model</label><input id="edit-frame-model" value={editDraft.model} onChange={(event) => setEditDraft({ ...editDraft, model: event.target.value })} /></div>
                    <div className="field"><label htmlFor="edit-frame-style">Style</label><input id="edit-frame-style" value={editDraft.style} onChange={(event) => setEditDraft({ ...editDraft, style: event.target.value })} /></div>
                    <div className="field"><label htmlFor="edit-frame-color">Color</label><input id="edit-frame-color" value={editDraft.color} onChange={(event) => setEditDraft({ ...editDraft, color: event.target.value })} /></div>
                    <div className="field"><label htmlFor="edit-frame-sku">SKU</label><input id="edit-frame-sku" value={editDraft.sku} onChange={(event) => setEditDraft({ ...editDraft, sku: event.target.value })} /></div>
                    <div className="field full"><label htmlFor="edit-frame-notes">Notes</label><textarea id="edit-frame-notes" value={editDraft.notes} onChange={(event) => setEditDraft({ ...editDraft, notes: event.target.value })} /></div>
                  </div>
                  <div className="notice success campaign-edit-safety"><ShieldCheck size={18} /><span>Saving will not alter the barcode, quantity found, or any scan record.</span></div>
                  <button className="primary-button" type="submit" disabled={working || !isPaused}>
                    <Save size={18} /> Save frame details
                  </button>
                </form>
              ) : (
                <div className="campaign-existing-placeholder"><PencilLine size={28} /><p>Select a recalled frame to edit its details.</p></div>
              )}
            </div>
          </section>
        ) : null}
      </div>

      <div className="drawer-actions campaign-item-manager-footer">
        <span><strong>{snapshot.summary.foundItems}</strong> of {snapshot.summary.totalItems} UPCs found</span>
        <button className="secondary-button" onClick={onClose} disabled={working}>Done</button>
      </div>
    </aside>
  );
}
