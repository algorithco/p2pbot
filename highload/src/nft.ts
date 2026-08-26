import { Address, beginCell, Cell, toNano } from '@ton/core';

/**
 * TEP-62 (NFT standard) helpers.
 * https://github.com/ton-blockchain/TEPs/blob/master/text/0062-nft-standard.md
 */

/** op::transfer */
export const NFT_TRANSFER_OP = 0x5fcc3d14;

/** Default forward amount to notify the new owner (marketplaces expect >= 0.01 TON) */
export const DEFAULT_NFT_FORWARD_TON = '0.01';

/** Default gas+forward budget attached to the transfer message to the item contract */
export const DEFAULT_NFT_VALUE_TON = '0.05';

export interface NftTransferOptions {
    /** NFT item (not collection!) contract address */
    nftAddress: Address | string;
    /** receiver of the NFT */
    newOwner: Address | string;
    /** where excess TON of the transfer is returned (default: sender wallet) */
    responseAddress?: Address | string | null;
    /** notification amount sent to new owner (default 0.01 TON) */
    forwardAmount?: bigint | string;
    /** optional forward payload (comment / marketplace data) */
    forwardPayload?: Cell | null;
    /** arbitrary query id for tracking (defaults to unixtime-based) */
    queryId?: bigint | number;
}

function resolveAddr(src: Address | string | null | undefined): Address | null {
    if (!src) return null;
    return typeof src === 'string' ? Address.parse(src) : src;
}

/**
 * Build TEP-62 transfer body:
 * transfer#5fcc3d14 query_id:uint64 new_owner:MsgAddressInt
 *   response_destination:MsgAddressInt custom_payload:(Maybe ^Cell)
 *   forward_amount:Coins forward_payload:(Either Cell ^Cell);
 */
export function buildNftTransferBody(opts: {
    queryId: bigint | number;
    newOwner: Address;
    responseAddress?: Address | null;
    forwardAmount?: bigint;
    forwardPayload?: Cell | null;
}): Cell {
    const builder = beginCell()
        .storeUint(NFT_TRANSFER_OP, 32)
        .storeUint(BigInt(opts.queryId), 64)
        .storeAddress(opts.newOwner)
        .storeAddress(opts.responseAddress ?? null) // addr_none when omitted
        .storeBit(0) // custom_payload: none
        .storeCoins(opts.forwardAmount ?? toNano(DEFAULT_NFT_FORWARD_TON));

    if (opts.forwardPayload) {
        builder.storeBit(1).storeRef(opts.forwardPayload);
    } else {
        builder.storeBit(0); // forward_payload: empty inline
    }
    return builder.endCell();
}

/** Parsed view of get_nft_data() */
export interface NftInfo {
    deployed: boolean;
    /** false when item not initialized yet */
    init: boolean | null;
    index: bigint | null;
    collection: Address | null;
    owner: Address | null;
}

/**
 * Parse the stack returned by the standard get_nft_data() method:
 *   (int init?, int index, slice collection, slice owner, cell content)
 */
export function parseNftData(stack: {
    readNumber: () => number;
    readBigNumber: () => bigint;
    readCell: () => Cell;
}): NftInfo {
    const initFlag = stack.readNumber(); // -1 initialized, 0 not
    const index = stack.readBigNumber();
    const collectionCell = stack.readCell();
    const ownerCell = stack.readCell();

    const collection = safeLoadAddr(collectionCell);
    const owner = safeLoadAddr(ownerCell);

    return {
        deployed: true,
        init: initFlag === -1,
        index,
        collection,
        owner,
    };
}

function safeLoadAddr(cell: Cell): Address | null {
    try {
        const s = cell.beginParse();
        if (s.remainingBits < 2) return null;
        return s.loadAddress();
    } catch {
        return null;
    }
}
