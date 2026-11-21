import { useEffect, useMemo, useState } from "react";
import { changeExtension, extensions, refreshExtensionList, type ExtensionInfo } from "./api";

const LANGS: Record<string, string> = { en: "English", all: "Multi-language", multi: "Multi-language" };

function displayName(e: ExtensionInfo) {
  return e.name.replace(/^Tachiyomi:\s*/, "");
}

export function Sources() {
  const [list, setList] = useState<ExtensionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [englishOnly, setEnglishOnly] = useState(true);
  const [working, setWorking] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    extensions().then((r) => setList(r.extensions), (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load extensions."));
  }, []);

  async function act(e: ExtensionInfo, action: "install" | "update" | "uninstall") {
    setWorking((w) => ({ ...w, [e.pkgName]: action === "uninstall" ? "Removing…" : action === "update" ? "Updating…" : "Installing…" }));
    setError(null);
    try {
      const { extension } = await changeExtension(e.pkgName, action);
      setList((l) => l?.map((x) => (x.pkgName === e.pkgName ? { ...x, ...extension } : x)) ?? l);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setWorking((w) => {
        const { [e.pkgName]: _, ...rest } = w;
        return rest;
      });
    }
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      setList((await refreshExtensionList()).extensions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }

  const { installed, available } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...(list ?? [])].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    const match = (e: ExtensionInfo) =>
      (!q || displayName(e).toLowerCase().includes(q)) && (e.isInstalled || !englishOnly || e.lang in LANGS);
    return {
      installed: sorted.filter((e) => e.isInstalled && match(e)),
      available: sorted.filter((e) => !e.isInstalled && match(e)),
    };
  }, [list, filter, englishOnly]);

  function row(e: ExtensionInfo) {
    const busy = working[e.pkgName];
    return (
      <li key={e.pkgName} className="extRow">
        <div className="info">
          <strong>{displayName(e)}</strong>
          <span className="muted"> {LANGS[e.lang] ?? e.lang} · v{e.versionName}</span>
          {e.hasUpdate && <span className="tag"> update available</span>}
        </div>
        {busy ? (
          <span className="muted">{busy}</span>
        ) : e.isInstalled ? (
          <span className="extActions">
            {e.hasUpdate && (
              <button type="button" className="button small" onClick={() => act(e, "update")}>Update</button>
            )}
            <button type="button" className="button small secondary" onClick={() => act(e, "uninstall")}>Remove</button>
          </span>
        ) : (
          <button type="button" className="button small" onClick={() => act(e, "install")}>Install</button>
        )}
      </li>
    );
  }

  return (
    <section>
      <p className="muted">
        Extensions are what let Sapphire read each site. Installed ones show up in search and discovery right away.
      </p>
      <div className="searchbar">
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a site" aria-label="Find a site" />
        <button type="button" onClick={refresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh list"}</button>
      </div>
      <label className="muted">
        <input type="checkbox" checked={englishOnly} onChange={(e) => setEnglishOnly(e.target.checked)} /> English and multi-language only
      </label>
      {error && <p className="bad">{error}</p>}
      {!list && !error && <p className="muted">Loading the extension list. The first time can take a moment.</p>}
      {list && (
        <>
          <h3>Installed ({installed.length})</h3>
          {installed.length === 0 ? <p className="muted">None match.</p> : <ul className="extList">{installed.map(row)}</ul>}
          <h3>Available ({available.length})</h3>
          <ul className="extList">{available.slice(0, 100).map(row)}</ul>
          {available.length > 100 && <p className="muted">Showing 100. Type in the box to narrow the list.</p>}
        </>
      )}
    </section>
  );
}
