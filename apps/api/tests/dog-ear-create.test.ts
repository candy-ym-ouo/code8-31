import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  book: { findFirst: vi.fn() },
  dogEar: { findFirst: vi.fn(), create: vi.fn() },
  activityEvent: { create: vi.fn() },
  $transaction: vi.fn()
}));

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));

vi.mock('../src/lib/auth.js', () => ({
  requireAuth: async (request: { authUser?: unknown }) => {
    request.authUser = { id: USER_ID, email: 'reader@example.com', createdAt: new Date() };
  },
  currentUser: (request: { authUser?: unknown }) => {
    if (!request.authUser) throw new Error('unauthenticated');
    return request.authUser;
  }
}));

const { traceRoutes } = await import('../src/modules/traces/routes.js');
const { AppError, sendError } = await import('../src/lib/errors.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '22222222-2222-4222-8222-222222222222';
const DOG_EAR_ID = '33333333-3333-4333-8333-333333333333';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the index: dog_ears_book_page_active_key',
    { code: 'P2002', clientVersion: '6.12.0' }
  );
}

function dogEarRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOG_EAR_ID,
    userId: USER_ID,
    bookId: BOOK_ID,
    version: 1,
    pageNumber: 42,
    reason: '这一页很重要',
    createdAt: new Date('2026-09-26T10:00:00Z'),
    updatedAt: new Date('2026-09-26T10:00:00Z'),
    deletedAt: null,
    ...overrides
  };
}

async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.statusCode, error.code, error.message, error.fields, request.id);
    }
    return sendError(reply, 500, 'INTERNAL_ERROR', String(error), undefined, request.id);
  });
  await app.register(traceRoutes, { prefix: '/api/v1' });
  return app;
}

function postDogEar(app: Awaited<ReturnType<typeof buildTestApp>>, reason: string | null = '这一页很重要') {
  return app.inject({
    method: 'POST',
    url: `/api/v1/books/${BOOK_ID}/dog-ears`,
    headers: { 'content-type': 'application/json' },
    payload: { pageNumber: 42, reason }
  });
}

describe('POST /books/:bookId/dog-ears 并发幂等', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.book.findFirst.mockResolvedValue({
      id: BOOK_ID,
      userId: USER_ID,
      pageCount: 300,
      deletedAt: null
    });
    prismaMock.$transaction.mockImplementation((fn: (tx: typeof prismaMock) => unknown) =>
      fn(prismaMock)
    );
    prismaMock.activityEvent.create.mockResolvedValue({});
  });

  it('并发下相同内容撞唯一索引后返回已有记录（200 幂等），不再写入第二条', async () => {
    const existing = dogEarRow();
    // 时序：查重时对方未提交 → 插入撞唯一索引 → 重查看到对方已提交的行
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    prismaMock.dogEar.create.mockRejectedValueOnce(p2002());

    const app = await buildTestApp();
    const res = await postDogEar(app);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.idempotent).toBe(true);
    expect(body.dogEar.id).toBe(DOG_EAR_ID);
    expect(body.dogEar.type).toBe('DOG_EAR');
    expect(prismaMock.dogEar.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activityEvent.create).not.toHaveBeenCalled();
  });

  it('并发下内容不同仍报 409 冲突', async () => {
    const existing = dogEarRow({ reason: '完全不同的理由' });
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    prismaMock.dogEar.create.mockRejectedValueOnce(p2002());

    const app = await buildTestApp();
    const res = await postDogEar(app);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DOG_EAR_EXISTS');
    expect(prismaMock.dogEar.create).toHaveBeenCalledTimes(1);
  });

  it('创建成功后相同内容的重试返回同一条记录，只留一条痕迹', async () => {
    const created = dogEarRow();
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(null);
    prismaMock.dogEar.create.mockResolvedValueOnce(created);

    const app = await buildTestApp();
    const first = await postDogEar(app);
    expect(first.statusCode).toBe(201);
    expect(first.json().dogEar.id).toBe(DOG_EAR_ID);
    expect(prismaMock.activityEvent.create).toHaveBeenCalledTimes(1);

    // 重试（网络重发 / 用户重复点击）：命中已有记录，幂等返回
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(created);
    const retry = await postDogEar(app);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().idempotent).toBe(true);
    expect(retry.json().dogEar.id).toBe(DOG_EAR_ID);

    expect(prismaMock.dogEar.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.activityEvent.create).toHaveBeenCalledTimes(1);
  });

  it('撞唯一索引后已有记录被并发删除时，重试插入成功', async () => {
    const created = dogEarRow();
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prismaMock.dogEar.create.mockRejectedValueOnce(p2002()).mockResolvedValueOnce(created);

    const app = await buildTestApp();
    const res = await postDogEar(app);

    expect(res.statusCode).toBe(201);
    expect(res.json().dogEar.id).toBe(DOG_EAR_ID);
    expect(prismaMock.dogEar.create).toHaveBeenCalledTimes(2);
  });

  it('已有相同内容记录时直接幂等返回，不触发插入', async () => {
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(dogEarRow());

    const app = await buildTestApp();
    const res = await postDogEar(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().idempotent).toBe(true);
    expect(prismaMock.dogEar.create).not.toHaveBeenCalled();
  });
});
