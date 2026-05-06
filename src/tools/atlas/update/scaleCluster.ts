import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
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

interface NodeSpec {
    instanceSize?: string;
    nodeCount?: number;
    diskSizeGB?: number;
    diskIOPS?: number;
    ebsVolumeType?: string;
}

interface ComputeAutoScaling {
    enabled?: boolean;
    scaleDownEnabled?: boolean;
    minInstanceSize?: string;
    maxInstanceSize?: string;
}

interface RegionConfig {
    providerName?: string;
    backingProviderName?: string;
    regionName?: string;
    priority?: number;
    electableSpecs?: NodeSpec;
    readOnlySpecs?: NodeSpec;
    analyticsSpecs?: NodeSpec;
    autoScaling?: {
        compute?: ComputeAutoScaling;
        diskGB?: { enabled?: boolean };
    };
    analyticsAutoScaling?: {
        compute?: ComputeAutoScaling;
        diskGB?: { enabled?: boolean };
    };
}

interface ReplicationSpec {
    zoneName?: string;
    regionConfigs?: RegionConfig[];
}

export class ScaleClusterTool extends AtlasToolBase {
    static toolName = "atlas-scale-cluster";
    public description =
        "Scale a MongoDB Atlas cluster up or down by changing its instance size, and optionally adjust compute autoscaling bounds. Applies the same instance size to every region in the cluster.";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID containing the cluster"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to scale"),
        instanceSize: DedicatedInstanceSize.describe("Target instance size to apply to every region"),
        autoScalingMinInstanceSize: DedicatedInstanceSize.optional().describe(
            "If provided, set the lower bound of compute autoscaling to this size. Set min and max equal to the target to lock the cluster at that tier."
        ),
        autoScalingMaxInstanceSize: DedicatedInstanceSize.optional().describe(
            "If provided, set the upper bound of compute autoscaling to this size."
        ),
    };

    protected async execute({
        projectId,
        clusterName,
        instanceSize,
        autoScalingMinInstanceSize,
        autoScalingMaxInstanceSize,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const current = await this.apiClient.getCluster({
            params: { path: { groupId: projectId, clusterName } },
        });

        if (!current.replicationSpecs?.length) {
            throw new Error(`Cluster "${clusterName}" has no replicationSpecs to update.`);
        }

        const sourceSpecs = current.replicationSpecs as unknown as ReplicationSpec[];
        const updatedReplicationSpecs = sourceSpecs.map((spec) =>
            buildMutableSpec(spec, instanceSize, autoScalingMinInstanceSize, autoScalingMaxInstanceSize)
        );

        await this.apiClient.updateCluster({
            params: { path: { groupId: projectId, clusterName } },
            body: { replicationSpecs: updatedReplicationSpecs } as unknown as ClusterDescription20240805,
        });

        const boundsMessage =
            autoScalingMinInstanceSize || autoScalingMaxInstanceSize
                ? ` Autoscaling bounds set to [${autoScalingMinInstanceSize ?? "unchanged"}, ${autoScalingMaxInstanceSize ?? "unchanged"}].`
                : "";

        return {
            content: [
                {
                    type: "text",
                    text: `Cluster "${clusterName}" scale to ${instanceSize} requested.${boundsMessage}`,
                },
            ],
        };
    }
}

// Picks only the mutable fields Atlas accepts in a PATCH replicationSpec.
// Read-only fields like id and zoneId from the GET response are intentionally dropped.
function buildMutableSpec(
    spec: ReplicationSpec,
    instanceSize: string,
    minInstanceSize: string | undefined,
    maxInstanceSize: string | undefined
): ReplicationSpec {
    return {
        ...(spec.zoneName !== undefined ? { zoneName: spec.zoneName } : {}),
        regionConfigs: (spec.regionConfigs ?? []).map((region) =>
            buildMutableRegion(region, instanceSize, minInstanceSize, maxInstanceSize)
        ),
    };
}

function buildMutableRegion(
    region: RegionConfig,
    instanceSize: string,
    minInstanceSize: string | undefined,
    maxInstanceSize: string | undefined
): RegionConfig {
    const next: RegionConfig = {};
    if (region.providerName !== undefined) next.providerName = region.providerName;
    if (region.backingProviderName !== undefined) next.backingProviderName = region.backingProviderName;
    if (region.regionName !== undefined) next.regionName = region.regionName;
    if (region.priority !== undefined) next.priority = region.priority;

    if (region.electableSpecs) next.electableSpecs = { ...region.electableSpecs, instanceSize };
    if (region.readOnlySpecs) next.readOnlySpecs = { ...region.readOnlySpecs, instanceSize };
    if (region.analyticsSpecs) next.analyticsSpecs = { ...region.analyticsSpecs, instanceSize };

    if (region.autoScaling) {
        next.autoScaling = mergeAutoScalingBounds(region.autoScaling, minInstanceSize, maxInstanceSize);
    }
    if (region.analyticsAutoScaling) {
        next.analyticsAutoScaling = mergeAutoScalingBounds(
            region.analyticsAutoScaling,
            minInstanceSize,
            maxInstanceSize
        );
    }

    return next;
}

function mergeAutoScalingBounds(
    autoScaling: NonNullable<RegionConfig["autoScaling"]>,
    minInstanceSize: string | undefined,
    maxInstanceSize: string | undefined
): NonNullable<RegionConfig["autoScaling"]> {
    const compute = autoScaling.compute ?? {};
    const next: NonNullable<RegionConfig["autoScaling"]> = {};

    if (autoScaling.diskGB) next.diskGB = { ...autoScaling.diskGB };

    if (compute.enabled !== undefined || minInstanceSize || maxInstanceSize) {
        next.compute = {
            ...compute,
            ...(minInstanceSize ? { minInstanceSize } : {}),
            ...(maxInstanceSize ? { maxInstanceSize } : {}),
        };
    }

    return next;
}
