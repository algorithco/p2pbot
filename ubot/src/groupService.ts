import { Api } from 'teleproto';
import { ensureClient, withFloodWait } from './client';
import logger from './logger';
import { transferChannelOwnership, promoteToAdmin, demoteAdmin } from './channelService';

/**
 * Group takeover — supports both basic groups (Chat) and supergroups (Channel megagroup).
 * Basic groups must be migrated to supergroup before admin/creator operations.
 */

// Simple in-memory lock for migrate to avoid double-migrate race
const migrating = new Set<string>();

export async function isBasicGroup(groupId: string | number): Promise<boolean> {
  const client = await ensureClient();
  const entity = (await withFloodWait(() => client.getEntity(String(groupId)) as Promise<unknown>)) as unknown as { className: string };
  return entity.className === 'Chat';
}

export async function migrateToSupergroup(groupId: string | number): Promise<Api.Channel> {
  const key = String(groupId);
  if (migrating.has(key)) {
    // Another migrate in progress — wait and then re-fetch
    await new Promise((r) => setTimeout(r, 2000));
    const client = await ensureClient();
    const ent = (await withFloodWait(() => client.getEntity(String(groupId)) as Promise<unknown>)) as unknown as { className: string };
    if ((ent as { className: string }).className !== 'Chat') return ent as unknown as Api.Channel;
  }
  migrating.add(key);
  try {
    const client = await ensureClient();
    const entity = (await withFloodWait(() => client.getEntity(String(groupId)) as Promise<unknown>)) as unknown as Api.Chat & { id: number };
    if ((entity as unknown as { className: string }).className !== 'Chat') {
      // Already migrated
      return entity as unknown as Api.Channel;
    }
    // @ts-ignore — teleproto MigrateChat chatId expects BigInteger, runtime accepts number
    const res = (await withFloodWait(() =>
      client.invoke(
        new Api.messages.MigrateChat({
          chatId: (entity as unknown as { id: number }).id as unknown as any,
        })
      )
    )) as unknown as { updates: { chats: Api.Channel[] } };
    const migrated = res?.updates?.chats?.[0];
    if (!migrated) throw new Error('migrate_failed: Telegram did not return migrated channel (already migrated or not admin)');
    logger.info(`Migrated group ${groupId} to supergroup ${(migrated as unknown as { id: unknown }).id}`);
    return migrated;
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('CHAT_NOT_MODIFIED') || msg.includes('already a supergroup') || msg.includes('CHAT_ADMIN_REQUIRED')) {
      // Fetch again — it is already a supergroup
      const client = await ensureClient();
      const ent = (await withFloodWait(() => client.getEntity(String(groupId)) as Promise<unknown>)) as unknown as Api.Channel;
      return ent;
    }
    if (msg.includes('CHANNELS_TOO_MUCH')) {
      throw new Error('CHANNELS_TOO_MUCH: cannot migrate — too many channels/supergroups');
    }
    throw e;
  } finally {
    migrating.delete(key);
  }
}

async function ensureSupergroup(groupId: string | number): Promise<Api.Channel> {
  const client = await ensureClient();
  let entity = (await withFloodWait(() => client.getEntity(String(groupId)) as Promise<unknown>)) as unknown as Api.Chat | Api.Channel;
  if ((entity as unknown as { className: string }).className === 'Chat') {
    logger.info(`Group ${groupId} is basic Chat — migrating to supergroup`);
    entity = await migrateToSupergroup(groupId);
  }
  return entity as Api.Channel;
}

export async function promoteGroupAdmin(
  groupId: string | number,
  userId: string | number,
  rights: Parameters<typeof promoteToAdmin>[2] = {},
  rank = 'Admin'
): Promise<void> {
  if (!userId) throw new Error('userId required');
  const supergroup = await ensureSupergroup(groupId);
  await promoteToAdmin(supergroup as unknown as string, userId, rights, rank);
}

export async function transferGroupOwnership(
  groupId: string | number,
  newOwnerId: string | number,
  password?: string
): Promise<void> {
  if (!newOwnerId) throw new Error('newOwnerId required');
  const supergroup = await ensureSupergroup(groupId);
  await transferChannelOwnership(supergroup as unknown as string, newOwnerId, password);
}

export async function demoteGroupAdmin(groupId: string | number, userId: string | number): Promise<void> {
  if (!userId) throw new Error('userId required');
  const supergroup = await ensureSupergroup(groupId);
  await demoteAdmin(supergroup as unknown as string, userId);
}

export async function addGroupMember(groupId: string | number, userId: string | number): Promise<void> {
  if (!userId) throw new Error('userId required');
  const client = await ensureClient();
  const group = await ensureSupergroup(groupId);
  let user: unknown;
  try {
    user = await withFloodWait(() => client.getEntity(String(userId)) as Promise<unknown>);
  } catch (e) {
    throw new Error(`user_not_found: ${userId} — ${(e as Error).message}`);
  }
  try {
    await withFloodWait(() =>
      client.invoke(
        new Api.channels.InviteToChannel({
          channel: group as unknown as Api.InputChannel,
          users: [user as unknown as Api.InputUser],
        })
      )
    );
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('USER_ALREADY_PARTICIPANT')) {
      logger.info(`User ${userId} already participant in ${groupId}`);
      return;
    }
    if (msg.includes('USER_NOT_MUTUAL_CONTACT')) throw new Error(`user_not_mutual: ${userId} — not mutual contact or privacy restricted`);
    if (msg.includes('USER_PRIVACY_RESTRICTED')) throw new Error(`privacy_restricted: ${userId} — privacy settings block invite`);
    if (msg.includes('USERS_TOO_MUCH')) throw new Error('group_full: too many participants');
    if (msg.includes('INVITE_REQUEST_SENT')) throw new Error('invite_request_sent: join request already pending (group requires approval)');
    throw e;
  }
  logger.info(`Invited ${userId} to group ${groupId}`);
}
