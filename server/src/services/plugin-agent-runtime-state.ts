import { and, desc, eq } from "drizzle-orm";
import { agents, plugins, pluginCompanySettings, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import type { PluginAgentRuntimeState } from "@paperclipai/plugin-sdk";
import { agentRecordQueries } from "../lib/agent-records.js";
import { forbidden } from "../errors.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { agentInstanceSecretService } from "./agent-instance-secrets.js";

export async function pluginAgentRuntimeState(db: Db, pluginId: string, companyId: string, agentId: string): Promise<PluginAgentRuntimeState | null> {
  return db.transaction(async tx => {
    const [agent] = await tx.select().from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("share");
    if (!agent) return null;
    const [plugin] = await tx.select().from(plugins).where(eq(plugins.id, pluginId));
    const [settings] = await tx.select().from(pluginCompanySettings).where(and(eq(pluginCompanySettings.companyId, companyId), eq(pluginCompanySettings.pluginId, pluginId)));
    if (plugin?.status !== "ready" || settings?.enabled === false || !plugin?.manifestJson.capabilities?.includes("agents.lifecycle.manage")
      || !plugin.manifestJson.resourceLifecycle?.includes("agent_runtime") || !agent.lifecycleRequiredPluginIds?.includes(pluginId)) {
      throw forbidden("Agent runtime state requires the owning lifecycle plugin");
    }
    const [latest] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
      .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, agentId)))
      .orderBy(desc(resourceLifecycleEvents.id)).limit(1);
    const instructions = await agentInstructionsService().getBundle(agent);
    return {
      revision: String(latest?.id ?? 0), agent: agentRecordQueries(tx as unknown as Db).normalizeAgentRow(agent) as PluginAgentRuntimeState["agent"],
      instructionsRootPath: instructions.rootPath, instructionsEntryFile: instructions.entryFile,
      instanceSecrets: await agentInstanceSecretService(tx as unknown as Db).read({ companyId, agentId, pluginId }),
    };
  });
}
