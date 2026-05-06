import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

const HaInstanceSize = z.enum(["M30", "M40", "M50", "M60", "M80", "M100", "M140", "M200", "M300", "M400", "M700"]);

export class CreateHaClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-ha-cluster";
    public description =
        "Create a high-availability multi-region MongoDB Atlas production cluster: M30 REPLICASET across AWS US_EAST_1+US_WEST_2+CA_CENTRAL_1, 5 electable nodes (2+2+1), compute and disk autoscaling, Cloud Backups with PITR, automatic regional failover.";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID."),
        name: AtlasArgs.clusterName().describe("Cluster name."),
        instanceSize: HaInstanceSize.default("M30").describe("M30 (default) is the smallest HA tier."),
    };

    protected async execute({
        projectId,
        name,
        instanceSize,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const autoScaling = {
            compute: {
                enabled: true,
                scaleDownEnabled: true,
                minInstanceSize: instanceSize,
                maxInstanceSize: maxForHa(instanceSize),
            },
            diskGB: { enabled: true },
        };

        // 2+2+1 = 5 electable nodes across 3 regions; majority quorum survives any single regional outage.
        const regionConfigs = [
            {
                providerName: "AWS",
                regionName: "US_EAST_1",
                priority: 7,
                electableSpecs: { instanceSize, nodeCount: 2 },
                autoScaling,
            },
            {
                providerName: "AWS",
                regionName: "US_WEST_2",
                priority: 6,
                electableSpecs: { instanceSize, nodeCount: 2 },
                autoScaling,
            },
            {
                providerName: "AWS",
                regionName: "CA_CENTRAL_1",
                priority: 5,
                electableSpecs: { instanceSize, nodeCount: 1 },
                autoScaling,
            },
        ];

        const body = {
            name,
            clusterType: "REPLICASET",
            backupEnabled: true,
            pitEnabled: true,
            terminationProtectionEnabled: true,
            replicationSpecs: [{ zoneName: "Zone 1", regionConfigs }],
        } as unknown as ClusterDescription20240805;

        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `HA cluster "${name}" provisioning: ${instanceSize} REPLICASET across AWS US_EAST_1 (primary), US_WEST_2, CA_CENTRAL_1, 5 electable nodes (2+2+1), Cloud Backups+PITR, autoscaling on.`,
                },
            ],
        };
    }
}

function maxForHa(size: string): string {
    const ladder = ["M30", "M40", "M50", "M60", "M80", "M100", "M140", "M200", "M300", "M400", "M700"];
    const idx = ladder.indexOf(size);
    return idx === -1 ? size : (ladder[Math.min(idx + 2, ladder.length - 1)] ?? size);
}
