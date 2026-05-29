export interface MemoryTargetClassifierTarget {
  readonly targetRef?: string;
  readonly id?: string;
  readonly label?: string;
  readonly fieldName?: string;
  readonly kind?: string;
  readonly action?: string;
  readonly required?: boolean;
}

export interface MemoryTargetClassification {
  readonly clusters: Record<string, readonly string[]>;
  readonly skippedTargets: readonly {
    readonly id: string;
    readonly reason: string;
  }[];
}

const CLUSTER_NAMES = [
  'identity',
  'contact',
  'receipt',
  'notification',
  'payment',
  'marketing',
  'unknown',
] as const;

export async function classifyMemoryTargets(input: {
  readonly task?: string;
  readonly targets: readonly MemoryTargetClassifierTarget[];
}): Promise<MemoryTargetClassification> {
  const clusters: Record<string, string[]> = Object.fromEntries(
    CLUSTER_NAMES.map((name) => [name, []])
  );
  const skippedTargets: Array<{ id: string; reason: string }> = [];

  for (const target of input.targets) {
    const id = readTargetRef(target);
    if (!id) {
      continue;
    }

    const cluster = classifyTarget(target);
    clusters[cluster].push(id);
    if (cluster === 'marketing') {
      skippedTargets.push({ id, reason: 'optional_marketing' });
    }
  }

  return {
    clusters,
    skippedTargets,
  };
}

function classifyTarget(target: MemoryTargetClassifierTarget): (typeof CLUSTER_NAMES)[number] {
  const explicitType = normalizeExplicitName(target.fieldName);

  if (MARKETING_TYPES.has(explicitType)) {
    return 'marketing';
  }

  if (PAYMENT_TYPES.has(explicitType)) {
    return 'payment';
  }

  if (RECEIPT_TYPES.has(explicitType)) {
    return 'receipt';
  }

  if (NOTIFICATION_TYPES.has(explicitType)) {
    return 'notification';
  }

  if (IDENTITY_TYPES.has(explicitType)) {
    return 'identity';
  }

  if (CONTACT_TYPES.has(explicitType)) {
    return 'contact';
  }

  return 'unknown';
}

function readTargetRef(target: MemoryTargetClassifierTarget): string | undefined {
  return target.targetRef ?? target.id;
}

function normalizeExplicitName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

const IDENTITY_TYPES = new Set([
  'identity',
  'identity_document',
  'passport_number',
  'passport',
  'traveler_identity',
]);
const CONTACT_TYPES = new Set(['contact', 'email', 'phone', 'address_line']);
const RECEIPT_TYPES = new Set(['receipt', 'receipt_email']);
const NOTIFICATION_TYPES = new Set(['notification', 'sms_updates', 'trip_updates']);
const PAYMENT_TYPES = new Set(['payment', 'provider_card_ref', 'provider_account_ref']);
const MARKETING_TYPES = new Set(['marketing', 'marketing_opt_in', 'newsletter', 'survey']);
