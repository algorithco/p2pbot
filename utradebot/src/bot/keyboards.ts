import { InlineKeyboard } from 'grammy';

export function sellKeyboard(tradeId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Payment received — share phone', `confirm_payment:${tradeId}`)
    .row()
    .text('❌ Cancel trade', `cancel_trade:${tradeId}`);
}

export function buyerKeyboard(tradeId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('📲 I sent the code', `buyer_code_sent:${tradeId}`)
    .row()
    .text('❌ Cancel', `cancel_trade:${tradeId}`);
}

export function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('💼 Sell account', 'start_sell').text('📋 My trades', 'my_trades');
}
