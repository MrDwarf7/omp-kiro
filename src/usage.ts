import type { UsageLimit, UsageProvider, UsageReport, UsageUnit } from "@oh-my-pi/pi-ai";
import { getCredentials, kiroHeaders } from "./auth.ts";
import { managementEndpoint, ORIGIN, PROVIDER_ID } from "./constants.ts";
import { isRecord, numberField, stringField } from "./guards.ts";

const UNIT_BY_RESOURCE: Record<string, UsageUnit> = { CREDIT: "credits" };

/** Seconds-since-epoch from the service, as milliseconds. */
function resetTime(record: Record<string, unknown>): number | undefined {
	const seconds = numberField(record, "nextDateReset");
	return seconds === undefined ? undefined : seconds * 1000;
}

export function mapUsageLimits(body: unknown, fetchedAt: number): UsageReport | null {
	if (!isRecord(body) || !Array.isArray(body.usageBreakdownList)) return null;
	const subscription = isRecord(body.subscriptionInfo) ? body.subscriptionInfo : {};
	const tier = stringField(subscription, "subscriptionTitle");
	const overageStatus = isRecord(body.overageConfiguration)
		? stringField(body.overageConfiguration, "overageStatus")
		: undefined;
	const limits: UsageLimit[] = [];
	for (const entry of body.usageBreakdownList) {
		if (!isRecord(entry)) continue;
		const resourceType = stringField(entry, "resourceType") ?? "USAGE";
		// The integer fields round down; the precision fields carry fractional credits.
		const used = numberField(entry, "currentUsageWithPrecision") ?? numberField(entry, "currentUsage");
		const limit = numberField(entry, "usageLimitWithPrecision") ?? numberField(entry, "usageLimit");
		const overages = numberField(entry, "currentOveragesWithPrecision") ?? numberField(entry, "currentOverages");
		const charges = numberField(entry, "overageCharges");
		const resetsAt = resetTime(entry) ?? resetTime(body);
		const label = stringField(entry, "displayNamePlural", "displayName") ?? resourceType;
		const notes =
			overages !== undefined && overages > 0
				? [`Overage: ${overages} ${label.toLowerCase()}${charges ? ` (${charges} ${stringField(entry, "currency") ?? ""})`.trimEnd() : ""}`]
				: undefined;
		limits.push({
			id: `kiro-${resourceType.toLowerCase()}`,
			label,
			scope: { provider: PROVIDER_ID, windowId: "monthly", ...(tier ? { tier } : {}) },
			window: { id: "monthly", label: "Monthly", ...(resetsAt ? { resetsAt } : {}) },
			amount: {
				...(used !== undefined ? { used } : {}),
				...(limit !== undefined ? { limit } : {}),
				...(used !== undefined && limit ? { usedFraction: used / limit } : {}),
				unit: UNIT_BY_RESOURCE[resourceType] ?? "unknown",
			},
			...(used !== undefined && limit !== undefined && used >= limit && overageStatus !== "ENABLED"
				? { status: "exhausted" as const }
				: {}),
			...(notes ? { notes } : {}),
		});
	}
	if (limits.length === 0) return null;
	return {
		provider: PROVIDER_ID,
		fetchedAt,
		limits,
		...(overageStatus ? { notes: [`Overage billing ${overageStatus.toLowerCase()}`] } : {}),
		...(tier ? { metadata: { planType: tier } } : {}),
	};
}

/**
 * Reports the plan's monthly credit usage from Kiro's control plane. The credential OMP passes
 * is the placeholder key, so the real login is read from kiro-cli like every other request.
 */
export const kiroUsageProvider: UsageProvider = {
	id: PROVIDER_ID,
	cacheVersion: 1,
	validatesCredentials: true,
	async fetchUsage(params, ctx) {
		const creds = await getCredentials();
		const url = new URL("/GetUsageLimits", managementEndpoint(creds.serviceRegion));
		url.searchParams.set("origin", ORIGIN);
		if (creds.profileArn) url.searchParams.set("profileArn", creds.profileArn);
		const response = await ctx.fetch(url, {
			headers: { ...kiroHeaders(creds), Accept: "application/json" },
			signal: params.signal ?? AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			ctx.logger?.warn("Kiro GetUsageLimits failed", { status: response.status });
			return null;
		}
		return mapUsageLimits(await response.json(), Date.now());
	},
};
