# Agent runtime synchronization

Plugins can opt into committed agent runtime changes with
`resourceLifecycle: ["agent_runtime"]` and `events.subscribe`.
Implement `onResourceLifecycle` and handle `update` and `delete`.
Existing agent and project subscriptions do not receive this new resource type.

An event contains company identity, agent identity in `resourceId`, a numeric
sequence serialized as `id`, and its action. It contains no file contents,
configuration, or credentials. Treat `id` as an opaque decimal revision, not a
JavaScript floating-point value. Delivery is at least once and ordered per agent.
Return `acknowledged` only after external effects finish. Return `retry` after an
unfinished operation, or `deferred` when configuration is missing. Startup,
plugin startup, and configuration changes recover unacknowledged work.

The host records configuration changes at the database mutation boundary. This
covers API saves, rollback, plugin writes, and background writers. No-op updates
and heartbeat accounting do not create runtime work. Instruction edits, file
deletions, restores, and run writeback use the file audit boundary. Pending hires
produce no update until approval. Returning to the ready lifecycle phase requests
synchronization after preparation or resume. Existing agents receive a one-time
baseline when the migration runs. Agent deletion leaves a durable delete event.

PostgreSQL notifications wake the existing durable dispatcher only after commit,
including writes through independent clients. Notifications carry no identifiers
or contents. The journal remains authoritative. The listener scans on connection
and reconnection so a dropped notification does not lose committed work. There
is no recurring empty-inbox poll. Existing retry deadlines still retry failed work.
A process opens one listener connection only after a ready plugin opts into
`agent_runtime`. The database connection must support session-level `LISTEN`;
transaction-mode poolers are not supported for this opt-in feature. Startup waits
for listener registration. Legacy subscriptions keep process-local work signals.

A plugin that also has `agents.lifecycle.manage` can call
`ctx.agents.getRuntime(agentId, companyId)` from a company-scoped invocation.
Only the enabled, ready plugin selected in that agent's required lifecycle set
can read these inputs. The result supplies the latest runtime revision, the
normalized agent configuration, instruction root and entry filename, and that
plugin's own instance secrets. A missing or cross-company agent returns null.
The instruction root identifies host files that the trusted worker can package
through its existing filesystem access. This API grants no arbitrary path reads.
Never expose instance secrets through UI data, logs, plugin state, or agent files.

Re-read current state before external effects. A queued event can be older than
the returned revision. Fence stale revisions at the destination and use its
conditional writes. Current configuration is desired state, not a frozen run
snapshot or permission to change an active provider session. Execution admission
and provider activation keep their existing checks. The private transport consumer
is a separate integration.

Filesystem changes outside Paperclip's managed write APIs do not emit these
hooks. Filesystem publication and the database journal are not one filesystem
transaction. A failed managed write must be repaired through the same API before
claiming synchronization. Upstream repository detection remains owned by the
source integration.
