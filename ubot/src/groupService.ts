import { Api } from 'telegram';
import { ensureClient, withFloodWait } from './client';
import logger from './logger';
import { transferChannelOwnership, promoteToAdmin, demoteAdmin } from './channelService';

/**
 * Group takeover — supports both basic groups (Chat) and supergroups (Channel megagroup).
 * Basic groups must be migrated to supergroup before admin/creator operations.
 */

export async function isBasicGroup(groupId: string | number): Promise<boolean> {
  const client = await ensureClient();
  const entity = await client.getEntity(groupId as string) as unknown as { className: string };
  return entity.className === 'Chat';
}

export async function migrateToSupergroup(groupId: string | number): Promise<Api.Channel> {
  const client = await ensureClient();
  const entity = await client.getEntity(groupId as string) as unknown as Api.Chat;
  // GramJS: messages.migrateChat migrates basic group to channel
  const res = await withFloodWait(() =>
    client.invoke(
      new Api.messages.MigrateChat({
        chatId: (entity as unknown as { id: number }).id as unknown as any,
      })
    )
  ) as unknown as { updates: { chats: Api.Channel[] } };
  const migrated = res.updates.chats[0];
  logger.info(`Migrated group ${groupId} to supergroup ${migrated.id}`);
  return migrated;
}

async function ensureSupergroup(groupId: string | number): Promise<Api.Channel> {
  const client = await ensureClient();
  let entity = await client.getEntity(groupId as string) as unknown as Api.Chat | Api.Channel;
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
  const supergroup = await ensureSupergroup(groupId);
  await promoteToAdmin(supergroup as unknown as string, userId, rights, rank);
}

export async function transferGroupOwnership(
  groupId: string | number,
  newOwnerId: string | number,
  password?: string
): Promise<void> {
  const supergroup = await ensureSupergroup(groupId);
  // Supergroup ownership uses same channels.editCreator
  await transferChannelOwnership(supergroup as unknown as string, newOwnerId, password);
}

export async function demoteGroupAdmin(groupId: string | number, userId: string | number): Promise<void> {
  const supergroup = await ensureSupergroup(groupId);
  await demoteAdmin(supergroup as unknown as string, userId);
}

export async function addGroupMember(groupId: string | number, userId: string | number): Promise<void> {
  const client = await ensureClient();
  const group = await ensureSupergroup(groupId);
  const user = await client.getEntity(userId as string);
  await withFloodWait(() =>
    client.invoke(
      new Api.channels.InviteToChannel({
        channel: group as unknown as Api.InputChannel,
        users: [user as unknown as Api.InputUser],
      })
    )
  );
  logger.info(`Invited ${userId} to group ${groupId}`);
}
