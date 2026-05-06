import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

const DedicatedInstanceSize = z.enum([
    "M10",
    "M20",
    "M30",
    "M40",
    "M50",
    "M60",
    "M80",
    "M100",
    "M140",
    "M200",
    "M300",
    "M400",
    "M700",
    "M40_NVME",
    "M50_NVME",
    "M60_NVME",
    "M80_NVME",
    "M200_NVME",
    "M400_NVME",
]);

const CloudProvider = z.enum(["AWS", "AZURE", "GCP"]);

const RegionConfigArg = z.object({
    regionName: AtlasArgs.region().describe("Cloud region (e.g. US_EAST_1, EU_WEST_1, US_WEST_2)"),
    nodeCount: z
        .number()
        .int()
        .min(0)
        .max(50)
        .default(3)
        .describe(
            "Number of electable nodes in this region. Must be 0 or an odd number across regions for replica sets, and the cluster needs at least 3 electable nodes total."
        ),
    priority: z
        .number()
        .int()
        .min(0)
        .max(7)
        .optional()
        .describe(
            "Election priority for this region (0 to 7). The preferred primary region must be 7. If omitted, regions are auto-prioritized in input order starting from 7."
        ),
    providerName: CloudProvider.default("AWS").describe("Cloud provider for this region"),
});

export class CreateReplicaSetClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-replica-set-cluster";
    public description =
        "Create a paid (dedicated tier) MongoDB Atlas replica set cluster. Supports single-region and multi-region deployments, compute and disk autoscaling, and optional cloud backups.";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID where the cluster will be created"),
        name: AtlasArgs.clusterName().describe("Name of the cluster"),
        instanceSize: DedicatedInstanceSize.default("M10").describe(
            "Cluster instance size applied to every region. Use M10 or M20 for development, M30+ for production workloads."
        ),
        regions: z
            .array(RegionConfigArg)
            .min(1)
            .max(8)
            .default([{ regionName: "US_EAST_1", nodeCount: 3, providerName: "AWS" }])
            .describe(
                "List of region configurations. Provide a single entry for a single-region cluster, or up to eight entries for a multi-region cluster. Total electable nodes across regions must be at least 3."
            ),
        backupEnabled: z
            .boolean()
            .default(false)
            .describe("Whether to enable Cloud Backups. Required for production workloads."),
        autoScalingComputeEnabled: z
            .boolean()
            .default(true)
            .describe("Whether compute autoscaling is enabled (recommended)"),
        autoScalingComputeScaleDownEnabled: z
            .boolean()
            .default(true)
            .describe("Whether compute autoscaling can scale the instance size down (in addition to up)"),
        autoScalingMinInstanceSize: DedicatedInstanceSize.optional().describe(
            "Lower bound for compute autoscaling. Required when autoScalingComputeScaleDownEnabled is true. Defaults to instanceSize."
        ),
        autoScalingMaxInstanceSize: DedicatedInstanceSize.optional().describe(
            "Upper bound for compute autoscaling. Required when autoScalingComputeEnabled is true. Defaults to two tiers above instanceSize."
        ),
        autoScalingDiskEnabled: z.boolean().default(true).describe("Whether disk autoscaling is enabled (recommended)"),
        terminationProtectionEnabled: z
            .boolean()
            .default(false)
            .describe("If true, the cluster cannot be deleted until termination protection is disabled."),
    };

    protected async execute({
        projectId,
        name,
        instanceSize,
        regions,
        backupEnabled,
        autoScalingComputeEnabled,
        autoScalingComputeScaleDownEnabled,
        autoScalingMinInstanceSize,
        autoScalingMaxInstanceSize,
        autoScalingDiskEnabled,
        terminationProtectionEnabled,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const totalElectable = regions.reduce((sum, r) => sum + r.nodeCount, 0);
        if (totalElectable < 3) {
            throw new Error(
                `Replica sets require at least 3 electable nodes across all regions (got ${totalElectable}).`
            );
        }

        // Atlas rejects compute.scaleDownEnabled when compute.enabled is false, so tie scale-down to enabled.
        const computeEnabled = autoScalingComputeEnabled;
        const scaleDownEnabled = computeEnabled && autoScalingComputeScaleDownEnabled;
        const minInstanceSize = autoScalingMinInstanceSize ?? instanceSize;
        const maxInstanceSize = autoScalingMaxInstanceSize ?? defaultMaxInstanceSize(instanceSize);

        const autoScaling = {
            compute: {
                enabled: computeEnabled,
                scaleDownEnabled,
                ...(computeEnabled ? { maxInstanceSize } : {}),
                ...(scaleDownEnabled ? { minInstanceSize } : {}),
            },
            diskGB: { enabled: autoScalingDiskEnabled },
        };

        const regionConfigs = regions.map((region, index) => ({
            providerName: region.providerName,
            regionName: region.regionName,
            priority: region.priority ?? Math.max(7 - index, 0),
            electableSpecs: { instanceSize, nodeCount: region.nodeCount },
            autoScaling,
        }));

        const body = {
            name,
            clusterType: "REPLICASET",
            backupEnabled,
            terminationProtectionEnabled,
            replicationSpecs: [
                {
                    zoneName: "Zone 1",
                    regionConfigs,
                },
            ],
        } as unknown as ClusterDescription20240805;

        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body,
        });

        const summary =
            regions.length === 1
                ? `single-region (${regions[0]?.regionName}) ${instanceSize} replica set`
                : `multi-region (${regions.map((r) => r.regionName).join(", ")}) ${instanceSize} replica set`;

        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${name}" provisioning started: ${summary}. Backup ${backupEnabled ? "enabled" : "disabled"}, compute autoscaling ${autoScalingComputeEnabled ? "enabled" : "disabled"}, disk autoscaling ${autoScalingDiskEnabled ? "enabled" : "disabled"}.`,
                },
                {
                    type: "text",
                    text: "The cluster will reach state IDLE in a few minutes. Use atlas-inspect-cluster to poll its state.",
                },
            ],
        };
    }
}

const SIZE_LADDER = ["M10", "M20", "M30", "M40", "M50", "M60", "M80", "M100", "M140", "M200", "M300", "M400", "M700"];

function defaultMaxInstanceSize(current: string): string {
    if (current.endsWith("_NVME")) {
        return current;
    }
    const idx = SIZE_LADDER.indexOf(current);
    if (idx === -1) {
        return current;
    }
    return SIZE_LADDER[Math.min(idx + 2, SIZE_LADDER.length - 1)] ?? current;
}
