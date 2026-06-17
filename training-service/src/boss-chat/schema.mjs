export function ensureBossChatTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boss_chat_sessions (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      title TEXT,
      preview TEXT,
      status TEXT,
      createdAt TEXT,
      updatedAt TEXT,
      lastMessageAt TEXT,
      deletedAt TEXT,
      messageCount INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_boss_chat_sessions_account ON boss_chat_sessions(accountId, updatedAt);
    CREATE INDEX IF NOT EXISTS idx_boss_chat_sessions_status ON boss_chat_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_boss_chat_sessions_deleted ON boss_chat_sessions(deletedAt);

    CREATE TABLE IF NOT EXISTS boss_chat_messages (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      accountId TEXT NOT NULL,
      role TEXT NOT NULL,
      action TEXT,
      createdAt TEXT,
      rowOrder INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_boss_chat_messages_session ON boss_chat_messages(sessionId, rowOrder);
    CREATE INDEX IF NOT EXISTS idx_boss_chat_messages_created ON boss_chat_messages(createdAt);
    CREATE INDEX IF NOT EXISTS idx_boss_chat_messages_action ON boss_chat_messages(action);
  `);
}
