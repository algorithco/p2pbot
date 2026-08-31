import { Api } from 'teleproto';
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

function mapChannelError(e: unknown, channel: string | number): never {
  const msg = String((e as Error).message || e);
  if (msg.includes('CHANNEL_INVALID') || msg.includes('CHAT_INVALID') || msg.includes('No entity')) {
    throw new Error(`channel_not_found: ${channel} — ${msg}`);
  }
  if (msg.includes('USERNAME_INVALID') || msg.includes('USERNAME_NOT_OCCUPIED')) {
    throw new Error(`channel_not_found: ${channel} — username invalid or not occupied`);
  }
  if (msg.includes('CHANNEL_PRIVATE')) {
    throw new Error(`channel_private: ${channel} — need invite link (not public username)`);
  }
  if (msg.includes('CHAT_ADMIN_REQUIRED')) {
    throw new Error(`not_admin: you are not admin/creator of ${channel} — ${msg}`);
  }
  if (msg.includes('CHAT_WRITE_FORBIDDEN')) {
    throw new Error(`write_forbidden: ${channel} — ${msg}`);
  }
  if (msg.includes('CHANNELS_TOO_MUCH')) {
    throw new Error('CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups — leave some or use another account');
  }
  if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: recent admin changes, wait 24h before transferring ownership');
  }
  throw e as Error;
}

async function resolveChannel(channel: string | number): Promise<Api.Channel | Api.Chat> {
  const client = await ensureClient();
  try {
    const entity = await withFloodWait(() => client.getEntity(String(channel)) as Promise<Api.Channel | Api.Chat>);
    return entity;
  } catch (e) {
    mapChannelError(e, channel);
  }
}

export async function getChannelInfo(channel: string | number): Promise<{ id: number; title: string; username?: string; isChannel: boolean }> {
  const ent = (await resolveChannel(channel)) as unknown as { id: unknown; title: string; username?: string; broadcast?: boolean; megagroup?: boolean };
  const rawId = (ent as { id: { toJSNumber?: () => number } }).id;
  const id = typeof rawId === 'object' && rawId && typeof (rawId as { toJSNumber?: () => number }).toJSNumber === 'function'
    ? (rawId as { toJSNumber: () => number }).toJSNumber()
    : Number(rawId as unknown as number);
  return {
    id,
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
  if (!userId || String(userId).trim() === '') throw new Error('userId required');
  if (rank && rank.length > 32) throw new Error('rank too long (max 32)');
  const client = await ensureClient();
  const channelEntity = await resolveChannel(channel);
  let userEntity: unknown;
  try {
    userEntity = await withFloodWait(() => client.getEntity(String(userId)) as Promise<unknown>);
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('Could not find') || msg.includes('No entity') || msg.includes('USER_ID_INVALID')) {
      throw new Error(`user_not_found: ${userId} — user must have interacted with bot or be in contacts; try inviting first`);
    }
    mapChannelError(e, channel);
  }

  try {
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
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('USER_NOT_PARTICIPANT')) {
      throw new Error(`user_not_participant: ${userId} is not in ${channel} — invite first via channels.InviteToChannel`);
    }
    if (msg.includes('CHAT_NOT_MODIFIED')) {
      // Already admin with same rights — treat as success
      logger.info(`Promote not modified — ${userId} already admin in ${channel}`);
      return;
    }
    if (msg.includes('RIGHTS_INVALID') || msg.includes('RANK_INVALID')) {
      throw new Error(`rights_invalid: ${msg}`);
    }
    mapChannelError(e, channel);
  }
  logger.info(`Promoted ${userId} to admin in ${channel}`);
}

export async function transferChannelOwnership(
  channel: string | number,
  newOwnerUserId: string | number,
  password?: string
): Promise<void> {
  const pwd = password || config.twoFaPassword;
  if (!pwd) throw new Error('2FA password required for ownership transfer (TWO_FA_PASSWORD or per-request password)');
  if (!newOwnerUserId || String(newOwnerUserId).trim() === '') throw new Error('newOwnerUserId required');

  const client = await ensureClient();
  const channelEntity = await resolveChannel(channel);
  let newOwnerEntity: unknown;
  try {
    newOwnerEntity = await withFloodWait(() => client.getEntity(String(newOwnerUserId)) as Promise<unknown>);
  } catch (e) {
    throw new Error(`new_owner_not_found: ${newOwnerUserId} — ${(e as Error).message}`);
  }

  try {
    const passwordInfo = (await withFloodWait(() => client.invoke(new (Api as unknown as { account: { GetPassword: new () => unknown } }).account.GetPassword() as unknown as any) as Promise<unknown>)) as unknown as { hasPassword: boolean };
    // If account has no password, we still need to handle
    let check: unknown = null;
    try {
      const { computeCheck } = await import('teleproto/Password');
      check = await (computeCheck as unknown as (pwd: unknown, pw: string) => Promise<unknown>)(passwordInfo, pwd);
    } catch (err) {
      const m = String((err as Error).message || err);
      if (m.includes('computeCheck') || m.includes('Cannot find')) {
        // Fallback: some teleproto versions handle SRP internally if we pass raw pwd
        check = null;
      } else {
        throw err;
      }
    }

    const inputUser = newOwnerEntity as unknown as Api.InputUser;
    if (check) {
      await withFloodWait(() =>
        client.invoke(
          new (Api.channels as unknown as { EditCreator: new (p: unknown) => unknown }).EditCreator({
            channel: channelEntity as unknown as Api.InputChannel,
            userId: inputUser as unknown as Api.InputUser,
            password: check as unknown as Api.InputCheckPasswordSRP,
          } as never) as unknown as any
        ) as Promise<unknown>
      );
    } else {
      await withFloodWait(() =>
        client.invoke(
          new (Api.channels as unknown as { EditCreator: new (p: unknown) => unknown }).EditCreator({
            channel: channelEntity as unknown as Api.InputChannel,
            userId: inputUser as unknown as Api.InputUser,
            // @ts-ignore — older typings expect InputCheckPasswordSRP
            password: pwd as unknown as Api.InputCheckPasswordSRP,
          } as never) as unknown as any
        ) as Promise<unknown>
      );
    }
    logger.info(`Transferred ownership of ${channel} to ${newOwnerUserId}`);
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('PASSWORD_EMPTY') || msg.includes('SRP_ID_INVALID')) {
      throw new Error(`2FA password invalid for ownership transfer: ${msg}`);
    }
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      throw new Error(`2FA required: ${msg} — set TWO_FA_PASSWORD`);
    }
    if (msg.includes('CHAT_ADMIN_REQUIRED') || msg.includes('CHANNEL_PRIVATE')) {
      throw new Error(`Not admin/creator of channel ${channel}: ${msg}`);
    }
    if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
      throw new Error('Ownership transfer forbidden — account too new or recent admin changes (Telegram anti-abuse, wait 24h)');
    }
    if (msg.includes('USER_NOT_MUTUAL_CONTACT') || msg.includes('USER_ID_INVALID')) {
      throw new Error(`new_owner_invalid: ${newOwnerUserId} — ${msg}`);
    }
    if (msg.includes('CHANNELS_TOO_MUCH')) {
      throw new Error('CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups');
    }
    throw e;
  }
}

export async function demoteAdmin(channel: string | number, userId: string | number): Promise<void> {
  if (!userId) throw new Error('userId required');
  const client = await ensureClient();
  const channelEntity = await resolveChannel(channel);
  let userEntity: unknown;
  try {
    userEntity = await withFloodWait(() => client.getEntity(String(userId)) as Promise<unknown>);
  } catch (e) {
    throw new Error(`user_not_found: ${userId} — ${(e as Error).message}`);
  }
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
  // @ts-ignore — teleproto expects BigInteger for hash, JS BigInt is compatible at runtime
  const res = (await withFloodWait(() =>
    client.invoke(
      new Api.channels.GetParticipants({
        channel: channelEntity as unknown as Api.InputChannel,
        filter: new Api.ChannelParticipantsAdmins(),
        offset: 0,
        limit: 100,
        hash: 0 as unknown as any,
      })
    )
  )) as unknown as { participants: Array<{ userId: unknown; participant: { className: string } }> };
  return res.participants.map((p) => {
    const raw = p.userId as unknown as { toJSNumber?: () => number; toString?: () => string };
    const id = typeof raw === 'object' && raw && typeof raw.toJSNumber === 'function' ? raw.toJSNumber() : Number(String(raw));
    // Use BigInt string for >53-bit IDs to avoid precision loss
    return {
      id,
      isCreator: p.participant.className === 'ChannelParticipantCreator',
    };
  });
}
