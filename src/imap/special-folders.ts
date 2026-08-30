import type { ImapFlow } from 'imapflow';

/** Trouve un dossier par son flag special-use IMAP (ex. "\\Trash", "\\Drafts"). */
export async function findSpecialFolder(client: ImapFlow, specialUse: string): Promise<string | undefined> {
  const mailboxes = await client.list();
  return mailboxes.find((mailbox) => mailbox.specialUse === specialUse)?.path;
}
