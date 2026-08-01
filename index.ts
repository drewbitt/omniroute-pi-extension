import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  envApiKeyAuth,
  openAIResponsesApi,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";
import { fetchCatalogs, readConfig } from "./src/gateway-catalog.ts";
import { normalizeModels } from "./src/model-normalizer.ts";

const PROVIDER = "omniroute";
const PROVIDER_DISPLAY_NAME = "OmniRoute";
const PROVIDER_AUTH_NAME = "OmniRoute API key";
const PROVIDER_AUTH_ENV = [
  "OMNIROUTE_API_KEY",
] as const;
const PROVIDER_MODELS = [] as const;
const PROVIDER_API = openAIResponsesApi;

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  if (!config) return;

  const fetchModels = async (context: RefreshModelsContext) => {
    const snapshot = await fetchCatalogs(config, context);
    return normalizeModels(PROVIDER, config.baseUrl, snapshot);
  };

  const provider = createProvider({
    id: PROVIDER,
    name: PROVIDER_DISPLAY_NAME,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(PROVIDER_AUTH_NAME, PROVIDER_AUTH_ENV) },
    models: PROVIDER_MODELS,
    api: PROVIDER_API(),
    fetchModels,
  });

  pi.registerProvider(provider);
}
