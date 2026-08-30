import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

/**
 * Transforme tout ce qu'un appel wagmi/viem peut lancer en une ligne lisible.
 *
 * Regle du module : un `error.message` brut n'atteint jamais l'ecran. Le message
 * de viem est un pave multi-paragraphes ; shortMessage ne fait que le tronquer.
 *
 * Ordre de resolution, du plus precis au plus general :
 *   1. l'erreur custom du contrat, decodee par son nom (le bon cas) ;
 *   2. le wallet qui refuse de signer ;
 *   3. quelques formes d'infra a nommer nous-memes (gas, nonce, noeud injoignable) ;
 *   4. une ligne generique en dernier recours.
 */

/** Erreurs custom, indexees par le `errorName` que viem decode dans la revert data. */
const CUSTOM_ERRORS: Record<string, string> = {
  // Pool — celles qu'un utilisateur peut reellement declencher
  BadSlippage: 'Slippage exceeded. The pool moved against you — raise the tolerance and retry.',
  InsufficientReserve: 'Not enough reserve in the pool for this trade. Try a smaller amount.',
  ReserveOverflow: 'This amount exceeds the reserve limit. Try a smaller amount.',
  ZeroOutput: 'This trade would return zero. Try a larger amount.',
  CeilingTouched: 'This trade would push a token past its ceiling. Try a smaller amount.',
  FloorTouched: 'This trade would push a token below its floor. Try a smaller amount.',
  EnforcedPause: 'The pool is paused. Swaps and deposits are suspended.',
  ExpectedPause: 'The pool is not paused.',
  NotBootstrapped: 'The pool has not been bootstrapped yet.',
  FeeTooHigh: 'That fee is above the maximum the pool allows.',
  FeeOutOfBand: 'That fee falls outside the permitted band.',
  EmptyFeeBand: 'That fee band is empty.',
  FeeAlreadySetThisEpoch: 'The fee has already been set for this epoch.',
  NotManager: 'Only the current manager can do this.',
  ManagerAlreadySet: 'A manager is already set for this epoch.',
  AuctionAlreadySet: 'The auction contract is already set.',
  EpochAlreadyStarted: 'This epoch has already started.',
  OutsidePriorityWindow: 'Outside the priority window.',
  PriorityWindowTooLong: 'The priority window is too long.',
  ZeroEpochDuration: 'The epoch duration cannot be zero.',
  ZeroManager: 'The manager address cannot be zero.',
  ZeroFeesOwed: 'There are no fees to collect.',
  ZeroRentOwed: 'There is no rent to claim.',
  NotAuction: 'Only the auction contract can call this.',
  NotAuctionOrOwner: 'Only the auction contract or the owner can call this.',

  // Auction
  BidTooLow: 'Your bid is too low to take the lead.',
  WindowClosed: 'The auction window is closed.',
  NoBidToSettle: 'You have no bid to settle.',
  NoBidToRefund: 'You have no refund to withdraw.',

  // Faucet
  TooEarly: 'Too early — the cooldown has not elapsed yet.',
  FaucetEmpty: 'The faucet is empty.',

  // ERC-20, partagees par le pool, les mocks et MRN
  ERC20InsufficientBalance: 'Insufficient balance.',
  ERC20InsufficientAllowance: 'Allowance too low — approve the token first.',
  ERC20InvalidReceiver: 'Invalid recipient address.',
  ERC20InvalidSender: 'Invalid sender address.',
  ERC20InvalidSpender: 'Invalid spender address.',
  ERC20InvalidApprover: 'Invalid approver address.',
  SafeERC20FailedOperation: 'The token transfer failed.',

  // Ownable
  OwnableUnauthorizedAccount: 'Only the owner can do this.',
  OwnableInvalidOwner: 'Invalid owner address.',
};

const FALLBACK = 'The transaction could not be completed. Check the parameters and retry.';

/** Echecs d'infrastructure a nommer nous-memes, testes contre `shortMessage`. */
const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/user rejected|user denied|rejected the request/i, 'Transaction rejected in your wallet.'],
  [/insufficient funds|insufficient balance for gas/i, 'Not enough ETH to cover gas fees.'],
  [/\brpc\b|could not reach|network error|timeout|timed out|failed to fetch/i,
   'The node could not be reached. Check your connection and retry.'],
  [/nonce/i, 'A pending transaction is conflicting. Wait for it, then retry.'],
  [/chain.*mismatch|unsupported chain|chain not/i, 'Wrong network. Switch to the expected chain.'],
  [/replacement.*underpriced|underpriced/i, 'A pending transaction is blocking this one. Wait, then retry.'],
  // V.5 — Base / Base Sepolia imposent un plafond de gas par transaction de 2^24 = 16 777 216.
  // Le gas de repli du wallet apres un echec de simulation peut le depasser, et le RPC renvoie
  // le message de plafond au lieu du vrai revert. On le traduit : la vraie cause (allowance,
  // solde, slippage) est presque toujours en amont.
  [/exceeds\s+(?:maximum\s+)?per-transaction\s+gas\s+limit|exceeds\s+max\s+transaction\s+gas\s+limit/i,
   'The transaction simulation reverted upstream and the wallet fell back to a gas limit above Base\'s per-transaction cap (2^24 = 16,777,216). The likely real cause is missing approval, insufficient balance, or slippage — check those and retry.'],
];

/**
 * Le nom decode d'une erreur custom, ou undefined quand viem n'a qu'une chaine
 * de revert. `data` est discrimine : un nom si l'ABI portait l'erreur, un message brut sinon.
 */
function revertName(revert: ContractFunctionRevertedError): string | undefined {
  const data = revert.data as { errorName?: string } | undefined;
  return typeof data?.errorName === 'string' ? data.errorName : undefined;
}

function fromShape(text: string): string | undefined {
  return SHAPES.find(([pattern]) => pattern.test(text))?.[1];
}

export function describeTxError(error: unknown): string {
  if (error === null || error === undefined) return FALLBACK;

  if (error instanceof UserRejectedRequestError) {
    return 'Transaction rejected in your wallet.';
  }

  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revertName(revert);
      if (name !== undefined && name in CUSTOM_ERRORS) return CUSTOM_ERRORS[name];
      // Erreur custom inconnue : le nom reste plus utile que le pave de viem.
      if (name !== undefined) return `The contract rejected the call: ${name}.`;
    }

    // Le one-liner condense de viem. Mieux que `message`, mais encore brut :
    // il passe par la meme detection de forme que le reste.
    const short = error.shortMessage;
    if (typeof short === 'string' && short.length > 0) {
      return fromShape(short) ?? short;
    }
  }

  if (error instanceof Error && error.message.length > 0) {
    return fromShape(error.message) ?? FALLBACK;
  }

  return FALLBACK;
}
