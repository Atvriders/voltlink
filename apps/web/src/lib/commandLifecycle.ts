// Command lifecycle labels (guide 07 §2.6, F-LIFECYCLEUI): every terminal state
// has a human explanation, and success is only shown once the vehicle confirms.

import type { CommandStatus } from '@voltlink/shared';

export const STAGES = ['queued', 'submitted', 'accepted', 'confirmed'] as const;

export interface OutcomeInfo {
  label: string;
  explain: string;
  failure: boolean;
}

export const OUTCOME: Partial<Record<CommandStatus, OutcomeInfo>> = {
  confirmed: {
    label: 'Confirmed',
    explain: 'The vehicle state confirms the command completed.',
    failure: false,
  },
  accepted: {
    label: 'Sent',
    explain: 'The provider accepted the command; the vehicle cannot confirm it.',
    failure: false,
  },
  failed: { label: 'Failed', explain: 'The command could not be delivered.', failure: true },
  rejected: {
    label: 'Rejected',
    explain: 'The vehicle or provider refused the command.',
    failure: true,
  },
  unsupported: {
    label: 'Unsupported',
    explain: 'This vehicle does not support the command.',
    failure: true,
  },
  timed_out: {
    label: 'Timed out',
    explain: 'No confirmation arrived in time. Check the vehicle.',
    failure: true,
  },
  canceled: {
    label: 'Canceled',
    explain: 'The command was canceled before it reached the vehicle.',
    failure: true,
  },
  queued: { label: 'Queued', explain: 'The command is waiting to be dispatched.', failure: false },
  submitted: {
    label: 'Submitted',
    explain: 'The command is on its way to the vehicle.',
    failure: false,
  },
};

export function outcomeFor(status: CommandStatus): OutcomeInfo {
  return OUTCOME[status] ?? { label: status, explain: '', failure: false };
}
