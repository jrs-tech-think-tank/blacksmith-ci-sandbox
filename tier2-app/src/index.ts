import { randomUUID } from 'node:crypto';
import express from 'express';
import _ from 'lodash';
import { formatISO } from 'date-fns';
import pino from 'pino';

const logger = pino({ name: 'tier2-build-lab' });
const app = express();
app.use(express.json());

interface PaymentInput {
  amountCents: number;
  currency: string;
}

type Payment = PaymentInput & { id: string; recordedAt: string };

const ledger: Payment[] = [];

function validate(body: unknown): PaymentInput | null {
  if (!_.isObject(body)) return null;
  const { amountCents, currency } = body as Record<string, unknown>;
  if (!_.isInteger(amountCents) || (amountCents as number) < 0) return null;
  if (!_.isString(currency) || (currency as string).length !== 3) return null;
  return { amountCents: amountCents as number, currency: currency as string };
}

app.post('/payments', (req, res) => {
  const input = validate(req.body);
  if (!input) {
    return res.status(400).json({ error: 'invalid payment' });
  }
  const payment: Payment = {
    ...input,
    id: randomUUID(),
    recordedAt: formatISO(new Date()),
  };
  ledger.push(payment);
  logger.info({ id: payment.id }, 'payment recorded');
  return res.status(201).json(payment);
});

app.get('/payments/summary', (_req, res) => {
  const totalCents = _.sumBy(ledger, (p) => p.amountCents);
  const byCurrency = _.mapValues(_.groupBy(ledger, 'currency'), (group) =>
    _.sumBy(group, 'amountCents'),
  );
  return res.json({ count: ledger.length, totalCents, byCurrency });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => logger.info({ port }, 'tier2 build lab listening'));
