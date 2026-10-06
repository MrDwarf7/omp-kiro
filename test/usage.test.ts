import { describe, expect, test } from "bun:test";
import { mapUsageLimits } from "../src/usage.ts";

// Shape captured from Kiro's GetUsageLimits for a KIRO POWER plan.
function response(usage: number, overageStatus: string, overages = 0) {
	return {
		nextDateReset: 1.7934912e9,
		overageConfiguration: { overageStatus },
		subscriptionInfo: { subscriptionTitle: "KIRO POWER" },
		usageBreakdownList: [
			{
				currentUsage: Math.floor(usage),
				currentUsageWithPrecision: usage,
				usageLimit: 10000,
				usageLimitWithPrecision: 10000,
				currentOverages: overages,
				currentOveragesWithPrecision: overages,
				overageCharges: overages * 0.04,
				currency: "USD",
				displayName: "Credit",
				displayNamePlural: "Credits",
				nextDateReset: 1.7934912e9,
				resourceType: "CREDIT",
			},
		],
	};
}

describe("mapUsageLimits", () => {
	test("reports fractional credits against the monthly limit with the reset time in ms", () => {
		const report = mapUsageLimits(response(0.67, "DISABLED"), 1);
		const limit = report?.limits[0];
		expect(limit?.amount).toEqual({ used: 0.67, limit: 10000, usedFraction: 0.000067, unit: "credits" });
		expect(limit?.window?.resetsAt).toBe(1_793_491_200_000);
		expect(limit?.scope.tier).toBe("KIRO POWER");
		expect(limit?.status).toBeUndefined();
	});

	test("a spent allowance is exhausted only when overage billing is off", () => {
		expect(mapUsageLimits(response(10000, "DISABLED"), 1)?.limits[0]?.status).toBe("exhausted");
		expect(mapUsageLimits(response(10000, "ENABLED", 12), 1)?.limits[0]?.status).toBeUndefined();
	});

	test("overage usage is surfaced as a note", () => {
		expect(mapUsageLimits(response(10000, "ENABLED", 12), 1)?.limits[0]?.notes).toEqual(["Overage: 12 credits (0.48 USD)"]);
	});

	test("bodies without a breakdown produce no report", () => {
		expect(mapUsageLimits({ usageBreakdownList: [] }, 1)).toBeNull();
		expect(mapUsageLimits("nope", 1)).toBeNull();
	});
});
