import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getCredentials } from "./auth.ts";
import { API_ID, PROVIDER_ID, runtimeEndpoint } from "./constants.ts";
import { loadCatalog, toProviderModel } from "./models.ts";
import { streamKiro } from "./stream.ts";
import { kiroUsageProvider } from "./usage.ts";

export default function kiroProvider(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: runtimeEndpoint("us-east-1"),
		// Credentials live in kiro-cli's own store and are read per request, so OMP holds no
		// secret. OMP still needs a non-empty key to treat the provider as available; the
		// hyphen keeps it from ever being looked up as an environment variable.
		apiKey: "kiro-cli",
		api: API_ID,
		streamSimple: streamKiro,
		usage: kiroUsageProvider,
		fetchDynamicModels: async () => {
			await getCredentials();
			const catalog = await loadCatalog(true);
			return [...catalog.values()].map(toProviderModel);
		},
	});
}
