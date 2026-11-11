/**
 * Environnement de test. À importer EN PREMIER dans tout fichier de test qui
 * charge (directement ou non) `src/config.ts` : les modules ESM sont évalués
 * dans l'ordre des imports, donc ces valeurs sont posées avant que la config
 * ne soit validée.
 *
 * `dotenv` n'écrase jamais une variable déjà définie : un `.env` réel présent
 * sur la machine ne peut donc pas fuiter dans les tests.
 */
process.env.MAIL_EMAIL = 'test@example.com';
process.env.MAIL_PASSWORD = 'test-app-password';
process.env.MAIL_IMAP_HOST = 'imap.example.com';
process.env.MAIL_SMTP_HOST = 'smtp.example.com';
process.env.MCP_BEARER_TOKEN = 'test-bearer-token-0123456789abcdef';
process.env.LOG_LEVEL = 'fatal';
process.env.ENABLE_SENDING = 'false';
process.env.UNRESTRICTED = 'false';
process.env.DRAFTS_ONLY = 'false';
