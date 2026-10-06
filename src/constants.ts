import pkg from "../package.json" with { type: "json" };

export const PROVIDER_ID = "kiro";
export const API_ID = "kiro-generate-assistant-response";
/** kiro-cli's own origin; the model list and chat endpoint accept it for CLI logins. */
export const ORIGIN = "KIRO_CLI";

// Names this plugin truthfully while keeping the AWS SDK shape the service expects.
export const USER_AGENT = `aws-sdk-js/3.738.0 ua/2.1 os/${process.platform} lang/js md/bun#${Bun.version} api/codewhispererstreaming#3.738.0 m/E omp-kiro/${pkg.version}`;
export const AMZ_USER_AGENT = `aws-sdk-js/3.738.0 omp-kiro/${pkg.version}`;

export function runtimeEndpoint(region: string): string {
	return `https://runtime.${region}.kiro.dev`;
}

export function managementEndpoint(region: string): string {
	return `https://management.${region}.kiro.dev`;
}
