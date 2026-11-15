export const CASH_FIELDS = ['cash_unknown','cash_start','cash_week2','cash_week3','cash_end','cash_carry'];
export const LABELS = {kind:'種類',id:'ID',month:'計上月',side:'借貸',date:'日付',category:'費目',description:'摘要',amount:'金額',payment:'決済',processed:'処理済み',settled_month:'精算月',asset_id:'充当先資産ID',voided:'取消',year:'登録年度',name:'名称',acquired_date:'取得日',cost:'取得額',note:'備考',budget:'予算額',cash_unknown:'繰入 不明',cash_start:'月初確定',cash_week2:'2週確定',cash_week3:'3週確定',cash_end:'月末確定',cash_carry:'繰越 確定',cash_expected:'照合用現金額',cash_checked_on:'確認日',cash_note:'確認メモ'};
export const MONEY_LIMIT = 1000000000000;
export function yen(n) { return n == null ? '未記入' : new Intl.NumberFormat('ja-JP').format(n); }
export function today() { return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
export function key(e) { return `${e.kind}:${e.id.toLowerCase()}`; }
export function moneyInput(value, nullable=false) {
  if(value === '' && nullable) return null;
  if(!/^-?\d+$/.test(value)) throw new Error('金額は円単位の整数で入力してください。');
  const n=Number(value); if(!Number.isSafeInteger(n) || Math.abs(n)>MONEY_LIMIT) throw new Error('金額が入力範囲を超えています。');
  return n;
}
export function uuid() {
  if(globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const a=globalThis.crypto.getRandomValues(new Uint8Array(16)); a[6]=(a[6]&15)|64; a[8]=(a[8]&63)|128;
  const s=Array.from(a,v=>v.toString(16).padStart(2,'0')).join(''); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export function describe(e) {
  if(!e) return '登録前';
  return Object.entries(e).filter(([k])=>!['kind','id'].includes(k)).map(([k,v])=>`${LABELS[k]||k}：${v===null?'未記入':v===true?'はい':v===false?'いいえ':v===''?'—':v}`).join('\n');
}
export function processing(e, enabled, month) {
  return {...e, processed:enabled, settled_month:enabled ? (month>e.month?month:e.month) : ''};
}
