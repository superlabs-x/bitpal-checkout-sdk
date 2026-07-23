/**
 * create-session.mjs — 외부 머천트 통합 시뮬
 *
 * 동작:
 *   1. BitPal SDK로 체크아웃 세션 생성
 *   2. 응답에서 받은 결제 URL 출력 → 브라우저로 열어서 buyer가 결제
 *
 * 실행:
 *   BITPAL_API_KEY=bp_test_xxx node create-session.mjs
 *
 * 또는 sdk가 빌드된 상태에서:
 *   pnpm --filter @bitpal/checkout build
 *   node examples/create-session.mjs
 */
import { BitPal, toAtomicUSDC, fromAtomicUSDC } from '../dist/index.js';

const apiKey = process.env.BITPAL_API_KEY;
const baseUrl = process.env.BITPAL_API_BASE ?? 'http://localhost:3100';

if (!apiKey) {
  console.error('환경변수 BITPAL_API_KEY 필요. (콘솔 → Developers → API Keys에서 발급)');
  process.exit(1);
}

const bitpal = new BitPal({ apiKey, baseUrl });

console.log(`[demo] API: ${baseUrl}`);
console.log(`[demo] Key: ${apiKey.slice(0, 12)}…`);

// ── 1. 수수료 미리보기 ────────────────────────────────────────────────
const amount = toAtomicUSDC('29.00');
console.log(`\n[1] 수수료 미리보기 ($29.00 = ${amount} μUSDC)`);
const { data: fee } = await bitpal.checkout.previewFee(amount);
console.log(`    fee_rate:   ${fee.fee_rate}`);
console.log(`    fee_amount: $${fromAtomicUSDC(fee.fee_amount)} (${fee.fee_amount} μUSDC)`);
console.log(`    net_amount: $${fromAtomicUSDC(fee.net_amount)}`);

// ── 2. 체크아웃 세션 생성 ──────────────────────────────────────────────
console.log(`\n[2] 체크아웃 세션 생성`);
const { data: session } = await bitpal.checkout.createSession({
  line_items: [
    { name: 'Pro Plan', amount, currency: 'USDC', quantity: 1 },
  ],
  pay_chain: 'eip155:84532', // Base Sepolia (test 키). live: 'eip155:8453'(Base mainnet).
  expires_in_seconds: 1800,
  success_url: 'http://localhost:3000/success',
  cancel_url: 'http://localhost:3000/cancel',
});

console.log(`    session.id:           ${session.id}`);
console.log(`    session.status:       ${session.status}`);
console.log(`    session.amount_total: ${session.amount_total} μUSDC ($${fromAtomicUSDC(session.amount_total)})`);
console.log(`    session.expires_at:   ${session.expires_at ?? '(none)'}`);

// ── 3. 결제 URL ──────────────────────────────────────────────────────
console.log(`\n[3] 결제 URL — 브라우저에서 열기:`);
console.log(`    ${session.url ?? `${baseUrl.replace('api.', '').replace('3100', '3200')}/pay/${session.id}`}`);
console.log(`\n    TEST 모드 키로 만든 세션이라 4가지 시나리오 버튼이 보입니다.`);
console.log(`    "즉시 성공"을 클릭하면 결제 완료 후 success_url로 redirect됩니다.`);
