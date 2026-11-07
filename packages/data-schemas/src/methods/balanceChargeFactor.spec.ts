import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IBalance } from '..';
import type { ITransaction } from '~/schema/transaction';
import { matchModelName, findMatchingPattern } from './test-helpers';
import { createSpendTokensMethods } from './spendTokens';
import { createTransactionMethods } from './transaction';
import { createModels } from '~/models';
import { createTxMethods } from './tx';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Balance: mongoose.Model<IBalance>;
let Transaction: mongoose.Model<ITransaction>;
let spendTokens: ReturnType<typeof createSpendTokensMethods>['spendTokens'];
let createTransaction: ReturnType<typeof createTransactionMethods>['createTransaction'];
let getMultiplier: ReturnType<typeof createTxMethods>['getMultiplier'];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);

  Balance = mongoose.models.Balance;
  Transaction = mongoose.models.Transaction;

  const txMethods = createTxMethods(mongoose, { matchModelName, findMatchingPattern });
  getMultiplier = txMethods.getMultiplier;

  const transactionMethods = createTransactionMethods(mongoose, {
    getMultiplier: txMethods.getMultiplier,
    getCacheMultiplier: txMethods.getCacheMultiplier,
  });
  createTransaction = transactionMethods.createTransaction;

  const spendMethods = createSpendTokensMethods(mongoose, {
    createTransaction: transactionMethods.createTransaction,
    createStructuredTransaction: transactionMethods.createStructuredTransaction,
  });
  spendTokens = spendMethods.spendTokens;

  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('Balance charge factor', () => {
  const model = 'gpt-3.5-turbo';

  test('charges the full standard cost when no factor is given', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    await spendTokens(
      {
        user: userId,
        conversationId: 'charge-factor-default',
        model,
        context: 'test',
        balance: { enabled: true },
      },
      { promptTokens: 100, completionTokens: 50 },
    );

    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    const completionMultiplier = getMultiplier({ model, tokenType: 'completion' });
    const expectedCost = 100 * promptMultiplier + 50 * completionMultiplier;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('debits only the charged fraction of the standard cost', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    await spendTokens(
      {
        user: userId,
        conversationId: 'charge-factor-half',
        model,
        context: 'test',
        balance: { enabled: true },
        balanceChargeFactor: 0.5,
      },
      { promptTokens: 100, completionTokens: 50 },
    );

    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    const completionMultiplier = getMultiplier({ model, tokenType: 'completion' });
    const standardCost = 100 * promptMultiplier + 50 * completionMultiplier;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - standardCost * 0.5, 0);
  });

  test('debits nothing when the factor is zero', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    await spendTokens(
      {
        user: userId,
        conversationId: 'charge-factor-free',
        model,
        context: 'test',
        balance: { enabled: true },
        balanceChargeFactor: 0,
      },
      { promptTokens: 100, completionTokens: 50 },
    );

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBe(initialBalance);
  });

  test('leaves the rate untouched so the real cost stays derivable', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Balance.create({ user: userId, tokenCredits: 10000000 });

    await createTransaction({
      user: userId,
      conversationId: 'charge-factor-rate',
      model,
      context: 'test',
      tokenType: 'prompt',
      rawAmount: -100,
      balance: { enabled: true },
      balanceChargeFactor: 0.5,
    });

    const transaction = await Transaction.findOne({ user: userId });
    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });

    expect(transaction?.rate).toBe(promptMultiplier);
    expect(transaction?.tokenValue).toBeCloseTo(-100 * promptMultiplier * 0.5, 5);
  });

  test('clamps an out-of-range factor to the valid range', async () => {
    const userId = new mongoose.Types.ObjectId();
    const initialBalance = 10000000;
    await Balance.create({ user: userId, tokenCredits: initialBalance });

    await spendTokens(
      {
        user: userId,
        conversationId: 'charge-factor-clamped',
        model,
        context: 'test',
        balance: { enabled: true },
        balanceChargeFactor: 5,
      },
      { promptTokens: 100, completionTokens: 50 },
    );

    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    const completionMultiplier = getMultiplier({ model, tokenType: 'completion' });
    const expectedCost = 100 * promptMultiplier + 50 * completionMultiplier;

    const updatedBalance = await Balance.findOne({ user: userId });
    expect(updatedBalance?.tokenCredits).toBeCloseTo(initialBalance - expectedCost, 0);
  });

  test('records the factor on the transaction', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Balance.create({ user: userId, tokenCredits: 10000000 });

    await spendTokens(
      {
        user: userId,
        conversationId: 'charge-factor-recorded',
        model,
        context: 'test',
        balance: { enabled: true },
        balanceChargeFactor: 0.25,
      },
      { promptTokens: 10, completionTokens: 0 },
    );

    const transaction = await Transaction.findOne({ user: userId });
    expect(transaction?.balanceChargeFactor).toBe(0.25);
  });

  test('leaves the rate untouched when no factor is given', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Balance.create({ user: userId, tokenCredits: 10000000 });

    await createTransaction({
      user: userId,
      conversationId: 'charge-factor-default-rate',
      model,
      context: 'test',
      tokenType: 'prompt',
      rawAmount: -100,
      balance: { enabled: true },
    });

    const transaction = await Transaction.findOne({ user: userId });
    const promptMultiplier = getMultiplier({ model, tokenType: 'prompt' });
    expect(transaction?.rate).toBe(promptMultiplier);
    expect(transaction?.tokenValue).toBeCloseTo(-100 * promptMultiplier, 5);
  });
});
