export function ensureAgentRunTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      sessionId TEXT,
      transport TEXT,
      route TEXT,
      messageHash TEXT,
      messagePreview TEXT,
      status TEXT,
      intent TEXT,
      skill TEXT,
      action TEXT,
      confirmedSkill TEXT,
      hasError INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT,
      finishedAt TEXT,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_skill ON agent_runs(skill);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_action ON agent_runs(action);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_transport ON agent_runs(transport);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_has_error ON agent_runs(hasError);

    CREATE TABLE IF NOT EXISTS agent_steps (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      stepOrder INTEGER NOT NULL DEFAULT 0,
      type TEXT,
      name TEXT,
      status TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      latencyMs INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(runId, stepOrder);
    CREATE INDEX IF NOT EXISTS idx_agent_steps_type ON agent_steps(type);
    CREATE INDEX IF NOT EXISTS idx_agent_steps_status ON agent_steps(status);
  `);
}
