import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

/**
 * Turns anything a wagmi/viem call can throw into one readable English line.
 *
 * The rule this module exists to enforce: a raw `error.message` never reaches
 * the screen. viem's `message` is a multi-paragraph dump — "Execution reverted
 * for an unknown reason", trailing hex, nested `Details:` blocks — and the
 * `shortMessage` only trims it, it does not translate it.
 *
 * Resolution order, most specific first:
 *   1. the contract's own custom error, decoded by name (the good path);
 *   2. the wallet refusing to sign;
 *   3. a few infrastructure shapes worth naming in our own words — gas, nonce,
 *      and the node being unreachable, which is what used to surface as "RPC error";
 *   4. a generic line as a last resort. Better slightly vague than unreadable.
 */

/** Custom errors, keyed by the `errorName` viem decodes from the revert data. */
const CUSTOM_ERRORS: Record<string, string> = {
  // Pool — the ones a user can actually trigger
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

  // ERC-20, shared by the pool, the mocks and MRN
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

/** Infrastructure failures worth naming ourselves, checked against `shortMessage`. */
const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/user rejected|user denied|rejected the request/i, 'Transaction rejected in your wallet.'],
  [/insufficient funds|insufficient balance for gas/i, 'Not enough ETH to cover gas fees.'],
  [/\brpc\b|could not reach|network error|timeout|timed out|failed to fetch/i,
   'The node could not be reached. Check your connection and retry.'],
  [/nonce/i, 'A pending transaction is conflicting. Wait for it, then retry.'],
  [/chain.*mismatch|unsupported chain|chain not/i, 'Wrong network. Switch to the expected chain.'],
  [/replacement.*underpriced|underpriced/i, 'A pending transaction is blocking this one. Wait, then retry.'],
];

/**
 * The decoded name of a custom error, or undefined when viem only has a
 * revert string. `data` is a discriminated shape: a name when the ABI carried
 * the error, a bare message otherwise.
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
      // An unknown custom error: the name is still more useful than viem's dump.
      if (name !== undefined) return `The contract rejected the call: ${name}.`;
    }

    // viem's condensed one-liner. Better than `message`, but it still leaks
    // raw wording, so it goes through the same shape matching as anything else.
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
