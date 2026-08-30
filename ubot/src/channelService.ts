import { Api } from 'telegram';
import { ensureClient, withFloodWait } from './client';
import logger from './logger';
import { config } from './config';

/**
 * Channel takeover helpers.
 * All methods assume client is connected as a user with sufficient rights.
 */

export interface AdminRights {
  changeInfo?: boolean;
  postMessages?: boolean;
  editMessages?: boolean;
  deleteMessages?: boolean;
  banUsers?: boolean;
  inviteUsers?: boolean;
  pinMessages?: boolean;
  addAdmins?: boolean;
  anonymous?: boolean;
  manageCall?: boolean;
  other?: boolean;
  manageTopics?: boolean;
}

function buildAdminRights(r: AdminRights = {}): Api.ChatAdminRights {
  return new Api.ChatAdminRights({
    changeInfo: r.changeInfo ?? true,
    postMessages: r.postMessages ?? true,
    editMessages: r.editMessages ?? true,
    deleteMessages: r.deleteMessages ?? true,
    banUsers: r.banUsers ?? true,
    inviteUsers: r.inviteUsers ?? true,
    pinMessages: r.pinMessages ?? true,
    addAdmins: r.addAdmins ?? true,
    anonymous: r.anonymous ?? false,
    manageCall: r.manageCall ?? true,
    other: r.other ?? true,
    manageTopics: r.manageTopics ?? true,
  });
}

async function resolveChannel(channel: string | number): Promise<Api.Channel | Api.Chat> {
  const client = await ensureClient();
  // Try get entity
  const entity = await client.getEntity(channel as string);
  // For channels, entity is Channel
  return entity as unknown as Api.Channel;
}

export async function getChannelInfo(channel: string | number): Promise<{ id: number; title: string; username?: string; isChannel: boolean }> {
  const ent = await resolveChannel(channel) as unknown as { id: unknown; title: string; username?: string; broadcast?: boolean; megagroup?: boolean };
  // telegram entity has .id as Api long
  return {
    id: Number((ent as { id: { toJSNumber?: () => number } }).id?.toJSNumber?.() ?? ent.id),
    title: ent.title,
    username: ent.username,
    isChannel: !!(ent as { broadcast?: boolean }).broadcast || !!(ent as { megagroup?: boolean }).megagroup,
  };
}

export async function promoteToAdmin(
  channel: string | number,
  userId: string | number,
  rights: AdminRights = {},
  rank: string = 'Admin'
): Promise<void> {
  const client = await ensureClient();
  const channelEntity = await resolveChannel(channel);
  const userEntity = await client.getEntity(userId as string);

  await withFloodWait(() =>
    client.invoke(
      new Api.channels.EditAdmin({
        channel: channelEntity as unknown as Api.InputChannel,
        userId: userEntity as unknown as Api.InputUser,
        adminRights: buildAdminRights(rights),
        rank,
      })
    )
  );
  logger.info(`Promoted ${userId} to admin in ${channel}`);
}

export async function transferChannelOwnership(
  channel: string | number,
  newOwnerUserId: string | number,
  password?: string
): Promise<void> {
  const pwd = password || config.twoFaPassword;
  if (!pwd) throw new Error('2FA password required for ownership transfer (TWO_FA_PASSWORD or per-request password)');

  const client = await ensureClient();
  const channelEntity = await resolveChannel(channel);
  const newOwnerEntity = await client.getEntity(newOwnerUserId as string);

  // Need to compute password check via account.getPassword
  const { Api: Api2 } = await import('telegram');
  // GramJS: to transfer ownership we need to use channels.editCreator
  // It requires password's SRP check: we can use client.invoke with account.getPassword then compute check via password helper
  // Simplified: let GramJS handle password via utils? We attempt direct invoke with password string if library supports it.
  // Fallback: use raw call and let library auto-handle SRP if we pass password via helper.

  // Attempt 1: use account.getPassword and then use password helper
  try {
    const passwordInfo = await client.invoke(new Api2.account.GetPassword());
    // Use internal helper from telegram's password utils if available
    // We try to compute check via @telegram's computeCheck if exists
    let check: unknown = null;
    try {
      const { computeCheck } = await import('telegram/Password');
      // @ts-ignore — computeCheck signature: (pwd, password) => Promise<...>
      check = await (computeCheck as unknown as (pwd: unknown, pw: string) => Promise<unknown>)(passwordInfo, pwd);
    } catch {
      // Fallback: pass password directly if computeCheck not available (some GramJS versions do it internally)
      check = null;
    }

    const inputUser = newOwnerEntity as unknown as Api.InputUser;
    // Build EditCreator request
    if (check) {
      await withFloodWait(() =>
        client.invoke(
          new Api2.channels.EditCreator({
            channel: channelEntity as unknown as Api.InputChannel,
            userId: inputUser as unknown as Api.InputUser,
            password: check as unknown as Api.InputCheckPasswordSRP,
          })
        )
      );
    } else {
      // Try without explicit password check — some forks accept password param as string (will fail with PASSWORD_HASH_INVALID if wrong)
      await withFloodWait(() =>
        client.invoke(
          new Api.channels.EditCreator({
            channel: channelEntity as unknown as Api.InputChannel,
            userId: inputUser as unknown as Api.InputUser,
            // @ts-ignore — older typings expect InputCheckPasswordSRP
            password: pwd as unknown as Api.InputCheckPasswordSRP,
          })
        )
      );
    }
    logger.info(`Transferred ownership of ${channel} to ${newOwnerUserId}`);
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('2FA')) {
      throw new Error(`2FA password invalid for ownership transfer: ${msg}`);
    }
    if (msg.includes('CHAT_ADMIN_REQUIRED') || msg.includes('CHANNEL_PRIVATE')) {
      throw new Error(`Not admin/creator of channel ${channel}: ${msg}`);
    }
    if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
      throw new Error('Ownership transfer forbidden — account too new or recent admin changes (Telegram anti-abuse)');
    }
    throw e;
  }
}

export async function demoteAdmin(channel: string | number, userId: string | number): Promise<void> {
  const client = await ensureClient();
  const channelEntity = await resolveChannel(channel);
  const userEntity = await client.getEntity(userId as string);
  await withFloodWait(() =>
    client.invoke(
      new Api.channels.EditAdmin({
        channel: channelEntity as unknown as Api.InputChannel,
        userId: userEntity as unknown as Api.InputUser,
        adminRights: new Api.ChatAdminRights({
          changeInfo: false,
          postMessages: false,
          editMessages: false,
          deleteMessages: false,
          banUsers: false,
          inviteUsers: false,
          pinMessages: false,
          addAdmins: false,
          anonymous: false,
          manageCall: false,
          other: false,
          manageTopics: false,
        }),
        rank: '',
      })
    )
  );
  logger.info(`Demoted ${userId} in ${channel}`);
}

export async function listChannelAdmins(channel: string | number): Promise<Array<{ id: number; isCreator: boolean }>> {
  const client = await ensureClient();
  const channelEntity = await resolveChannel(channel);
  const res = await withFloodWait(() =>
    client.invoke(
      new Api.channels.GetParticipants({
        channel: channelEntity as unknown as Api.InputChannel,
        filter: new Api.ChannelParticipantsAdmins(),
        offset: 0,
        limit: 100,
        hash: BigInt(0) as unknown as any,
      })
    )
  ) as unknown as { participants: Array<{ userId: unknown; participant: { className: string } }> };
  return res.participants.map((p) => ({
    id: Number((p.userId as unknown as { toJSNumber?: () => number })?.toJSNumber?.() ?? p.userId),
    isCreator: p.participant.className === 'ChannelParticipantCreator',
  }));
}
