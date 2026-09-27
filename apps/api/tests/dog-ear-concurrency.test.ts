import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => {
  const tx = {
    dogEar: { create: vi.fn() },
    activityEvent: { create: vi.fn() }
  };
  return {
    tx,
    session: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn()
    },
    book: { findFirst: vi.fn() },
    dogEar: {
      findFirst: vi.fn(),
      create: tx.dogEar.create,
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn()
    },
    activityEvent: { create: tx.activityEvent.create },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx))
  };
});

vi.mock('../src/lib/prisma.js', () => ({ prisma: prismaMock }));

const { traceRoutes } = await import('../src/modules/traces/routes.js');
const { AppError, mapPrismaError, sendError, zodFields } = await import('../src/lib/errors.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '22222222-2222-4222-8222-222222222222';
const WINNER_ID = '33333333-3333-4333-8333-333333333333';

const book = {
  id: BOOK_ID,
  userId: USER_ID,
  pageCount: 500,
  deletedAt: null
};

function winnerRow(reason: string | null) {
  return {
    id: WINNER_ID,
    userId: USER_ID,
    bookId: BOOK_ID,
    version: 1,
    pageNumber: 42,
    reason,
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    updatedAt: new Date('2026-09-26T10:00:00.000Z'),
    deletedAt: null
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`book_id`,`page_number`)',
    { code: 'P2002', clientVersion: '6.12.0', meta: { target: ['book_id', 'page_number'] } }
  );
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'test-secret-test-secret-test-secret' });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.statusCode, error.code, error.message, error.fields, request.id);
    }
    if (error instanceof ZodError) {
      return sendError(reply, 422, 'VALIDATION_ERROR', '请求参数无效', zodFields(error), request.id);
    }
    if (mapPrismaError(error, reply)) return;
    return sendError(reply, 500, 'INTERNAL_ERROR', '服务器暂时无法处理请求', undefined, request.id);
  });
  await app.register(traceRoutes, { prefix: '/api/v1' });
  return app;
}

function postDogEar(app: FastifyInstance, payload: { pageNumber: number; reason: string | null }) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/books/${BOOK_ID}/dog-ears`,
    cookies: { pbt_session: 'test-token' },
    payload
  });
}

describe('同页折角并发提交', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    prismaMock.session.findUnique.mockResolvedValue({
      id: 'session-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      user: {
        id: USER_ID,
        email: 'reader@example.com',
        status: 'ACTIVE',
        deletedAt: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z')
      }
    });
    prismaMock.book.findFirst.mockResolvedValue(book);
    app = await buildTestApp();
  });

  it('并发提交完全相同内容：输掉唯一索引竞争的一方也返回已有记录，重试结果一致且只留一条痕迹', async () => {
    const winner = winnerRow('伏笔回收');
    // 两个请求的事前检查都看到“没有记录”，随后本请求在唯一索引上落败。
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(null).mockResolvedValue(winner);
    prismaMock.tx.dogEar.create.mockRejectedValue(uniqueViolation());

    const first = await postDogEar(app, { pageNumber: 42, reason: '伏笔回收' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ idempotent: true, dogEar: { id: WINNER_ID, pageNumber: 42 } });

    // 落败事务整体回滚：没有写入第二条折角，也没有写入第二条时间线事件。
    expect(prismaMock.tx.activityEvent.create).not.toHaveBeenCalled();

    // 重试（此时事前检查直接命中已有记录）返回同一条记录。
    const retry = await postDogEar(app, { pageNumber: 42, reason: '伏笔回收' });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ idempotent: true, dogEar: { id: WINNER_ID } });
    expect(prismaMock.tx.dogEar.create).toHaveBeenCalledTimes(1);
  });

  it('并发提交不同内容：仍然拒绝并返回 409', async () => {
    prismaMock.dogEar.findFirst.mockResolvedValueOnce(null).mockResolvedValue(winnerRow('完全不同的理由'));
    prismaMock.tx.dogEar.create.mockRejectedValue(uniqueViolation());

    const response = await postDogEar(app, { pageNumber: 42, reason: '伏笔回收' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DOG_EAR_EXISTS');
  });

  it('无并发时相同内容命中已有记录：返回 200 幂等成功', async () => {
    prismaMock.dogEar.findFirst.mockResolvedValue(winnerRow(null));

    const response = await postDogEar(app, { pageNumber: 42, reason: null });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ idempotent: true, dogEar: { id: WINNER_ID } });
    expect(prismaMock.tx.dogEar.create).not.toHaveBeenCalled();
  });

  it('无并发时不同内容命中已有记录：返回 409', async () => {
    prismaMock.dogEar.findFirst.mockResolvedValue(winnerRow('已有理由'));

    const response = await postDogEar(app, { pageNumber: 42, reason: '新理由' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DOG_EAR_EXISTS');
  });

  it('无竞争时正常创建：201，同事务写入一条折角和一条时间线事件', async () => {
    prismaMock.dogEar.findFirst.mockResolvedValue(null);
    const created = winnerRow('伏笔回收');
    prismaMock.tx.dogEar.create.mockResolvedValue(created);

    const response = await postDogEar(app, { pageNumber: 42, reason: '伏笔回收' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ dogEar: { id: WINNER_ID } });
    expect(prismaMock.tx.activityEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.tx.activityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entityType: 'DOG_EAR', entityId: WINNER_ID, action: 'CREATED' })
      })
    );
  });
});
