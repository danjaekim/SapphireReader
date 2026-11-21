import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";
import { clearFilterCache } from "./browse.js";

type FetchLike = typeof fetch;

export interface ExtensionInfo {
  pkgName: string;
  apkName: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
  isObsolete: boolean;
}

const FIELDS = "pkgName apkName name lang versionName isInstalled hasUpdate isObsolete";

export async function listExtensions(config: Config, fetchImpl?: FetchLike): Promise<ExtensionInfo[]> {
  const data = await engineQuery<{ extensions: { nodes: ExtensionInfo[] } }>(
    config,
    `{ extensions { nodes { ${FIELDS} } } }`,
    {},
    { fetchImpl },
  );
  return data.extensions.nodes.filter((e) => !e.isObsolete || e.isInstalled);
}

/** Asks the engine to re-download the extension list from the Keiyoushi repository. */
export async function refreshExtensions(config: Config, fetchImpl?: FetchLike): Promise<ExtensionInfo[]> {
  const data = await engineQuery<{ fetchExtensions: { extensions: ExtensionInfo[] } }>(
    config,
    `mutation { fetchExtensions(input: {}) { extensions { ${FIELDS} } } }`,
    {},
    { fetchImpl, timeoutMs: 60000 },
  );
  return data.fetchExtensions.extensions.filter((e) => !e.isObsolete || e.isInstalled);
}

export type ExtensionAction = "install" | "update" | "uninstall";

export async function changeExtension(
  config: Config,
  pkgName: string,
  action: ExtensionAction,
  fetchImpl?: FetchLike,
): Promise<ExtensionInfo> {
  const data = await engineQuery<{ updateExtension: { extension: ExtensionInfo } }>(
    config,
    `mutation ($input: UpdateExtensionInput!) { updateExtension(input: $input) { extension { ${FIELDS} } } }`,
    { input: { id: pkgName, patch: { [action]: true } } },
    { fetchImpl, timeoutMs: 120000 },
  );
  clearFilterCache(); // installed sources change what filters exist
  return data.updateExtension.extension;
}
